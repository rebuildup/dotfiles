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
 * - an event counts only when `stopReason === "error"`, `errorStatus` is an
 *   integer in [400, 599], the event `provider` equals the route provider's
 *   `omp_id`, the session `cwd` matches the task cwd, and the event
 *   timestamp is at/after the execution start (`sinceMs`);
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
): ErrorEvent | null {
  let text: string;
  try {
    if (statSync(path).size > MAX_SESSION_FILE_BYTES) return null;
    text = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  const wantCwd = canonicalPath(cwd);
  let sessionCwd: string | null = null;
  let best: ErrorEvent | null = null;
  for (const line of text.split("\n")) {
    // Cheap pre-filter: only session headers and error turn events matter.
    if (!line.includes('"type":"session"') && !line.includes('"stopReason":"error"')) {
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
    if (event["type"] !== "message_end" && event["type"] !== "turn_end" && event["type"] !== "agent_end") {
      continue;
    }
    const message = event["message"];
    if (typeof message !== "object" || message === null) continue;
    const msg = message as Record<string, unknown>;
    if (msg["stopReason"] !== "error") continue;
    const status = msg["errorStatus"];
    if (typeof status !== "number" || !Number.isInteger(status) || status < 400 || status > 599) {
      continue;
    }
    if (msg["provider"] !== provider.omp_id) continue;
    const ts = typeof msg["timestamp"] === "number" ? msg["timestamp"] : null;
    if (ts === null || ts < sinceMs) continue;
    if (best === null || ts > best.ts) best = { ts, httpStatus: status };
  }
  if (best === null || sessionCwd === null) return null;
  if (canonicalPath(sessionCwd) !== wantCwd) return null;
  return best;
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
  /** Test hook: override the sessions root (defaults to the provider's OMP agent dir). */
  sessionsRoot?: string;
}): FailureSignal | null {
  const root = opts.sessionsRoot ?? ompSessionsRoot(opts.provider);
  let best: ErrorEvent | null = null;
  for (const file of sessionFilesSince(root, opts.sinceMs)) {
    const hit = scanSessionFile(file, opts.cwd, opts.provider, opts.sinceMs);
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
