#!/usr/bin/env bun
/**
 * Antigravity (`agy`) visual review harness (dotfiles#219, ADR-0022).
 *
 * Single-shot contract shared by the local executor and the Herdr executor:
 * images + a review spec are copied into an isolated workdir, `agy -p` runs
 * once with the session-scoped read-only settings payload, and the result is
 * classified from multiple independent signals — never from the CLI's overall
 * `status` alone (agy reports SUCCESS even when forbidden operations were
 * attempted and denied).
 *
 * Isolation layers, outermost first:
 *   1. Input isolation: the model only ever sees copies inside the review
 *      workdir; the reviewed repository is never the working directory.
 *   2. Permission layer: `--settings` deny rules block write_file/command/
 *      url/mcp/unsandboxed inside the agent runtime.
 *   3. OS layer: on macOS the child runs under `sandbox-exec` (Seatbelt)
 *      denying file-write* outside an explicit allowlist (workdir + agy state
 *      dirs). Other platforms record `osSandbox: "unsupported"` and rely on
 *      layers 1/2/4 — callers must treat that as reduced assurance.
 *   4. Post-run verification: denied_actions, permission-error markers in the
 *      response, protected-path snapshot diff, and JSON-schema validation of
 *      the structured verdict.
 */

import { createHash, randomUUID } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ContractError, agentStateDir, isPlainObject } from "./contract.ts";
import { AgentError, EXIT_RUNTIME, EXIT_USAGE } from "./errors.ts";
import { which } from "./util.ts";

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------

export const AGY_REVIEW_VERSION = "1.0.0";

/** Session-scoped deny rules; identical to home/.config/agy/review.settings.json. */
export const REVIEW_DENY_RULES = [
  "write_file(*)",
  "command(*)",
  "read_url(*)",
  "execute_url(*)",
  "mcp(*)",
  "unsandboxed(*)",
] as const;

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg"]);
const MAX_SPEC_BYTES = 256 * 1024;
const MAX_IMAGES = 32;
const MAX_IMAGE_BYTES = 32 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 300_000;
const QUOTA_TIMEOUT_MS = 30_000;

export type ReviewClassification =
  | "review-completed"
  | "agy-error"
  | "auth-required"
  | "timeout"
  | "invalid-output"
  | "readonly-violation"
  | "executor-error"
  | "quota-exhausted"
  | "deferred";

export interface AgyReviewResult {
  version: string;
  id: string;
  /** Model id passed via --model, or null when agy picked the default. */
  model: string | null;
  /** Effective model id reported by agy, or null when the CLI does not
   *  expose it (agy 1.5.14). Never guessed. */
  resolvedModel: string | null;
  /** SHA-256 of the review spec text — the criteria version actually used. */
  specSha256: string;
  classification: ReviewClassification;
  /** True only when every verification layer passed and a valid verdict exists. */
  verified: boolean;
  verdict: unknown;
  agy: {
    status: string | null;
    conversationId: string | null;
    durationSeconds: number | null;
    numTurns: number | null;
    usage: unknown;
    deniedActions: string[];
  } | null;
  readonly: {
    deniedActions: string[];
    permissionErrors: number;
    protectedPath: string | null;
    protectedCheck: "clean" | "mutated" | "not-git" | "unavailable";
    protectedMutations: string[];
  };
  isolation: {
    workdir: string;
    osSandbox: "seatbelt" | "unsupported" | "disabled";
    permissionDeny: string[];
  };
  quota: unknown;
  executor: "local" | "herdr";
  reasons: string[];
}

export interface AgyReviewOptions {
  images: string[];
  spec: string;
  specFile?: string;
  schema?: unknown;
  schemaFile?: string;
  model?: string;
  outDir?: string;
  /** Repository/workspace the review must not mutate (git snapshot checked). */
  protect?: string;
  executor?: "local" | "herdr";
  timeoutMs?: number;
  /** Skip the post-run `/quota` probe. */
  skipQuota?: boolean;
  /** Test hook: override the agy binary. */
  agyBin?: string;
  /** Test hook: run without Seatbelt even on macOS. */
  noOsSandbox?: boolean;
  /** Exact result file path (default: <outDir>/agy-review-<id>.json). */
  resultFile?: string;
  /** Result id override (Herdr run-file reuses the dispatch id for correlation). */
  id?: string;
  /**
   * Pre-flight quota gate (#221): fetch `/quota` before the model call and
   * refuse with `quota-exhausted` when the minimum remaining fraction across
   * the buckets relevant to `model` (all buckets when unset) is below this
   * threshold (0..1). Conservative: any nearly-empty shared window defers
   * the run; unrecognized model/group names never narrow the gate.
   */
  minRemaining?: number;
  /**
   * Single-flight lock (#221): serialize reviews through a state-dir
   * lockfile so concurrent runs cannot consume the same quota window at
   * once. Default on; a fresh lock yields `deferred`. The holder refreshes
   * the lock mtime while alive, so a lock stale for >30min means the holder
   * is gone and is reclaimed. `--no-exclusive` opts out.
   */
  exclusive?: boolean;
}

// ---------------------------------------------------------------------------
// Input validation / assembly
// ---------------------------------------------------------------------------

export function sanitizeImageName(index: number, path: string): string {
  const base = basename(path);
  const ext = extname(base).toLowerCase();
  const stem = base.slice(0, base.length - ext.length).replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 80) || "image";
  return `${String(index).padStart(2, "0")}-${stem}${ext}`;
}

export function validateReviewInputs(opts: AgyReviewOptions): { spec: string; schema: unknown } {
  if (opts.images.length === 0) {
    throw new AgentError("review requires at least one --image", EXIT_USAGE);
  }
  if (opts.images.length > MAX_IMAGES) {
    throw new AgentError(`too many images (max ${MAX_IMAGES})`, EXIT_USAGE);
  }
  for (const image of opts.images) {
    if (!isAbsoluteSafe(image)) {
      throw new AgentError(`image path must be absolute: ${image}`, EXIT_USAGE);
    }
    const ext = extname(image).toLowerCase();
    if (!IMAGE_EXTENSIONS.has(ext)) {
      throw new AgentError(`unsupported image type '${ext}': ${image}`, EXIT_USAGE);
    }
    if (!existsSync(image) || !statSync(image).isFile()) {
      throw new AgentError(`image not found: ${image}`, EXIT_USAGE);
    }
    if (statSync(image).size > MAX_IMAGE_BYTES) {
      throw new AgentError(`image too large (> ${MAX_IMAGE_BYTES} bytes): ${image}`, EXIT_USAGE);
    }
  }
  let spec = opts.spec;
  if (opts.specFile) {
    if (!isAbsoluteSafe(opts.specFile)) {
      throw new AgentError(`spec file must be an absolute path: ${opts.specFile}`, EXIT_USAGE);
    }
    spec = readFileSync(opts.specFile, "utf8");
  }
  if (typeof spec !== "string" || spec.trim() === "") {
    throw new AgentError("review requires a non-empty --spec or --spec-file", EXIT_USAGE);
  }
  if (Buffer.byteLength(spec, "utf8") > MAX_SPEC_BYTES) {
    throw new AgentError(`spec too large (max ${MAX_SPEC_BYTES} bytes)`, EXIT_USAGE);
  }
  let schema: unknown = opts.schema ?? DEFAULT_REVIEW_SCHEMA;
  if (opts.schemaFile) {
    if (!isAbsoluteSafe(opts.schemaFile)) {
      throw new AgentError(`schema file must be an absolute path: ${opts.schemaFile}`, EXIT_USAGE);
    }
    schema = JSON.parse(readFileSync(opts.schemaFile, "utf8"));
  }
  if (!isPlainObject(schema)) {
    throw new AgentError("review schema must be a JSON object", EXIT_USAGE);
  }
  return { spec, schema };
}

function isAbsoluteSafe(path: string): boolean {
  return path.startsWith("/") && !path.split("/").includes("..");
}

/** Default structured verdict; callers may override via --schema/--schema-file. */
export const DEFAULT_REVIEW_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["verdict", "summary", "findings"],
  properties: {
    verdict: { type: "string", enum: ["approve", "request-changes", "reject"] },
    summary: { type: "string" },
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["severity", "description"],
        properties: {
          severity: { type: "string", enum: ["info", "minor", "major", "critical"] },
          description: { type: "string" },
        },
      },
    },
  },
} as const;

export function buildReviewPrompt(spec: string, imagePaths: string[]): string {
  const lines = [
    "You are a read-only visual reviewer. The attached images are the review inputs.",
    "You must not modify files, run commands, or access the network.",
    "Review the images against the specification below and respond with ONLY a JSON",
    "object conforming to the provided schema — no prose, no markdown fences.",
    "",
    "## Specification",
    spec.trim(),
    "",
    "## Images",
    ...imagePaths.map((p) => `- ${p}`),
  ];
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Seatbelt (macOS) write isolation
// ---------------------------------------------------------------------------

/**
 * Seatbelt profile: default-allow, deny file-write* except under the review
 * workdir and the CLI's own state/cache dirs. `deny` with `require-not`
 * carves out the allowlist — plain `(allow ...)` after `(deny ...)` does not
 * override in SBPL.
 */
export function buildSeatbeltProfile(workdir: string, home: string): string {
  const allowed = [
    workdir,
    join(home, ".gemini"),
    join(home, ".cache"),
    join(home, "Library/Application Support/antigravity"),
    "/private/tmp",
    "/tmp",
    "/dev",
  ];
  const subs = allowed.map((p) => `      (subpath "${p.replace(/"/g, '\\"')}")`).join("\n");
  return `(version 1)\n(allow default)\n(deny file-write*\n  (require-not\n    (require-any\n${subs}\n    )\n  )\n)\n`;
}

// ---------------------------------------------------------------------------
// agy process boundary
// ---------------------------------------------------------------------------

function agyBin(override?: string): string {
  const bin = override ?? process.env["AGY_CLI"]?.trim() ?? "agy";
  // An explicit path (tests, wrappers) is used as-is; a bare name resolves via PATH.
  if (bin.includes("/")) {
    if (!existsSync(bin)) {
      throw new AgentError(`agy not found: ${bin}`, EXIT_RUNTIME);
    }
    return bin;
  }
  const resolved = which(bin);
  if (!resolved) {
    throw new AgentError(`agy not found: ${bin} (install via pc-setup/mise)`, EXIT_RUNTIME);
  }
  return resolved;
}

export function reviewSettingsJson(): string {
  // Prefer the dotfiles-managed payload; fall back to the identical inline
  // rules so the harness still fails closed on machines where the link is
  // not yet applied. `agy --settings` rejects unknown top-level keys, so the
  // editor-only `$schema` hint is stripped before the payload is passed.
  const managed = join(process.env["HOME"] ?? "", ".config/agy/review.settings.json");
  if (existsSync(managed)) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(managed, "utf8"));
      if (isPlainObject(parsed)) {
        const { "$schema": _schema, ...rest } = parsed;
        return JSON.stringify(rest);
      }
    } catch {
      // Unparseable managed file — fall through to the inline payload.
    }
  }
  return JSON.stringify({ permissions: { deny: [...REVIEW_DENY_RULES] } });
}

/** Env for the agy child: ambient env minus API-key credential variables. */
export function reviewEnv(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  const blocked = new Set([
    "GEMINI_API_KEY",
    "GOOGLE_API_KEY",
    "GOOGLE_APPLICATION_CREDENTIALS",
    "AGY_API_KEY",
    "ANTIGRAVITY_API_KEY",
  ]);
  for (const [k, v] of Object.entries(source)) {
    if (v !== undefined && !blocked.has(k)) env[k] = v;
  }
  return env;
}

interface AgyRun {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

async function spawnAgy(
  args: string[],
  cwd: string,
  timeoutMs: number,
  seatbeltProfile: string | null,
  agyOverride?: string
): Promise<AgyRun> {
  const bin = agyBin(agyOverride);
  const argv = seatbeltProfile
    ? ["/usr/bin/sandbox-exec", "-f", seatbeltProfile, bin, ...args]
    : [bin, ...args];
  const proc = await Bun.spawn(argv, {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    // Subscription auth only (issue #219): strip API-key credential env so an
    // ambient GEMINI_API_KEY/GOOGLE_API_KEY cannot silently switch billing to
    // the metered API path. The Google OAuth keyring login is unaffected.
    env: reviewEnv(),
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill("SIGKILL");
  }, timeoutMs);
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { code, stdout, stderr, timedOut };
  } finally {
    clearTimeout(timer);
  }
}

/** Parse the `agy -p --output-format json` envelope into unknown-checked fields. */
export function parseAgyEnvelope(stdout: string): {
  status: string | null;
  response: string | null;
  conversationId: string | null;
  durationSeconds: number | null;
  numTurns: number | null;
  usage: unknown;
  deniedActions: string[];
  resolvedModel: string | null;
} | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (!isPlainObject(parsed)) return null;
  const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
  const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const denied = parsed["denied_actions"];
  return {
    status: str(parsed["status"]),
    response: str(parsed["response"]),
    conversationId: str(parsed["conversation_id"]),
    durationSeconds: num(parsed["duration_seconds"]),
    numTurns: num(parsed["num_turns"]),
    usage: parsed["usage"] ?? null,
    deniedActions: Array.isArray(denied) ? denied.filter((d): d is string => typeof d === "string") : [],
    // Effective model id if the CLI ever reports one; agy 1.5.14 does not,
    // so this stays null rather than guessing. Check likely key names.
    resolvedModel: ["resolved_model", "resolvedModel", "model_id", "modelId", "model"]
      .map((k) => str(parsed[k]))
      .find((v): v is string => v !== null) ?? null,
  };
}

const PERMISSION_ERROR_RE = /permission check failed|permission denied|matches user-configured deny rule/i;

export function countPermissionErrors(text: string | null): number {
  if (!text) return 0;
  return (text.match(new RegExp(PERMISSION_ERROR_RE.source, "gi")) ?? []).length;
}

// ---------------------------------------------------------------------------
// Protected-path verification
// ---------------------------------------------------------------------------

function gitStatusSnapshot(dir: string): string | null {
  try {
    const proc = Bun.spawnSync(["git", "-C", dir, "status", "--porcelain"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    if (proc.exitCode !== 0) return null;
    return proc.stdout.toString();
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Quota probe (`agy -p "/quota"`)
// ---------------------------------------------------------------------------

export interface AgyQuotaBucket {
  /** Group the bucket belongs to (e.g. "Gemini Models"). */
  group: string | null;
  /** Bucket label as reported (e.g. "Weekly Limit Remaining"). */
  label: string | null;
  id: string | null;
  name: string | null;
  window: string | null;
  remainingFraction: number | null;
  resetTime: string | null;
}

const RESET_TIME_RE = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;

/**
 * `/quota` answers as TSV on current builds:
 *   <group>\t<bucket label>\t<remaining %>\t<reset ISO time>
 * A JSON `{groups:[{buckets:[...]}]}` payload is also accepted for forward
 * compatibility. Anything else returns null (recorded as an error upstream).
 */
export function parseAgyQuota(stdout: string): { buckets: AgyQuotaBucket[]; raw: unknown } | null {
  const envelope = parseAgyEnvelope(stdout);
  if (!envelope?.response) return null;
  const response = envelope.response;

  // TSV path (observed agy 1.5.14).
  const lines = response.split("\n").map((l) => l.trim()).filter((l) => l !== "");
  const tsv: AgyQuotaBucket[] = [];
  for (const line of lines) {
    const cols = line.split("\t").map((c) => c.trim());
    if (cols.length < 3) continue;
    const pctCol = cols.find((c) => /^\d+(\.\d+)?%$/.test(c));
    const resetCol = cols.find((c) => RESET_TIME_RE.test(c));
    if (!pctCol) continue;
    const pct = parseFloat(pctCol);
    const group = cols[0] ?? null;
    const label = cols.slice(1).find((c) => c !== pctCol && c !== resetCol) ?? null;
    tsv.push({
      group: group || null,
      label,
      id: null,
      name: null,
      window: null,
      remainingFraction: Number.isFinite(pct) ? pct / 100 : null,
      resetTime: resetCol ?? null,
    });
  }
  if (tsv.length > 0) return { buckets: tsv, raw: response };

  // JSON path.
  const candidates = [response];
  const fence = response.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) candidates.push(fence[1].trim());
  for (const text of candidates) {
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      continue;
    }
    const groups = isPlainObject(data) && Array.isArray(data["groups"]) ? data["groups"] : null;
    if (!groups) continue;
    const buckets: AgyQuotaBucket[] = [];
    for (const group of groups) {
      if (!isPlainObject(group) || !Array.isArray(group["buckets"])) continue;
      const gname = typeof group["name"] === "string" ? group["name"] : null;
      for (const bucket of group["buckets"]) {
        if (!isPlainObject(bucket)) continue;
        const frac = bucket["remaining_fraction"];
        buckets.push({
          group: gname,
          label: typeof bucket["name"] === "string" ? bucket["name"] : null,
          id: typeof bucket["id"] === "string" ? bucket["id"] : null,
          name: typeof bucket["name"] === "string" ? bucket["name"] : null,
          window: typeof bucket["window"] === "string" ? bucket["window"] : null,
          remainingFraction: typeof frac === "number" && Number.isFinite(frac) ? frac : null,
          resetTime: typeof bucket["reset_time"] === "string" ? bucket["reset_time"] : null,
        });
      }
    }
    return { buckets, raw: data };
  }
  return null;
}

export async function fetchAgyQuota(timeoutMs = QUOTA_TIMEOUT_MS, agyOverride?: string): Promise<unknown> {
  try {
    const run = await spawnAgy(["-p", "/quota", "--output-format", "json", "--print-timeout", "20s"], process.cwd(), timeoutMs, null, agyOverride);
    if (run.timedOut || run.code !== 0) {
      return { error: run.timedOut ? "quota probe timed out" : `agy exited ${run.code}` };
    }
    const parsed = parseAgyQuota(run.stdout);
    return parsed ?? { error: "unrecognized quota response", stderr: run.stderr.slice(0, 500) };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Buckets plausibly drawn on by `model`. Exclusion-based on purpose: a
 * bucket is dropped only when its group/label names a *different* known
 * quota family, so an unrecognized model id or group name never narrows
 * the gate (fail-closed). No model → all buckets.
 */
function quotaBucketsForModel(buckets: AgyQuotaBucket[], model: string | undefined): AgyQuotaBucket[] {
  if (!model) return buckets;
  const m = model.toLowerCase();
  const gemini = /gemini|argon/.test(m);
  const claudeGpt = /claude|gpt|openai|^o\d/.test(m);
  if (gemini === claudeGpt) return buckets; // unknown or ambiguous family
  return buckets.filter((b) => {
    const text = `${b.group ?? ""} ${b.label ?? ""} ${b.name ?? ""}`.toLowerCase();
    return gemini ? !/claude|gpt/.test(text) : !/gemini|argon/.test(text);
  });
}

/**
 * Minimum remainingFraction across the quota buckets relevant to `model`
 * (all buckets when no model is given); null when unknown.
 */
export function minQuotaFraction(quota: unknown, model?: string): number | null {
  if (!isPlainObject(quota) || !Array.isArray(quota["buckets"])) return null;
  const buckets = (quota["buckets"] as unknown[]).filter(isPlainObject) as unknown as AgyQuotaBucket[];
  const scoped = quotaBucketsForModel(buckets, model);
  const fracs = scoped
    .map((b) => b.remainingFraction)
    .filter((f): f is number => typeof f === "number" && Number.isFinite(f));
  return fracs.length > 0 ? Math.min(...fracs) : null;
}

// ---------------------------------------------------------------------------
// Single-flight lock (#221): one review at a time per state dir
// ---------------------------------------------------------------------------

const REVIEW_LOCK_NAME = ".single-flight.lock";
const REVIEW_LOCK_STALE_MS = 30 * 60 * 1000;
const REVIEW_LOCK_HEARTBEAT_MS = 60 * 1000;

function reviewLockPath(): string {
  return join(agentStateDir(), "agy-review", REVIEW_LOCK_NAME);
}

/**
 * O_EXCL lockfile. Returns the lock path on success, null when a fresh lock
 * is held. The holder keeps the mtime fresh via heartbeat, so a lock whose
 * mtime is older than REVIEW_LOCK_STALE_MS is treated as abandoned (dead or
 * hung holder) and reclaimed once — a live run of any length keeps it fresh.
 */
export function acquireReviewLock(id: string): string | null {
  const path = reviewLockPath();
  mkdirSync(dirname(path), { recursive: true });
  const payload = JSON.stringify({ id, pid: process.pid, startedAt: Date.now() });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(path, payload, { flag: "wx" });
      return path;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let stale = false;
      try {
        stale = Date.now() - statSync(path).mtimeMs > REVIEW_LOCK_STALE_MS;
      } catch {
        stale = true; // vanished between EEXIST and stat — retry the create
      }
      if (!stale) return null;
      try {
        unlinkSync(path);
      } catch {
        return null;
      }
    }
  }
  return null;
}

/** Release only when the lock still belongs to this run. */
export function releaseReviewLock(path: string, id: string): void {
  try {
    const holder = JSON.parse(readFileSync(path, "utf8")) as { id?: string };
    if (holder.id === id) unlinkSync(path);
  } catch {
    // Lock already gone or unreadable — nothing to release.
  }
}

/**
 * Extract every complete top-level `{...}` JSON value from `text`, in
 * order. Tolerates prose/fences/duplicated objects around the payload;
 * unparseable candidates are skipped.
 */
export function extractJsonValues(text: string): unknown[] {
  const values: unknown[] = [];
  let i = 0;
  while (i < text.length) {
    const start = text.indexOf("{", i);
    if (start === -1) break;
    let depth = 0;
    let inStr = false;
    let esc = false;
    let end = -1;
    for (let j = start; j < text.length; j++) {
      const c = text[j];
      if (inStr) {
        if (esc) esc = false;
        else if (c === "\\") esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') inStr = true;
      else if (c === "{") depth++;
      else if (c === "}") {
        depth--;
        if (depth === 0) {
          end = j;
          break;
        }
      }
    }
    if (end === -1) break;
    try {
      values.push(JSON.parse(text.slice(start, end + 1)));
    } catch {
      // Not a complete JSON object — skip past it.
    }
    i = end + 1;
  }
  return values;
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

function prepareWorkdir(id: string): string {
  const dir = join(agentStateDir(), "agy-review", id);
  mkdirSync(join(dir, "inputs"), { recursive: true });
  return dir;
}

function emptyReadonly(protectedPath: string | null): AgyReviewResult["readonly"] {
  return {
    deniedActions: [],
    permissionErrors: 0,
    protectedPath,
    protectedCheck: "unavailable",
    protectedMutations: [],
  };
}

interface ReviewMeta {
  model: string | null;
  specSha256: string;
}

function reviewMeta(opts: AgyReviewOptions, spec: string): ReviewMeta {
  return {
    model: opts.model ?? null,
    specSha256: createHash("sha256").update(spec, "utf8").digest("hex"),
  };
}

function baseResult(id: string, workdir: string, osSandbox: AgyReviewResult["isolation"]["osSandbox"], executor: "local" | "herdr", protectedPath: string | null, meta: ReviewMeta): AgyReviewResult {
  return {
    version: AGY_REVIEW_VERSION,
    id,
    model: meta.model,
    resolvedModel: null,
    specSha256: meta.specSha256,
    classification: "executor-error",
    verified: false,
    verdict: null,
    agy: null,
    readonly: emptyReadonly(protectedPath),
    isolation: { workdir, osSandbox, permissionDeny: [...REVIEW_DENY_RULES] },
    quota: null,
    executor,
    reasons: [],
  };
}

function classify(
  result: AgyReviewResult,
  envelope: ReturnType<typeof parseAgyEnvelope>,
  run: AgyRun,
  schemaValid: boolean
): void {
  const reasons = result.reasons;
  if (run.timedOut) {
    result.classification = "timeout";
    reasons.push("agy exceeded the harness timeout and was killed");
    return;
  }
  if (run.code !== 0) {
    result.classification = "agy-error";
    reasons.push(`agy exited ${run.code}: ${run.stderr.slice(0, 300)}`);
    const auth = /sign in|oauth|unauthorized|401|403/i.test(run.stderr + run.stdout);
    if (auth) {
      result.classification = "auth-required";
      reasons.push("authentication required or rejected");
    }
    return;
  }
  if (!envelope) {
    result.classification = "invalid-output";
    reasons.push("agy stdout was not a JSON envelope");
    return;
  }
  const status = (envelope.status ?? "").toUpperCase();
  if (status !== "SUCCESS") {
    result.classification = "agy-error";
    reasons.push(`agy status ${envelope.status ?? "missing"}`);
    return;
  }
  if (!schemaValid || result.verdict === null) {
    result.classification = "invalid-output";
    reasons.push("response did not contain a schema-valid verdict");
    return;
  }
  // Any denied action is an attempt at a forbidden operation — for a
  // read-only review that is a violation, not a successful run.
  if (
    result.readonly.protectedCheck === "mutated" ||
    result.readonly.permissionErrors > 0 ||
    result.readonly.deniedActions.length > 0
  ) {
    result.classification = "readonly-violation";
    if (result.readonly.protectedCheck === "mutated") reasons.push("protected path changed during review");
    if (result.readonly.permissionErrors > 0) reasons.push(`${result.readonly.permissionErrors} permission-denied action(s) observed`);
    if (result.readonly.deniedActions.length > 0) reasons.push(`denied actions: ${result.readonly.deniedActions.join(", ")}`);
    return;
  }
  result.classification = "review-completed";
  result.verified = result.readonly.protectedCheck !== "unavailable";
  if (result.readonly.protectedCheck === "unavailable") {
    reasons.push("no protected path supplied; OS/permission layers only");
  }
}

/**
 * Run one review. When `executor === "herdr"`, this function only prepares the
 * workdir and re-execs the same `agent review run --executor local` command
 * inside a Herdr pane — the review contract (schema, isolation, verification)
 * is identical because it is literally the same code path.
 */
function osSandboxMode(opts: AgyReviewOptions): AgyReviewResult["isolation"]["osSandbox"] {
  if (process.platform === "darwin") return opts.noOsSandbox ? "disabled" : "seatbelt";
  return "unsupported";
}

export async function runAgyReview(opts: AgyReviewOptions): Promise<AgyReviewResult> {
  // ids land in a filesystem path; only well-formed tokens are honored.
  const id = opts.id && /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/.test(opts.id) ? opts.id : randomUUID();
  const executor = opts.executor ?? "local";
  const { spec, schema } = validateReviewInputs(opts);
  const protectPath = opts.protect ? resolve(opts.protect) : null;

  // #221 pre-flight controls wrap BOTH executors: the quota gate and the
  // single-flight lock live here so `local` and `herdr` share them. The
  // Herdr inner run-file skips both (the outer dispatch already holds them).
  const exclusive = opts.exclusive !== false;
  let lockPath: string | null = null;
  let lockBeat: ReturnType<typeof setInterval> | null = null;
  if (exclusive) {
    lockPath = acquireReviewLock(id);
    if (lockPath === null) {
      const deferred = baseResult(id, prepareWorkdir(id), osSandboxMode(opts), executor, protectPath, reviewMeta(opts, spec));
      deferred.classification = "deferred";
      deferred.reasons.push("another review holds the single-flight lock; retry later");
      if (opts.outDir) {
        mkdirSync(opts.outDir, { recursive: true });
        writeFileSync(join(opts.outDir, `agy-review-${id}.json`), JSON.stringify(deferred, null, 2) + "\n");
      }
      return deferred;
    }
    // Keep the lock mtime fresh for the whole run: staleness then means the
    // holder is actually gone, so arbitrarily long --timeout values are safe.
    lockBeat = setInterval(() => {
      try {
        const now = new Date();
        utimesSync(lockPath as string, now, now);
      } catch {
        // Lock already released or removed — nothing to refresh.
      }
    }, REVIEW_LOCK_HEARTBEAT_MS);
    lockBeat.unref();
  }
  try {
    if (opts.minRemaining !== undefined) {
      const quota = await fetchAgyQuota(QUOTA_TIMEOUT_MS, opts.agyBin);
      const min = minQuotaFraction(quota, opts.model);
      if (min === null || min < opts.minRemaining) {
        const exhausted = baseResult(id, prepareWorkdir(id), osSandboxMode(opts), executor, protectPath, reviewMeta(opts, spec));
        exhausted.classification = "quota-exhausted";
        exhausted.quota = quota;
        exhausted.reasons.push(
          min === null
            ? "quota unavailable; gate fails closed"
            : `min remaining ${(min * 100).toFixed(1)}% below threshold ${(opts.minRemaining * 100).toFixed(1)}%`
        );
        if (opts.outDir) {
          mkdirSync(opts.outDir, { recursive: true });
          writeFileSync(join(opts.outDir, `agy-review-${id}.json`), JSON.stringify(exhausted, null, 2) + "\n");
        }
        return exhausted;
      }
    }
    if (executor === "herdr") {
      return await runViaHerdr(opts, id, spec, schema, protectPath);
    }
    return await runLocal(opts, id, spec, schema, protectPath);
  } finally {
    if (lockBeat !== null) clearInterval(lockBeat);
    if (lockPath !== null) releaseReviewLock(lockPath, id);
  }
}

async function runLocal(
  opts: AgyReviewOptions,
  id: string,
  spec: string,
  schema: unknown,
  protectPath: string | null
): Promise<AgyReviewResult> {
  const workdir = prepareWorkdir(id);
  const home = process.env["HOME"] ?? "";
  const useSeatbelt = process.platform === "darwin" && !opts.noOsSandbox;
  const osSandbox = osSandboxMode(opts);
  const result = baseResult(id, workdir, osSandbox, "local", protectPath, reviewMeta(opts, spec));

  // 1. Input isolation: copy images into the workdir; the prompt references
  //    only these copies.
  const imagePaths: string[] = [];
  opts.images.forEach((image, i) => {
    const name = sanitizeImageName(i, image);
    const dest = join(workdir, "inputs", name);
    copyFileSync(image, dest);
    imagePaths.push(dest);
  });
  writeFileSync(join(workdir, "spec.md"), spec);
  writeFileSync(join(workdir, "schema.json"), JSON.stringify(schema));

  // 2. Protected-path snapshot before the run.
  let beforeStatus: string | null = null;
  if (protectPath) {
    beforeStatus = gitStatusSnapshot(protectPath);
    if (beforeStatus === null) {
      result.readonly.protectedCheck = "not-git";
      result.reasons.push(`protected path is not a git worktree: ${protectPath}`);
    } else {
      result.readonly.protectedCheck = "unavailable"; // resolved after run
    }
  }

  // 3. Build and run agy once.
  const args = [
    "-p",
    buildReviewPrompt(spec, imagePaths),
    "--output-format", "json",
    "--json-schema", join(workdir, "schema.json"),
    "--settings", reviewSettingsJson(),
    "--print-timeout", `${Math.max(10, Math.floor((opts.timeoutMs ?? DEFAULT_TIMEOUT_MS) / 1000) - 5)}s`,
  ];
  if (opts.model) args.push("--model", opts.model);

  let seatbeltProfile: string | null = null;
  if (useSeatbelt) {
    seatbeltProfile = join(workdir, "review.sb");
    writeFileSync(seatbeltProfile, buildSeatbeltProfile(workdir, home));
  }

  let run: AgyRun;
  try {
    run = await spawnAgy(args, workdir, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS, seatbeltProfile, opts.agyBin);
  } catch (error) {
    result.classification = "executor-error";
    result.reasons.push(error instanceof Error ? error.message : String(error));
    return finishResult(result, opts);
  }
  writeFileSync(join(workdir, "agy.stdout.log"), run.stdout);
  writeFileSync(join(workdir, "agy.stderr.log"), run.stderr);

  // 4. Post-run verification.
  const envelope = parseAgyEnvelope(run.stdout);
  result.resolvedModel = envelope?.resolvedModel ?? null;
  result.agy = envelope
    ? {
        status: envelope.status,
        conversationId: envelope.conversationId,
        durationSeconds: envelope.durationSeconds,
        numTurns: envelope.numTurns,
        usage: envelope.usage,
        deniedActions: envelope.deniedActions,
      }
    : null;
  result.readonly.deniedActions = envelope?.deniedActions ?? [];
  result.readonly.permissionErrors = countPermissionErrors(envelope?.response ?? run.stderr);

  let verdict: unknown = null;
  let schemaValid = false;
  if (envelope?.response) {
    // Some models (observed: claude-sonnet via agy) emit the verdict object
    // more than once in one response. Take the LAST complete top-level JSON
    // value — earlier copies are drafts/duplicates — and keep failing closed
    // when nothing parses.
    const candidates = extractJsonValues(envelope.response);
    const parsed = candidates.length > 0 ? candidates[candidates.length - 1] : null;
    if (parsed !== null) {
      // Minimal schema check: required keys present with right primitive types.
      // The model-facing --json-schema enforces the full contract; this layer
      // guards against a harness/CLI drift producing plausible-but-wrong JSON.
      if (isPlainObject(schema) && Array.isArray((schema as Record<string, unknown>)["required"])) {
        const required = (schema as Record<string, unknown>)["required"] as string[];
        schemaValid = required.every((k) => k in (parsed as Record<string, unknown>));
      } else {
        schemaValid = true;
      }
      verdict = schemaValid ? parsed : null;
    }
  }
  result.verdict = verdict;

  if (protectPath && beforeStatus !== null) {
    const afterStatus = gitStatusSnapshot(protectPath);
    if (afterStatus !== null) {
      if (afterStatus === beforeStatus) {
        result.readonly.protectedCheck = "clean";
      } else {
        result.readonly.protectedCheck = "mutated";
        const before = new Set(beforeStatus.split("\n"));
        result.readonly.protectedMutations = afterStatus
          .split("\n")
          .filter((l) => l !== "" && !before.has(l))
          .slice(0, 50);
      }
    }
  }

  classify(result, envelope, run, schemaValid);
  return finishResult(result, opts);
}

async function finishResult(result: AgyReviewResult, opts: AgyReviewOptions): Promise<AgyReviewResult> {
  if (!opts.skipQuota) {
    result.quota = await fetchAgyQuota(QUOTA_TIMEOUT_MS, opts.agyBin);
  }
  if (opts.resultFile) {
    mkdirSync(join(opts.resultFile, ".."), { recursive: true });
    writeFileSync(opts.resultFile, JSON.stringify(result, null, 2) + "\n");
  } else if (opts.outDir) {
    mkdirSync(opts.outDir, { recursive: true });
    writeFileSync(join(opts.outDir, `agy-review-${result.id}.json`), JSON.stringify(result, null, 2) + "\n");
  }
  return result;
}

/**
 * `agent review run-file <workdir>` entry: re-enter the local review path from
 * a materialized request directory (used by the Herdr executor). The request
 * was written by runViaHerdr; images are already isolated copies.
 */
export async function runAgyReviewFile(workdir: string): Promise<AgyReviewResult> {
  const requestPath = join(workdir, "request.json");
  if (!existsSync(requestPath)) {
    throw new AgentError(`review request not found: ${requestPath}`, EXIT_USAGE);
  }
  const request = JSON.parse(readFileSync(requestPath, "utf8")) as {
    spec: string;
    schema: unknown;
    model: string | null;
    protect: string | null;
    imagePaths: string[];
    timeoutMs: number;
    skipQuota: boolean;
    id?: string;
  };
  if (!isPlainObject(request) || !Array.isArray(request.imagePaths) || typeof request.spec !== "string") {
    throw new AgentError(`malformed review request: ${requestPath}`, EXIT_USAGE);
  }
  return runAgyReview({
    images: request.imagePaths,
    spec: request.spec,
    schema: request.schema,
    model: request.model ?? undefined,
    protect: request.protect ?? undefined,
    timeoutMs: request.timeoutMs,
    skipQuota: request.skipQuota,
    executor: "local",
    resultFile: join(workdir, "result.json"),
    id: request.id,
    // The Herdr outer dispatch already ran the quota gate and holds the
    // single-flight lock for the whole wait — the inner run must not re-gate
    // or deadlock on its own lock attempt.
    exclusive: false,
  });
}

// ---------------------------------------------------------------------------
// Herdr executor: same contract, dispatched through existing Herdr primitives
// ---------------------------------------------------------------------------

async function runViaHerdr(
  opts: AgyReviewOptions,
  id: string,
  spec: string,
  schema: unknown,
  protectPath: string | null
): Promise<AgyReviewResult> {
  const workdir = prepareWorkdir(id);
  const result = baseResult(id, workdir, "unsupported", "herdr", protectPath, reviewMeta(opts, spec));

  // Materialize inputs so the pane command only needs flags, not big payloads.
  const imagePaths: string[] = [];
  opts.images.forEach((image, i) => {
    const name = sanitizeImageName(i, image);
    const dest = join(workdir, "inputs", name);
    copyFileSync(image, dest);
    imagePaths.push(dest);
  });
  writeFileSync(join(workdir, "spec.md"), spec);
  writeFileSync(join(workdir, "schema.json"), JSON.stringify(schema));
  writeFileSync(join(workdir, "request.json"), JSON.stringify({
    spec, schema, model: opts.model ?? null, protect: protectPath,
    imagePaths, timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS, skipQuota: opts.skipQuota ?? false,
    id,
  }));

  const outFile = join(workdir, "result.json");
  // `agent review run-file <workdir>` re-enters the local path with the
  // materialized request — Herdr adds only transport, never a second contract.
  // Repo root comes from this module's location (script/agent/), not cwd —
  // the launcher may be invoked from any directory. DOTFILES_REPO overrides
  // for tests/worktrees.
  const repoRoot = process.env["DOTFILES_REPO"] ?? join(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const innerArgv = [
    "bun", join(repoRoot, "script/agent.ts"), "review", "run-file", workdir,
  ];
  try {
    const { createWorkspace } = await import("./herdr.ts");
    // The pane inherits the Herdr server's env, not ours: pin AGY_CLI to the
    // binary this process resolved so the inner run-file uses the same agy
    // (e.g. the dotfiles shim) instead of whatever PATH the server has.
    const agyEnv = opts.agyBin ?? process.env["AGY_CLI"]?.trim() ?? which("agy") ?? "agy";
    const ws = await createWorkspace(workdir, `agy-review-${id.slice(0, 8)}`, {
      noFocus: true,
      env: { AGY_CLI: agyEnv },
    });
    result.isolation.workdir = workdir;
    const paneId = ws.tabs[0]?.panes[0]?.id;
    if (!paneId) throw new ContractError("state", "Herdr workspace has no root pane");
    const herdrBin = process.env["HERDR_CLI"]?.trim() || "herdr";
    const proc = Bun.spawn([herdrBin, "pane", "run", paneId, ...innerArgv], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const [runOut, runErr, runCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (runCode !== 0) {
      result.classification = "executor-error";
      result.reasons.push(`herdr pane run failed: ${(runErr || runOut).slice(0, 300)}`);
      return result;
    }
    // Wait for the inner local run to write result.json.
    const deadline = Date.now() + (opts.timeoutMs ?? DEFAULT_TIMEOUT_MS) + 30_000;
    while (Date.now() < deadline) {
      if (existsSync(outFile)) break;
      await new Promise((r) => setTimeout(r, 1_000));
    }
    if (!existsSync(outFile)) {
      result.classification = "timeout";
      result.reasons.push("herdr-dispatched review did not produce a result in time");
      return result;
    }
    const inner = JSON.parse(readFileSync(outFile, "utf8")) as AgyReviewResult;
    inner.executor = "herdr";
    return inner;
  } catch (error) {
    result.classification = "executor-error";
    result.reasons.push(error instanceof Error ? error.message : String(error));
    return result;
  }
}
