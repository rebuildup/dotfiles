#!/usr/bin/env bun
/**
 * Limit / billing / network failure classification and the safe retry policy
 * (issue #92, Epic #86 T006).
 *
 * Classifies provider failures from structured evidence ONLY — an observed
 * HTTP response (via `quota.ts`), the probe module's failure vocabulary, a
 * process exit code under the documented mirror convention, or an exact
 * provider error code — into: rate-limit, quota-exhausted, concurrency,
 * billing, auth, network, context, model-invalid, unknown. Message text is
 * never scraped; an unrecognizable signal is `unknown` and fails closed.
 *
 * Retry policy invariants (hard):
 *   - A quota/auth/payment failure (401/402/429) is NEVER auto-retried on
 *     the same or another paid route. A 429 observational attempt may get a
 *     BOUNDED RECHECK scheduled at provider-stated reset evidence
 *     (Retry-After / reset instant) — that is admission re-checking, not a
 *     retry. With no reset evidence the attempt HOLDS (unknown is never
 *     guessed). A 402 never yields a reset time (quota.ts), so billing and
 *     auth always STOP.
 *   - A side-effecting operation with unknown idempotency is never
 *     re-executed after ANY failure; it is parked for checkpoint/journal
 *     recovery. A Worker is never run twice on a quota/auth/network
 *     failure: recovery resumes from the durable checkpoint under a new
 *     generation, never a fresh run (`workerRecovery` has no rerun action).
 *   - Auto-retries (transient categories only) are budget-bounded with
 *     exponentially increasing, jittered backoff, and a quota-scope
 *     ADMISSION BLOCK spreads recovery across every worker sharing the
 *     allowance, so recovery does not thundering-herd the provider.
 *   - Switching routes requires an explicit override and a target that does
 *     not draw the same blocked allowance; an automatic (silent) switch,
 *     especially onto a paid API, is forbidden.
 *   - A provider capacity or auth failure is not a model quality signal:
 *     this module never writes catalog/model facts.
 *
 * Storage (ADR-0015 pattern: machine-local, non-secret, injected dir):
 * admission blocks live one-file-per-scope under `<dir>/blocks`, written
 * temp+rename while holding the shared mkdir lock (`withLedgerLock`);
 * readers are lock-free and a corrupt block file fails CLOSED (refuses
 * admission) instead of silently allowing. Scope keys are validated,
 * secret-shaped values are refused, file names are sanitized + hashed, so
 * a hostile scope id can never traverse paths.
 *
 * Network-free by contract: local files only, no dependencies.
 */

import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  CONTRACT_VERSION,
  ContractError,
  agentStateDir,
  expectFields,
  isPlainObject,
  looksLikeSecretValue,
  parseAttemptKey,
  parseEnvelope,
  parseRouteId,
  requireStr,
  toJson,
} from "./contract";
import { isoTime, requireEpochMs, requireIsoTime } from "./attempts";
import {
  MAX_RESET_HORIZON_MS,
  assertQuotaUsage,
  parseQuotaResponse,
  type QuotaUsage,
} from "./quota";
import type { ProbeFailureKind } from "./probe";
import { withLedgerLock } from "./telemetry";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Bounded auto-retry budget per attempt (transient categories only). */
export const MAX_AUTO_RETRIES = 3;

/** Bounded recheck budget for observational attempts after a 429. */
export const MAX_RECHECKS = 3;

/** Base delay for exponential backoff (before jitter). */
export const BACKOFF_BASE_MS = 1_000;

/** Hard ceiling for a computed backoff delay. */
export const BACKOFF_MAX_MS = 60_000;

/** Upper bound for an honored Retry-After (1h, mirrors probe MAX_COOLDOWN_MS). */
export const MAX_RETRY_AFTER_MS = 60 * 60 * 1000;

/** Minimum gap between a failure and a scheduled recheck (never immediate). */
export const MIN_RECHECK_GAP_MS = 1_000;

/** Default state root: `<agentStateDir()>/limits`. */
export function limitsStateDir(): string {
  return join(agentStateDir(), "limits");
}

// ---------------------------------------------------------------------------
// Classification taxonomy
// ---------------------------------------------------------------------------

/**
 * The distinct failure classes (issue #92). `unknown` is the fail-closed
 * catch-all: an unrecognizable signal is never guessed into a retryable
 * class.
 */
export type LimitCategory =
  | "rate-limit" // 429: too many requests in a window; reset may be stated
  | "quota-exhausted" // 429 with an observed depleted allowance (remaining 0)
  | "concurrency" // parallelism limit; clears when the other request ends
  | "billing" // 402: payment required; NO provider reset time exists
  | "auth" // 401/403/restricted: credential or authorization; not transient
  | "network" // timeout/dns/unreachable/5xx: transport or provider down
  | "context" // request exceeds the model context window (deterministic)
  | "model-invalid" // unknown/mismatched model id (config error)
  | "unknown"; // unrecognized — fail closed, never auto-retried

export const LIMIT_CATEGORIES: readonly LimitCategory[] = [
  "rate-limit",
  "quota-exhausted",
  "concurrency",
  "billing",
  "auth",
  "network",
  "context",
  "model-invalid",
  "unknown",
];

/** Policy facts per category — the single authority the decisions read. */
export interface CategoryFacts {
  /** The failure is transient: the operation may be retried after backoff
   * (observational/idempotent attempts only, within budget). */
  transient: boolean;
  /** A provider-stated reset instant can exist for this category. Always
   * false for billing: a 402 has no reset time. */
  resetPossible: boolean;
  /** The failure blocks admission for EVERY worker sharing the quota scope. */
  scopeBlock: boolean;
  /** Recovery continues from the durable checkpoint (never a fresh run). */
  checkpointRecovery: boolean;
}

export const CATEGORY_FACTS: Record<LimitCategory, CategoryFacts> = {
  "rate-limit": { transient: true, resetPossible: true, scopeBlock: true, checkpointRecovery: true },
  "quota-exhausted": { transient: true, resetPossible: true, scopeBlock: true, checkpointRecovery: true },
  concurrency: { transient: true, resetPossible: false, scopeBlock: true, checkpointRecovery: true },
  billing: { transient: false, resetPossible: false, scopeBlock: true, checkpointRecovery: false },
  auth: { transient: false, resetPossible: false, scopeBlock: true, checkpointRecovery: false },
  network: { transient: true, resetPossible: false, scopeBlock: false, checkpointRecovery: true },
  context: { transient: false, resetPossible: false, scopeBlock: false, checkpointRecovery: false },
  "model-invalid": { transient: false, resetPossible: false, scopeBlock: false, checkpointRecovery: false },
  unknown: { transient: false, resetPossible: false, scopeBlock: false, checkpointRecovery: false },
};

/**
 * Severity used when merging admission blocks: the MORE severe category
 * (lower number) wins, so a later billing/auth observation can never be
 * weakened by an earlier transient block.
 */
const CATEGORY_SEVERITY: Record<LimitCategory, number> = {
  billing: 0,
  auth: 0,
  "quota-exhausted": 1,
  "rate-limit": 2,
  concurrency: 3,
  network: 4,
  context: 5,
  "model-invalid": 5,
  unknown: 6,
};

/** Probe failure vocabulary -> category. Exhaustive over ProbeFailureKind:
 * adding a kind in probe.ts breaks compilation here instead of silently
 * misclassifying. Kinds that are not limit/billing/auth/network failures
 * (local config, capability, wire support) map to `unknown` — fail closed. */
const PROBE_FAILURE_CATEGORY: Record<ProbeFailureKind, LimitCategory> = {
  config: "unknown",
  "model-mismatch": "model-invalid",
  "credential-missing": "auth",
  "not-launchable": "unknown",
  dns: "network",
  network: "network",
  timeout: "network",
  auth: "auth",
  payment: "billing",
  forbidden: "auth",
  "rate-limit": "rate-limit",
  "rate-limit-cooldown": "rate-limit",
  restricted: "auth",
  "no-tool-call": "unknown",
  "unsupported-wire": "unknown",
  http: "unknown",
};

const PROBE_FAILURE_KINDS: readonly string[] = Object.keys(PROBE_FAILURE_CATEGORY);

/**
 * Exact provider error codes/types -> category. Only EXACT known codes are
 * read (OpenAI `error.code`, Anthropic `error.type` style); message text is
 * never scraped, anything unrecognized is ignored.
 */
const ERROR_KIND_CATEGORY: Record<string, LimitCategory> = {
  context_length_exceeded: "context",
  model_not_found: "model-invalid",
  invalid_api_key: "auth",
  // OpenAI signals depleted credit/plan allowance as a 429 with this code:
  // it is a BILLING failure (no reset), never an iterative rate limit.
  insufficient_quota: "billing",
  overloaded_error: "network",
};

/**
 * Exit-code convention: a harness that mirrors an HTTP status exits with
 * that status. ONLY these codes are interpreted; any other exit code is
 * `unknown` — an arbitrary exit code is never guessed into a retryable
 * class.
 */
const MIRRORED_EXIT_CODES: Record<number, LimitCategory> = {
  401: "auth",
  402: "billing",
  403: "auth",
  429: "rate-limit",
};

const REASON_BY_CATEGORY: Record<LimitCategory, string> = {
  "rate-limit": "HTTP 429: rate limited",
  "quota-exhausted": "HTTP 429: allowance depleted (remaining 0 observed)",
  concurrency: "concurrency limit observed",
  billing: "HTTP 402: payment required; no provider reset time exists",
  auth: "credential or authorization failure; not transient",
  network: "transport or provider unavailable",
  context: "request exceeds the model context window",
  "model-invalid": "model id unknown or mismatched",
  unknown: "unrecognized failure; failing closed",
};

// ---------------------------------------------------------------------------
// Classification result
// ---------------------------------------------------------------------------

/** The classified verdict for one observed failure. Provenance: the
 * observation is `measured`; every absent fact stays null — never guessed. */
export interface LimitClassification {
  category: LimitCategory;
  /** ISO 8601 UTC instant the failure was observed. */
  observedAt: string;
  /** Provider-stated/observed reset instant (ISO UTC) or null. Always null
   * for billing and auth — a 402/401 has no reset time. */
  resetAt: string | null;
  /** Honored Retry-After in milliseconds, or null. */
  retryAfterMs: number | null;
  /** True when observed usage shows the allowance depleted (remaining 0). */
  exhausted: boolean;
  /** Fixed, secret-free reason (never provider message text). */
  reason: string;
}

function checkClassification(value: LimitClassification, where: string): void {
  if (!isPlainObject(value) || !LIMIT_CATEGORIES.includes(value.category as LimitCategory)) {
    throw new ContractError("schema", `${where}: unknown limit category`);
  }
  requireIsoTime(value.observedAt, `${where}: observedAt`);
  if (value.resetAt !== null) requireIsoTime(value.resetAt, `${where}: resetAt`);
  if (value.retryAfterMs !== null) {
    if (
      typeof value.retryAfterMs !== "number" ||
      !Number.isFinite(value.retryAfterMs) ||
      value.retryAfterMs < 0 ||
      value.retryAfterMs > MAX_RETRY_AFTER_MS
    ) {
      throw new ContractError("schema", `${where}: retryAfterMs out of range`);
    }
  }
  if (typeof value.exhausted !== "boolean") {
    throw new ContractError("schema", `${where}: exhausted must be boolean`);
  }
  if (typeof value.reason !== "string" || !value.reason || looksLikeSecretValue(value.reason)) {
    throw new ContractError("schema", `${where}: reason must be non-empty and secret-free`);
  }
  // Hard invariant: a billing classification can never carry a reset time —
  // a 402 has none (quota.ts). An auth classification with a stray reset is
  // tolerated on the read path (auth never retries, so it is ignored).
  if (value.category === "billing" && value.resetAt !== null) {
    throw new ContractError("schema", `${where}: billing failure cannot carry a reset time`);
  }
}

// ---------------------------------------------------------------------------
// Failure signals (strict validation — every external value is hostile)
// ---------------------------------------------------------------------------

/** Structured evidence for one failure. Every field is optional; absent
 * facts are unknown, never guessed. */
export interface FailureSignal {
  /** Observed HTTP status (>= 400; classifying a success is a caller bug). */
  httpStatus?: number | null;
  /** Probe module failure vocabulary (`ProbeFailureKind`). */
  failureKind?: string | null;
  /** Harness process exit code (interpreted only under the mirror convention). */
  exitCode?: number | null;
  /** Parsed Retry-After, milliseconds, bounded by MAX_RETRY_AFTER_MS. */
  retryAfterMs?: number | null;
  /** Provider-stated reset instant (ISO 8601 UTC). */
  resetAt?: string | null;
  /** Quota observations (quota.ts QuotaUsage), e.g. from parsed headers. */
  usage?: QuotaUsage[] | null;
  /** Exact provider error code/type (`error.code` / `error.type`). */
  errorKind?: string | null;
}

const SIGNAL_FIELDS = [
  "httpStatus",
  "failureKind",
  "exitCode",
  "retryAfterMs",
  "resetAt",
  "usage",
  "errorKind",
] as const;

const ERROR_KIND_RE = /^[A-Za-z0-9_.-]{1,100}$/;

interface CheckedSignal {
  httpStatus: number | null;
  failureKind: string | null;
  exitCode: number | null;
  retryAfterMs: number | null;
  resetAt: string | null;
  usage: QuotaUsage[];
  errorKind: string | null;
}

function optionalNumber(
  raw: Record<string, unknown>,
  key: string,
  where: string,
  min: number,
  max: number,
): number | null {
  const value = raw[key];
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value)) {
    throw new ContractError("schema", `${where}: '${key}' must be a finite integer`);
  }
  if (value < min || value > max) {
    throw new ContractError("schema", `${where}: '${key}' out of range`);
  }
  return value;
}

function checkSignal(raw: FailureSignal, where: string, observedMs: number): CheckedSignal {
  if (!isPlainObject(raw)) {
    throw new ContractError("schema", `${where}: signal object expected`);
  }
  expectFields(raw, SIGNAL_FIELDS, where);
  const httpStatus = optionalNumber(raw, "httpStatus", where, 100, 599);
  if (httpStatus !== null && httpStatus < 400) {
    throw new ContractError("schema", `${where}: httpStatus ${httpStatus} is not a failure`);
  }
  let failureKind: string | null = null;
  if (raw.failureKind !== undefined && raw.failureKind !== null) {
    if (typeof raw.failureKind !== "string" || !PROBE_FAILURE_KINDS.includes(raw.failureKind)) {
      throw new ContractError("schema", `${where}: unknown failureKind`);
    }
    failureKind = raw.failureKind;
  }
  // Exit codes are unsigned 32-bit (Windows NTSTATUS codes arrive large);
  // negative or fractional values are hostile input, never "unknown".
  const exitCode = optionalNumber(raw, "exitCode", where, 0, 4_294_967_295);
  const retryAfterMs = optionalNumber(raw, "retryAfterMs", where, 0, MAX_RETRY_AFTER_MS);
  let resetAt: string | null = null;
  if (raw.resetAt !== undefined && raw.resetAt !== null) {
    const parsed = requireIsoTime(raw.resetAt, `${where}: resetAt`);
    // Implausible horizon: dropped to unknown (quota.ts precedent), never clamped.
    if (Date.parse(parsed) - observedMs <= MAX_RESET_HORIZON_MS) resetAt = parsed;
  }
  let usage: QuotaUsage[] = [];
  if (raw.usage !== undefined && raw.usage !== null) {
    if (!Array.isArray(raw.usage)) {
      throw new ContractError("schema", `${where}: usage must be an array`);
    }
    usage = raw.usage.map((entry, i) => assertQuotaUsage(entry, `${where}: usage[${i}]`));
  }
  let errorKind: string | null = null;
  if (raw.errorKind !== undefined && raw.errorKind !== null) {
    if (typeof raw.errorKind !== "string" || !ERROR_KIND_RE.test(raw.errorKind)) {
      throw new ContractError("schema", `${where}: malformed errorKind`);
    }
    errorKind = raw.errorKind;
  }
  return { httpStatus, failureKind, exitCode, retryAfterMs, resetAt, usage, errorKind };
}

function classification(
  category: LimitCategory,
  observedAt: string,
  signal: CheckedSignal,
): LimitClassification {
  const facts = CATEGORY_FACTS[category];
  const exhausted = signal.usage.some((entry) => entry.remaining === 0);
  return {
    category,
    observedAt,
    resetAt: facts.resetPossible ? signal.resetAt : null,
    retryAfterMs: facts.transient ? signal.retryAfterMs : null,
    exhausted,
    reason: REASON_BY_CATEGORY[category],
  };
}

// ---------------------------------------------------------------------------
// Classification entry points
// ---------------------------------------------------------------------------

/**
 * Classify one failure from structured evidence. Precedence: HTTP status,
 * then probe failure kind, then the exit-code mirror convention; anything
 * unrecognized is `unknown` (fail closed). `observedAt` must be ISO 8601 UTC.
 */
export function classifyFailure(signal: FailureSignal, observedAt: string): LimitClassification {
  requireIsoTime(observedAt, "classifyFailure: observedAt");
  const checked = checkSignal(signal, "classifyFailure", Date.parse(observedAt));
  let category: LimitCategory = "unknown";
  if (checked.httpStatus !== null) {
    const status = checked.httpStatus;
    if (status === 401 || status === 403) category = "auth";
    else if (status === 402) category = "billing";
    else if (status === 429) {
      if (checked.errorKind !== null && ERROR_KIND_CATEGORY[checked.errorKind] !== undefined) {
        category = ERROR_KIND_CATEGORY[checked.errorKind];
      } else if (checked.usage.some((entry) => entry.metric === "concurrency")) {
        category = "concurrency";
      } else if (checked.usage.some((entry) => entry.remaining === 0)) {
        category = "quota-exhausted";
      } else {
        category = "rate-limit";
      }
    } else if (status === 413) category = "context";
    else if (status === 400 || status === 404) {
      category =
        checked.errorKind !== null && ERROR_KIND_CATEGORY[checked.errorKind] !== undefined
          ? ERROR_KIND_CATEGORY[checked.errorKind]
          : "unknown";
    } else if (status >= 500) category = "network";
  } else if (checked.failureKind !== null) {
    category = PROBE_FAILURE_CATEGORY[checked.failureKind as ProbeFailureKind];
  } else if (checked.exitCode !== null) {
    category = MIRRORED_EXIT_CODES[checked.exitCode] ?? "unknown";
  }
  return classification(category, observedAt, checked);
}

function headerValue(headers: Record<string, string>, name: string): string | null {
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lower && typeof value === "string") return value;
  }
  return null;
}

/** Numeric Retry-After (delta seconds or `retry-after-ms`) -> bounded ms;
 * HTTP-date forms and unparseable values are unknown (null), never guessed. */
function parseRetryAfterHeader(headers: Record<string, string> | undefined): number | null {
  if (!headers) return null;
  const msRaw = headerValue(headers, "retry-after-ms");
  if (msRaw !== null) {
    const ms = Number(msRaw);
    if (Number.isFinite(ms) && ms >= 0) return Math.min(Math.round(ms), MAX_RETRY_AFTER_MS);
    return null;
  }
  const secRaw = headerValue(headers, "retry-after");
  if (secRaw === null) return null;
  const seconds = Number(secRaw);
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  return Math.min(Math.round(seconds * 1000), MAX_RETRY_AFTER_MS);
}

/** Extract the exact error code/type from a response body (never message text). */
function errorKindFromBody(body: unknown): string | null {
  if (!isPlainObject(body)) return null;
  for (const container of [body, body["error"]]) {
    if (!isPlainObject(container)) continue;
    for (const key of ["code", "type"]) {
      const value = container[key];
      if (typeof value === "string" && ERROR_KIND_RE.test(value)) return value;
    }
  }
  return null;
}

/**
 * Classify one observed provider response: quota headers/body are parsed by
 * `parseQuotaResponse` (which suppresses every reset fact for a 402), then
 * classified. `input.status` must be >= 400 — classifying a success is a
 * caller bug and throws.
 *
 * Reset provenance: the classification's resetAt comes only from WINDOWED
 * usage observations (entries naming a counted allowance). A bare
 * `retry-after` reset-only channel is excluded there — it is honored as
 * `retryAfterMs` instead — so a short Retry-After can never mask a longer
 * windowed reset.
 */
export function classifyResponse(
  input: { status: number; headers?: Record<string, string>; body?: unknown },
  observedAt: string,
): LimitClassification {
  requireIsoTime(observedAt, "classifyResponse: observedAt");
  if (
    typeof input.status !== "number" ||
    !Number.isInteger(input.status) ||
    input.status < 400 ||
    input.status > 599
  ) {
    throw new ContractError("schema", `classifyResponse: status ${input.status} is not a failure`);
  }
  const quota = parseQuotaResponse(input, observedAt);
  const usage = [...quota.usage, ...concurrencyUsage(input.headers, observedAt)];
  // Earliest reset among entries that name a counted allowance (windowed);
  // reset-only channels (bare retry-after) are excluded by design.
  let windowedReset: string | null = null;
  for (const entry of usage) {
    if (entry.limit === null && entry.remaining === null && entry.used === null) continue;
    if (entry.resetAt === null) continue;
    if (windowedReset === null || Date.parse(entry.resetAt) < Date.parse(windowedReset)) {
      windowedReset = entry.resetAt;
    }
  }
  return classifyFailure(
    {
      httpStatus: quota.status,
      resetAt: windowedReset,
      usage,
      retryAfterMs: parseRetryAfterHeader(input.headers),
      errorKind: errorKindFromBody(input.body),
    },
    observedAt,
  );
}

/**
 * Concurrency-suffix rate-limit headers (`x-ratelimit-(limit|remaining)-
 * concurrency`): quota.ts's window vocabulary does not cover the
 * concurrency metric, so classification parses it here — as a measured
 * rolling/concurrency QuotaUsage. Malformed or negative values are skipped,
 * never guessed. This is the ONLY header shape parsed outside quota.ts.
 */
function concurrencyUsage(
  headers: Record<string, string> | undefined,
  observedAt: string,
): QuotaUsage[] {
  if (!headers) return [];
  const count = (raw: string | null): number | null => {
    if (raw === null) return null;
    const value = Number(raw);
    return Number.isInteger(value) && value >= 0 ? value : null;
  };
  const limit = count(headerValue(headers, "x-ratelimit-limit-concurrency"));
  const remaining = count(headerValue(headers, "x-ratelimit-remaining-concurrency"));
  if (limit === null && remaining === null) return [];
  return [
    assertQuotaUsage(
      {
        window: "rolling",
        metric: "concurrency",
        limit,
        remaining,
        used: limit !== null && remaining !== null ? limit - remaining : null,
        resetAt: null,
        provenance: "measured",
        evidence: { at: observedAt, source: "probe", note: "concurrency rate-limit headers" },
      },
      "concurrencyUsage",
    ),
  ];
}

// ---------------------------------------------------------------------------
// Backoff
// ---------------------------------------------------------------------------

/**
 * Exponential backoff with jitter: `base * 2^retriesUsed * [1, 2)`, clamped
 * to BACKOFF_MAX_MS. The jitter spreads concurrent workers ("thundering
 * herd: none"); inject `rng` for deterministic tests. A hostile rng result
 * degrades to no jitter, never to NaN/Infinity.
 */
export function backoffDelay(retriesUsed: number, rng: () => number = Math.random): number {
  if (!Number.isInteger(retriesUsed) || retriesUsed < 0 || retriesUsed > 1000) {
    throw new ContractError("schema", "backoffDelay: retriesUsed out of range");
  }
  const jitter = Number.isFinite(rng()) ? Math.min(Math.max(rng(), 0), 1) : 0;
  const delay = BACKOFF_BASE_MS * 2 ** retriesUsed * (1 + jitter);
  return Math.min(Math.round(delay), BACKOFF_MAX_MS);
}

// ---------------------------------------------------------------------------
// Retry decision
// ---------------------------------------------------------------------------

export type AttemptKind = "observational" | "side-effecting";

export interface RetryContext {
  /** What the failed operation was. Only observational attempts may ever be
   * auto-retried; side-effecting operations need known idempotency. */
  attemptKind: AttemptKind;
  /** Side-effecting only: re-execution is known idempotent. Even then a
   * quota/auth/payment failure is never auto-retried. */
  idempotent?: boolean;
  /** Auto-retries already spent for this attempt. */
  retriesUsed?: number;
  /** Rechecks already spent for this attempt (429 observational rechecks). */
  rechecksUsed?: number;
}

export type RetryDecision =
  | { action: "retry"; delayMs: number; reason: string }
  | { action: "recheck"; notBefore: string; reason: string }
  | { action: "hold"; reason: string }
  | { action: "stop"; reason: string };

function checkContext(ctx: RetryContext, where: string): Required<RetryContext> {
  if (!isPlainObject(ctx)) {
    throw new ContractError("schema", `${where}: context object expected`);
  }
  expectFields(ctx, ["attemptKind", "idempotent", "retriesUsed", "rechecksUsed"], where);
  if (ctx.attemptKind !== "observational" && ctx.attemptKind !== "side-effecting") {
    throw new ContractError("schema", `${where}: attemptKind must be observational or side-effecting`);
  }
  const idempotent = ctx.idempotent ?? false;
  if (typeof idempotent !== "boolean") {
    throw new ContractError("schema", `${where}: idempotent must be boolean`);
  }
  const count = (key: string): number => {
    const value = ctx[key as "retriesUsed" | "rechecksUsed"] ?? 0;
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 1_000_000) {
      throw new ContractError("schema", `${where}: ${key} out of range`);
    }
    return value;
  };
  return {
    attemptKind: ctx.attemptKind,
    idempotent,
    retriesUsed: count("retriesUsed"),
    rechecksUsed: count("rechecksUsed"),
  };
}

/**
 * The safe retry decision for one classified failure. Never throws for
 * findings; throws ContractError only for invalid input.
 *
 * - auth / billing / context / model-invalid / unknown -> stop (never
 *   retried, never iterated as a rate limit, never switched around).
 * - rate-limit / quota-exhausted: NO auto-retry (the 401/402/429
 *   invariant). Observational attempts get a bounded RECHECK scheduled at
 *   the provider-stated reset / Retry-After (never immediate); with no
 *   reset evidence the attempt holds. Side-effecting operations are parked
 *   for checkpoint recovery regardless of idempotency.
 * - concurrency / network: bounded auto-retry with jittered backoff for
 *   observational attempts and idempotent side-effecting ones; unknown
 *   idempotency is parked, never re-executed.
 */
export function decideRetry(
  c: LimitClassification,
  ctx: RetryContext,
  now: number,
): RetryDecision {
  checkClassification(c, "decideRetry: classification");
  const checked = checkContext(ctx, "decideRetry: context");
  requireEpochMs(now, "decideRetry: now");
  const stop = (reason: string): RetryDecision => ({ action: "stop", reason });
  switch (c.category) {
    case "auth":
      return stop(
        "auth failure: not transient; never retried on the same or another route and never treated as a rate limit",
      );
    case "billing":
      return stop(
        "billing failure (402): payment required; no reset time exists; never auto-retried",
      );
    case "context":
      return stop("context failure: deterministic; retrying the identical input cannot succeed");
    case "model-invalid":
      return stop("model-invalid: configuration error; retrying cannot succeed");
    case "unknown":
      return stop("unclassified failure: failing closed, no automatic retry");
    case "rate-limit":
    case "quota-exhausted":
    case "concurrency":
    case "network":
      break;
  }
  const quotaFamily = c.category === "rate-limit" || c.category === "quota-exhausted";
  if (checked.attemptKind === "side-effecting") {
    if (!checked.idempotent) {
      return {
        action: "hold",
        reason:
          "side-effecting operation with unknown idempotency: re-execution is forbidden; park the attempt and recover from its checkpoint/journal",
      };
    }
    if (quotaFamily) {
      return {
        action: "hold",
        reason:
          "quota-family failure on a side-effecting operation: never auto-retried on the same or another paid route; park until the observed reset, then resume from the checkpoint (never a fresh run)",
      };
    }
    if (checked.retriesUsed >= MAX_AUTO_RETRIES) {
      return stop(`retry budget exhausted (${MAX_AUTO_RETRIES} auto-retries)`);
    }
    return {
      action: "retry",
      delayMs: c.retryAfterMs ?? backoffDelay(checked.retriesUsed),
      reason: `${c.category} failure is transient and the operation is idempotent`,
    };
  }
  if (quotaFamily) {
    if (checked.rechecksUsed >= MAX_RECHECKS) {
      return stop(`bounded recheck budget exhausted (${MAX_RECHECKS} rechecks)`);
    }
    const candidates: number[] = [];
    if (c.resetAt !== null) candidates.push(Date.parse(c.resetAt));
    if (c.retryAfterMs !== null) candidates.push(now + c.retryAfterMs);
    if (candidates.length === 0) {
      return {
        action: "hold",
        reason: "rate limit with no reset evidence: holding; an unknown reset is never guessed",
      };
    }
    const floor = now + MIN_RECHECK_GAP_MS;
    const resetMs = c.resetAt !== null ? Date.parse(c.resetAt) : null;
    const retryMs = c.retryAfterMs !== null ? now + c.retryAfterMs : null;
    // When the provider-stated reset governs, its EXACT string is kept (no
    // reformatting drift); otherwise the computed instant is formatted.
    const notBefore =
      resetMs !== null && (retryMs === null || resetMs >= retryMs)
        ? resetMs >= floor
          ? (c.resetAt as string)
          : isoTime(floor)
        : isoTime(Math.max(retryMs as number, floor));
    return {
      action: "recheck",
      notBefore,
      reason:
        "bounded recheck at the provider-stated reset / Retry-After; admission re-checking, not an automatic retry",
    };
  }
  if (checked.retriesUsed >= MAX_AUTO_RETRIES) {
    return stop(`retry budget exhausted (${MAX_AUTO_RETRIES} auto-retries)`);
  }
  return {
    action: "retry",
    delayMs: c.retryAfterMs ?? backoffDelay(checked.retriesUsed),
    reason: `${c.category} failure is transient; observational attempt retried with bounded jittered backoff`,
  };
}

// ---------------------------------------------------------------------------
// Worker recovery (never run a Worker twice)
// ---------------------------------------------------------------------------

/**
 * What may happen to a durable Worker after one failure. There is
 * deliberately NO "run again from scratch" action: on a quota/auth/network
 * failure the Worker is never run twice — recovery resumes the parked
 * attempt from its checkpoint under a new generation, or stops for a
 * human/actionable report.
 */
export type WorkerRecovery = "hold" | "resume-after-recovery" | "stop-report";

export function workerRecovery(c: LimitClassification): WorkerRecovery {
  checkClassification(c, "workerRecovery: classification");
  switch (c.category) {
    case "rate-limit":
    case "quota-exhausted":
    case "concurrency":
      return "hold";
    case "network":
      return "resume-after-recovery";
    case "billing":
    case "auth":
    case "context":
    case "model-invalid":
    case "unknown":
      return "stop-report";
  }
}

// ---------------------------------------------------------------------------
// Admission blocks (one block involves every worker on the same allowance)
// ---------------------------------------------------------------------------

/** A durable admission block for one quota scope (or route when the scope
 * is unknown — the probe.ts fallback convention). */
export interface AdmissionBlock {
  /** quotaScopeKey (`<kind>:<id>`) or a route id. */
  key: string;
  category: LimitCategory;
  /** Fixed, secret-free reason. */
  reason: string;
  /** ISO UTC reset or null: null means UNKNOWN — the block holds until
   * explicit recovery evidence clears it, never guessed. */
  resetAt: string | null;
  /** ISO UTC creation instant. */
  createdAt: string;
  /** Attempt key of the observer (strictly validated). */
  observedBy: string;
}

export const BLOCK_FIELDS = [
  "key",
  "category",
  "reason",
  "resetAt",
  "createdAt",
  "observedBy",
] as const;

const BLOCK_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;

function requireBlockKey(raw: unknown, where: string): string {
  if (typeof raw !== "string" || !BLOCK_KEY_RE.test(raw) || raw.includes("..")) {
    throw new ContractError("identity", `${where}: malformed block key`);
  }
  if (looksLikeSecretValue(raw)) {
    throw new ContractError("identity", `${where}: refusing secret-shaped block key`);
  }
  return raw;
}

function checkBlock(block: AdmissionBlock, where: string): AdmissionBlock {
  if (!isPlainObject(block)) {
    throw new ContractError("schema", `${where}: block object expected`);
  }
  expectFields(block, BLOCK_FIELDS, where);
  const key = requireBlockKey(block.key, where);
  if (!LIMIT_CATEGORIES.includes(block.category as LimitCategory)) {
    throw new ContractError("schema", `${where}: unknown limit category`);
  }
  const reason = requireStr(block, "reason", where);
  if (looksLikeSecretValue(reason)) {
    throw new ContractError("schema", `${where}: refusing secret-shaped block reason`);
  }
  const resetAt =
    block.resetAt === undefined || block.resetAt === null
      ? null
      : requireIsoTime(block.resetAt, `${where}: resetAt`);
  const createdAt = requireIsoTime(block.createdAt, `${where}: createdAt`);
  const observedByKey = requireStr(block, "observedBy", where);
  parseAttemptKey(observedByKey, `${where}: observedBy`);
  const checked: AdmissionBlock = {
    key,
    category: block.category as LimitCategory,
    reason,
    resetAt,
    createdAt,
    observedBy: observedByKey,
  };
  // Refuse, never redact (checkpoint.ts invariant). The whole-object
  // redact() comparison cannot be used here: the contract treats a field
  // literally named `key` as secret-bearing, so refusal is enforced
  // field-scoped instead — key (requireBlockKey), reason, observedBy
  // (parseAttemptKey) above, and ISO-validated createdAt/resetAt leave no
  // free-text field unchecked.
  return checked;
}

/** The block key for a route: the effective quota scope when known, else the
 * route id (probe.ts cooldown-key convention). Unknown scope is not guessed. */
export function blockKeyFor(scope: string | null, routeId: string): string {
  if (scope !== null) return requireBlockKey(scope, "blockKeyFor: scope");
  parseRouteId(routeId);
  return routeId;
}

/** Filesystem-safe, collision-free name: sanitized prefix + content hash,
 * so a hostile key can never traverse paths or collide. */
function blockPath(dir: string, key: string): string {
  const safe = key.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 64);
  const hash = createHash("sha256").update(key).digest("hex").slice(0, 12);
  return join(join(dir, "blocks"), `${safe}-${hash}.json`);
}

function parseBlock(raw: unknown, where: string): AdmissionBlock {
  const envelope = parseEnvelope(raw, BLOCK_FIELDS, where);
  return checkBlock({ ...(envelope.payload as Record<string, unknown>) } as AdmissionBlock, where);
}

function readBlockFile(path: string, key: string): AdmissionBlock | null {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    // Only ENOENT means "no block recorded". Every other read error
    // (EACCES, EISDIR, ...) fails CLOSED — admission is never silently
    // granted because state could not be read.
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new ContractError(
      "state",
      `admission block for '${key}' unreadable (${path}): ${String(err)}`,
    );
  }
  try {
    return parseBlock(JSON.parse(raw), `admission block '${key}'`);
  } catch (err) {
    // Fail CLOSED: a corrupt block file refuses admission instead of
    // silently allowing; recovery is deleting the state file explicitly.
    throw new ContractError(
      "state",
      `corrupt admission block for '${key}' (${path}): ${String(err)}; delete the limits state file to reset`,
    );
  }
}

function writeBlockAtomic(path: string, block: AdmissionBlock): void {
  mkdirSync(path.slice(0, path.lastIndexOf("/")), { recursive: true });
  const tmp = `${path}.tmp-${randomUUID()}`;
  try {
    try {
      writeFileSync(tmp, `${toJson({ contract_version: CONTRACT_VERSION, ...block })}\n`);
      renameSync(tmp, path); // atomic under the lock; readers see old or new
    } finally {
      // A failed write or rename must never leave tmp debris: unlink always.
      // ENOENT (rename already moved it) is the only acceptable outcome.
      try {
        unlinkSync(tmp);
      } catch {
        // swallowed: nothing to clean, or cleanup impossible (the original
        // error propagates either way)
      }
    }
  } catch (err) {
    // State failures surface as ContractError, never as a raw fs error.
    throw new ContractError("state", `admission block write failed (${path}): ${String(err)}`);
  }
}

/**
 * Record (or strengthen) an admission block for one scope. Must run under
 * the lock. Merge rules — a block is never WEAKENED:
 *   - the more severe category wins (billing/auth beat transient kinds);
 *   - resetAt may only be set from unknown, or move LATER; billing/auth
 *     force resetAt to null (no reset time exists for a 402/401);
 *   - createdAt/observedBy of the first observation are kept.
 */
function mergeBlocks(existing: AdmissionBlock, next: AdmissionBlock): AdmissionBlock {
  const category =
    CATEGORY_SEVERITY[next.category] < CATEGORY_SEVERITY[existing.category]
      ? next.category
      : existing.category;
  let resetAt: string | null;
  if (category === "billing" || category === "auth") {
    resetAt = null;
  } else if (existing.resetAt === null) {
    resetAt = next.resetAt;
  } else if (next.resetAt === null) {
    resetAt = existing.resetAt;
  } else {
    resetAt = Date.parse(next.resetAt) > Date.parse(existing.resetAt) ? next.resetAt : existing.resetAt;
  }
  return { ...existing, category, resetAt };
}

export function recordBlock(
  dir: string,
  input: Omit<AdmissionBlock, "createdAt">,
  now: number,
): AdmissionBlock {
  requireEpochMs(now, "recordBlock: now");
  // The store materializes its directory on first write, so a refused
  // record still leaves a place for the caller to inspect.
  mkdirSync(join(dir, "blocks"), { recursive: true });
  // createdAt is second-precision (sub-second truncated): block timestamps
  // key nothing finer than a reset instant.
  const createdAt = new Date(Math.floor(now / 1000) * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
  const next = checkBlock({ ...input, createdAt }, "recordBlock");
  return withLedgerLock(dir, () => {
    const path = blockPath(dir, next.key);
    const existing = readBlockFile(path, next.key);
    const merged = existing === null ? next : mergeBlocks(existing, next);
    writeBlockAtomic(path, merged);
    return merged;
  });
}

/**
 * Clear an admission block with explicit recovery evidence (e.g. a fresh
 * successful observational probe). Idempotent. The evidence note is
 * validated and must be secret-free; it is the caller's duty that the
 * evidence is real — clearing without recovery evidence would be guessing
 * the limit lifted, which the policy forbids.
 */
export function clearBlock(
  dir: string,
  key: string,
  recovery: { evidence: string; observedAt: string },
): { cleared: boolean } {
  requireBlockKey(key, "clearBlock: key");
  if (typeof recovery.evidence !== "string" || !recovery.evidence || looksLikeSecretValue(recovery.evidence)) {
    throw new ContractError("schema", "clearBlock: evidence must be non-empty and secret-free");
  }
  requireIsoTime(recovery.observedAt, "clearBlock: observedAt");
  return withLedgerLock(dir, () => {
    const path = blockPath(dir, key);
    let cleared = false;
    try {
      unlinkSync(path);
      cleared = true;
    } catch (err) {
      // Only ENOENT means "already clear" (idempotent). Every other error
      // (EACCES, EISDIR, EPERM, ...) fails closed — a block that cannot be
      // removed must keep refusing admission, never vanish silently.
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new ContractError(
          "state",
          `clearBlock: cannot remove admission block for '${key}' (${path}): ${String(err)}`,
        );
      }
      cleared = false;
    }
    return { cleared };
  });
}

export interface AdmissionStatus {
  blocked: boolean;
  block: AdmissionBlock | null;
}

/**
 * Admission check for one scope/route key. A missing block admits; a block
 * with a known reset expires at that instant (evidence-based, not an
 * assumption — the caller should still verify recovery observationally
 * before paid admission); a block with unknown reset holds until
 * `clearBlock`. A corrupt block file fails CLOSED (throws) — never silently
 * admits.
 */
export function checkAdmission(dir: string, key: string, now: number): AdmissionStatus {
  requireBlockKey(key, "checkAdmission: key");
  requireEpochMs(now, "checkAdmission: now");
  const block = readBlockFile(blockPath(dir, key), key);
  if (block === null) return { blocked: false, block: null };
  const blocked = block.resetAt === null || Date.parse(block.resetAt) > now;
  return { blocked, block };
}

// ---------------------------------------------------------------------------
// Route switching (explicit override only; never silently onto a paid API)
// ---------------------------------------------------------------------------

export interface SwitchCheck {
  fromRoute: string;
  toRoute: string;
  /** Quota scope key of the target route (effectiveQuotaKey result), or
   * null when unknown. */
  toScope: string | null;
  /** Whether the target route is paid (metered/subscription). */
  toPaid: boolean;
  /** Explicit human override. Without it every switch is refused. */
  explicitOverride: boolean;
}

export type SwitchDecision = { allowed: boolean; reason: string };

/**
 * Evaluate a route switch. Without an explicit override the switch is
 * refused — an automatic switch, especially onto a paid API, is forbidden.
 * Even WITH an override, a target that draws a currently blocked allowance
 * is refused: switching inside the same exhausted quota is not a switch.
 */
export function evaluateRouteSwitch(check: SwitchCheck, dir: string, now: number): SwitchDecision {
  if (!isPlainObject(check)) {
    throw new ContractError("schema", "evaluateRouteSwitch: check object expected");
  }
  expectFields(check, ["fromRoute", "toRoute", "toScope", "toPaid", "explicitOverride"], "evaluateRouteSwitch");
  parseRouteId(check.fromRoute);
  parseRouteId(check.toRoute);
  if (typeof check.toPaid !== "boolean" || typeof check.explicitOverride !== "boolean") {
    throw new ContractError("schema", "evaluateRouteSwitch: toPaid/explicitOverride must be boolean");
  }
  const toScope =
    check.toScope === undefined || check.toScope === null
      ? null
      : requireBlockKey(check.toScope, "evaluateRouteSwitch: toScope");
  requireEpochMs(now, "evaluateRouteSwitch: now");
  if (!check.explicitOverride) {
    return {
      allowed: false,
      reason: check.toPaid
        ? "target route is paid: switching to a paid API requires an explicit override; automatic switching is forbidden"
        : "route switching requires an explicit override; automatic switching is forbidden",
    };
  }
  if (toScope !== null) {
    const status = checkAdmission(dir, toScope, now);
    if (status.blocked) {
      return {
        allowed: false,
        reason: `target draws allowance '${toScope}' which is admission-blocked${
          status.block?.resetAt !== null && status.block?.resetAt !== undefined
            ? ` until ${status.block.resetAt}`
            : " with no known reset"
        }; switching inside the same blocked allowance is not a switch`,
      };
    }
  }
  return { allowed: true, reason: "explicit override" };
}
