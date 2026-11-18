/**
 * Provider failure evidence extraction (issue #173).
 *
 * Herdr lifecycle state (`blocked`, `stalled`, wait timeouts) is agent-state
 * evidence only — it says nothing about the provider's HTTP response, so the
 * task path must never fabricate a status from it. OMP, however, persists
 * structured turn outcomes to its session JSONL files: every `message_end` /
 * `turn_end` / `agent_end` event carries `stopReason` and, on provider
 * failure, the REAL `errorStatus` returned by the API plus the `provider`
 * and `model` it belonged to. Those files are written whether OMP runs in
 * the TUI or `--mode json`, so the Herdr worker path can recover genuine
 * provider evidence without changing worker argv or the interactive
 * launcher's contract.
 *
 * Evidence discipline:
 * - an event counts only when it is the LAST assistant outcome of a session
 *   whose `stopReason === "error"` carries an integer `errorStatus` in
 *   [400, 599]; the event `provider` must equal the route provider's
 *   `omp_id`, the session `cwd` must match the task cwd, the session must
 *   contain the exact prompt sent (`prompt` — this is what separates
 *   concurrent workers' sessions), and the outcome timestamp must be at or
 *   after the execution start (`sinceMs`);
 * - an error followed by a later successful outcome is a recovered retry,
 *   not a failure — only the final outcome decides;
 * - anything else yields null, and the caller keeps the lifecycle-derived
 *   `unknown` classification — never a guessed 401/402/403/429/5xx.
 */

import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Provider } from "./config.ts";
import type { FailureSignal } from "./limits.ts";
import { ompCustomAgentDir, ompNeedsManagedProfile } from "./omp.ts";

const MAX_SESSION_FILE_BYTES = 16 * 1024 * 1024;
const MAX_CANDIDATE_FILES = 20;
/** File mtime may lag the execution start only by clock skew / FS granularity. */
const FILE_MTIME_SKEW_MS = 5 * 60 * 1000;

interface ErrorEvent {
  ts: number;
  httpStatus: number;
}

interface AssistantOutcome {
  ts: number;
  errorStatus: number | null;
}

/** Normalize for prompt attribution: whitespace-insensitive exact match. */
function normalizePrompt(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Extract text content from an OMP message content array. */
function messageText(content: unknown): string | null {
  if (!Array.isArray(content)) return null;
  const parts: string[] = [];
  for (const block of content) {
    if (typeof block === "object" && block !== null) {
      const b = block as Record<string, unknown>;
      if (b["type"] === "text" && typeof b["text"] === "string") parts.push(b["text"]);
    }
  }
  return parts.length ? parts.join("\n") : null;
}

/** Agent dir OMP uses for this provider's workers (managed profile or default). */
function ompSessionsRoot(provider: Provider): string {
  const agentDir = ompNeedsManagedProfile(provider)
    ? ompCustomAgentDir(provider.key)
    : join(homedir(), ".omp", "agent");
  return join(agentDir, "sessions");
}

function canonicalPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function sessionFilesSince(root: string, sinceMs: number): string[] {
  let dirs: string[];
  try {
    dirs = readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => join(root, e.name));
  } catch {
    return [];
  }
  const cutoff = sinceMs - FILE_MTIME_SKEW_MS;
  const files: { path: string; mtimeMs: number }[] = [];
  for (const dir of dirs) {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith(".jsonl")) continue;
      const path = join(dir, name);
      try {
        const st = statSync(path);
        if (st.mtimeMs >= cutoff) files.push({ path, mtimeMs: st.mtimeMs });
      } catch {
        // unreadable entries are skipped, never fatal
      }
    }
  }
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return files.slice(0, MAX_CANDIDATE_FILES).map((f) => f.path);
}

/**
 * Scan one session file for a provider-error event that belongs to this
 * task: session cwd match + provider id match + timestamp within the
 * execution window. Returns the newest qualifying errorStatus, or null.
 */
function scanSessionFile(
  path: string,
  cwd: string,
  provider: Provider,
  sinceMs: number,
  prompt: string,
): ErrorEvent | null {
  let text: string;
  try {
    if (statSync(path).size > MAX_SESSION_FILE_BYTES) return null;
    text = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  const wantCwd = canonicalPath(cwd);
  const wantPrompt = normalizePrompt(prompt);
  let sessionCwd: string | null = null;
  let promptSeen = false;
  // Every assistant outcome in the window, in order: the LAST one decides.
  // An error followed by a successful turn is a recovered retry, not a
  // task failure; an error as the final outcome is the provider's verdict.
  const outcomes: AssistantOutcome[] = [];
  for (const line of text.split("\n")) {
    if (
      !line.includes('"type":"session"')
      && !line.includes('"stopReason"')
      && !line.includes('"role":"user"')
    ) {
      continue;
    }
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (event["type"] === "session" && typeof event["cwd"] === "string") {
      sessionCwd = event["cwd"] as string;
      continue;
    }
    const message = event["message"];
    if (typeof message !== "object" || message === null) continue;
    const msg = message as Record<string, unknown>;
    const ts = typeof msg["timestamp"] === "number" ? msg["timestamp"] : null;
    if (ts === null || ts < sinceMs) continue;
    // Prompt attribution: this session must contain the exact prompt this
    // execution sent, so a concurrent worker's session can never donate
    // its error to this attempt.
    if (!promptSeen && msg["role"] === "user") {
      const body = messageText(msg["content"]);
      if (body !== null && normalizePrompt(body) === wantPrompt) promptSeen = true;
    }
    if (event["type"] !== "message_end" && event["type"] !== "turn_end" && event["type"] !== "agent_end") {
      continue;
    }
    if (msg["role"] !== "assistant") continue;
    if (msg["provider"] !== undefined && msg["provider"] !== provider.omp_id) continue;
    const stop = msg["stopReason"];
    if (stop !== "error" && stop !== "stop" && stop !== "end_turn" && stop !== "end") continue;
    const status = msg["errorStatus"];
    const errorStatus =
      typeof status === "number" && Number.isInteger(status) && status >= 400 && status <= 599
        ? status
        : null;
    outcomes.push({ ts, errorStatus: stop === "error" ? errorStatus : null });
  }
  if (sessionCwd === null || !promptSeen || outcomes.length === 0) return null;
  if (canonicalPath(sessionCwd) !== wantCwd) return null;
  const last = outcomes.reduce((a, b) => (b.ts > a.ts ? b : a));
  if (last.errorStatus === null) return null;
  return { ts: last.ts, httpStatus: last.errorStatus };
}

/**
 * Extract real provider HTTP failure evidence for a just-failed worker
 * prompt. Returns a FailureSignal carrying ONLY the observed httpStatus —
 * no fabricated exit code, failure kind, retry hint or quota claim — so
 * `classifyFailure` maps it to the honest category (auth/billing/rate-
 * limit/network/...) from the status alone.
 */
export function extractProviderFailureEvidence(opts: {
  provider: Provider;
  cwd: string;
  /** Epoch ms at which the current execution (dispatch or resume) began. */
  sinceMs: number;
  /** The exact prompt sent to the worker — required for session attribution. */
  prompt: string;
  /** Test hook: override the sessions root (defaults to the provider's OMP agent dir). */
  sessionsRoot?: string;
}): FailureSignal | null {
  const root = opts.sessionsRoot ?? ompSessionsRoot(opts.provider);
  let best: ErrorEvent | null = null;
  for (const file of sessionFilesSince(root, opts.sinceMs)) {
    const hit = scanSessionFile(file, opts.cwd, opts.provider, opts.sinceMs, opts.prompt);
    if (hit !== null && (best === null || hit.ts > best.ts)) best = hit;
  }
  if (best === null) return null;
  return {
    httpStatus: best.httpStatus,
    exitCode: null,
    failureKind: null,
    retryAfterMs: null,
    resetAt: null,
    usage: [],
    errorKind: null,
  };
}
