#!/usr/bin/env bun
/**
 * Cross-harness/host recovery and reassignment (dotfiles#101, Epic#86 T015).
 *
 * Handles rate limit, network disconnect, agent/host disappearance, supervisor
 * crash, child crash and context compaction recovery. Delegates same-harness
 * provider fallback to #136→#139; this module owns cross-harness/host attempt
 * handoff only.
 *
 * Hard invariants (ADR-0017, issue #101):
 *   - Herdr detach ≠ stop; unresponsive API ≠ no side effects occurred.
 *   - Old attempt alive/unknown → no mutation without ownership CAS + remote
 *     state reconciliation.
 *   - No silent re-billing or forced switching.
 *   - New host reassignment only with explicit conditions/permission.
 *   - Recovery always converges to terminal, waiting, or blocked.
 *   - Per-account circuit breaker with explicit next action for waiting.
 */

import {
  ContractError,
  parseAttemptKey,
  formatAttemptKey,
  type AttemptIdentity,
  agentStateDir,
  isStale,
  DEFAULT_MAX_EVIDENCE_AGE_MS,
} from "./contract.ts";
import {
  type AttemptRecord,
  type Lease,
  type AttemptStore,
  readAttempt,
  acquireLease,
  releaseLease,
  fenceAttempt,
  assertLeaseCurrent,
  isoTime,
} from "./attempts.ts";
import {
  type CheckpointRecord,
  type JournalStore,
  loadLocalCheckpoint,
  pendingSideEffects,
  readJournal,
  type SideEffectPending,
} from "./checkpoint.ts";
import {
  type LimitClassification,
  type LimitCategory,
  CATEGORY_FACTS,
  workerRecovery,
  checkAdmission,
  limitsStateDir,
} from "./limits.ts";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Recovery state machine
// ---------------------------------------------------------------------------

/**
 * Recovery always converges to one of these states.
 * - terminal: attempt is done (completed/failed/fenced) — no further action.
 * - waiting:  transient block with a known or unknown recheck time.
 * - blocked:  permanent or policy block requiring human/explicit override.
 */
export type RecoveryState = "terminal" | "waiting" | "blocked";

/** Why recovery landed in this state. */
export type RecoveryReason =
  | "attempt-completed"
  | "attempt-failed-terminal"
  | "attempt-fenced"
  | "quota-waiting-reset"
  | "quota-waiting-unknown-reset"
  | "rate-limit-waiting-retry-after"
  | "network-transient-waiting"
  | "old-worker-alive-reconcile"
  | "side-effects-unknown-reconcile"
  | "no-candidates-blocked"
  | "auth-blocked"
  | "billing-blocked"
  | "cross-harness-reassign-pending"
  | "circuit-breaker-open"
  | "context-compaction-blocked"
  | "host-loss-blocked";

/** Explicit next action for waiting states (never implicit). */
export type RecoveryNextAction =
  | "none"                        // terminal
  | "recheck-at"                  // wait until resetAt, then re-verify readiness
  | "recheck-after"               // wait retryAfterMs, then re-verify
  | "reconcile-side-effects"      // verify pending side effects externally
  | "reconcile-remote-state"      // fetch remote Git/PR/Issue state
  | "acquire-new-generation"      // fence old, acquire next generation
  | "await-human-override"        // blocked, needs explicit human decision
  | "await-explicit-reassign";    // blocked, needs explicit reassign permission

export interface RecoveryPlan {
  attemptKey: string;
  state: RecoveryState;
  reason: RecoveryReason;
  nextAction: RecoveryNextAction;
  /** ISO 8601 UTC instant to recheck, or null. */
  recheckAt: string | null;
  /** Bounded retry count already used. */
  retriesUsed: number;
  /** Per-account circuit breaker state for this quota scope. */
  circuitOpen: boolean;
  /** Pending side effects that must be reconciled before replay. */
  pendingEffects: SideEffectPending[];
  /** Old attempt generation, or null if unknown. */
  oldGeneration: number | null;
  /** Whether old attempt is confirmed dead (fenced/released), or unknown. */
  oldAttemptAlive: "dead" | "alive" | "unknown";
  /** Human-readable rationale. */
  rationale: string;
}

// ---------------------------------------------------------------------------
// Circuit breaker (per quota scope)
// ---------------------------------------------------------------------------

export const CIRCUIT_BREAKER_THRESHOLD = 3;
export const CIRCUIT_BREAKER_RESET_MS = 60_000;

interface CircuitState {
  scope: string;
  failures: number;
  openedAt: number | null;
}

function circuitPath(scope: string): string {
  const dir = join(limitsStateDir(), "circuit");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const safeScope = scope.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 100);
  return join(dir, `${safeScope}.json`);
}

export function circuitIsOpen(scope: string, now: number): boolean {
  const path = circuitPath(scope);
  if (!existsSync(path)) return false;
  try {
    const state = JSON.parse(readFileSync(path, "utf-8")) as CircuitState;
    if (state.openedAt === null) return false;
    if (now - state.openedAt > CIRCUIT_BREAKER_RESET_MS) {
      // Auto-reset after cooldown
      writeFileSync(path, JSON.stringify({ scope, failures: 0, openedAt: null }));
      return false;
    }
    return true;
  } catch {
    // Corrupt state fails closed (open)
    return true;
  }
}

export function circuitRecordFailure(scope: string, now: number): void {
  const path = circuitPath(scope);
  let state: CircuitState = { scope, failures: 0, openedAt: null };
  if (existsSync(path)) {
    try {
      state = JSON.parse(readFileSync(path, "utf-8"));
    } catch { /* reset on corrupt */ }
  }
  state.failures += 1;
  if (state.failures >= CIRCUIT_BREAKER_THRESHOLD) {
    state.openedAt = now;
  }
  writeFileSync(path, JSON.stringify(state));
}

export function circuitReset(scope: string): void {
  const path = circuitPath(scope);
  writeFileSync(path, JSON.stringify({ scope, failures: 0, openedAt: null }));
}

// ---------------------------------------------------------------------------
// Attempt liveness probe
// ---------------------------------------------------------------------------

export type AttemptLiveness = "dead" | "alive" | "unknown";

/**
 * Determine whether an old attempt is confirmed dead, alive, or unknown.
 *
 * "dead"  — lease released/fenced, or record shows fenced/completed/failed.
 * "alive" — lease exists, not released, not expired, and generation is newest.
 * "unknown"— anything else (missing record, unreadable state, clock skew).
 *
 * Herdr detach or an unresponsive API NEVER proves "dead".
 */
export function probeAttemptLiveness(
  store: AttemptStore,
  attemptKey: string,
  now: number,
): AttemptLiveness {
  const record = readAttempt(store, attemptKey);
  if (record === null) return "unknown";

  if (record.status === "fenced" || record.status === "completed" || record.status === "failed") {
    return "dead";
  }

  // Record says running — check the newest lease
  const generations = store.listGenerations(attemptKey);
  if (generations.length === 0) return "unknown";
  const newest = generations[generations.length - 1];

  const raw = store.readLease(attemptKey, newest);
  if (raw === null) return "unknown";

  try {
    const lease = raw as { released?: boolean; expiresAt?: string };
    if (lease.released) return "dead";
    if (lease.expiresAt && Date.parse(lease.expiresAt) <= now) return "dead";
    // Lease live and generation matches record → alive
    if (record.generation === newest) return "alive";
    return "unknown";
  } catch {
    return "unknown";
  }
}

// ---------------------------------------------------------------------------
// Side-effect reconciliation
// ---------------------------------------------------------------------------

export interface SideEffectReconciliation {
  attemptKey: string;
  pending: SideEffectPending[];
  /** True when every pending effect has been externally verified. */
  allResolved: boolean;
  /** Effects whose outcome is UNKNOWN and must be verified externally. */
  unknownOutcomes: string[];
}

/**
 * Read pending side effects for an attempt. A pre without a post means the
 * effect outcome is UNKNOWN — recovery must verify externally (git ls-remote,
 * GitHub API), never assume it did not happen.
 */
export function reconcileSideEffects(
  journal: JournalStore,
  attemptKey: string,
): SideEffectReconciliation {
  const pending = pendingSideEffects(journal, attemptKey);
  return {
    attemptKey,
    pending,
    allResolved: pending.length === 0,
    unknownOutcomes: pending.map((p) => p.effectId),
  };
}

// ---------------------------------------------------------------------------
// Recovery planning
// ---------------------------------------------------------------------------

export interface RecoveryInput {
  attemptKey: string;
  store: AttemptStore;
  journal: JournalStore;
  classification: LimitClassification;
  /** Quota scope key for circuit breaker (from limits.ts). */
  quotaScope: string | null;
  /** Retry count already used for this attempt. */
  retriesUsed: number;
  /** Max retries allowed before blocking. */
  maxRetries: number;
  /** Now (epoch ms). */
  now: number;
  /** Whether cross-harness reassignment is explicitly permitted. */
  crossHarnessAllowed?: boolean;
}

/**
 * Plan recovery for a failed/interrupted attempt.
 *
 * Always converges to terminal, waiting, or blocked. Never silently re-bills
 * or force-switches. Old attempt alive/unknown blocks mutation until
 * reconciled.
 */
export function planRecovery(input: RecoveryInput): RecoveryPlan {
  const {
    attemptKey, store, journal, classification,
    quotaScope, retriesUsed, maxRetries, now,
    crossHarnessAllowed = false,
  } = input;

  // 1. Probe old attempt liveness
  const liveness = probeAttemptLiveness(store, attemptKey, now);
  const record = readAttempt(store, attemptKey);
  const oldGeneration = record?.generation ?? null;

  // 2. Reconcile side effects (always, before any decision)
  const sideEffects = reconcileSideEffects(journal, attemptKey);

  // 3. Circuit breaker check
  const circuitOpen = quotaScope !== null && circuitIsOpen(quotaScope, now);

  const base = {
    attemptKey,
    retriesUsed,
    circuitOpen,
    pendingEffects: sideEffects.pending,
    oldGeneration,
    oldAttemptAlive: liveness,
  };

  // 4. Pending side effects with unknown outcome → reconcile BEFORE any terminal decision.
  //    A fenced/failed attempt with unresolved effects must reconcile first;
  //    unresponsive API ≠ no side effects occurred.
  if (!sideEffects.allResolved) {
    return {
      ...base,
      state: "waiting",
      reason: "side-effects-unknown-reconcile",
      nextAction: "reconcile-side-effects",
      recheckAt: null,
      rationale: `${sideEffects.pending.length} side effect(s) have unknown outcome. Verify externally before replay. Unresponsive API ≠ no side effects.`,
    };
  }

  // 5. Terminal: attempt already completed/failed/fenced (and effects resolved)
  if (record !== null && (record.status === "completed" || record.status === "failed" || record.status === "fenced")) {
    const reason: RecoveryReason =
      record.status === "completed" ? "attempt-completed" :
      record.status === "fenced" ? "attempt-fenced" : "attempt-fenced";
    return {
      ...base,
      state: "terminal",
      reason,
      nextAction: "none",
      recheckAt: null,
      rationale: `Attempt is ${record.status}; no further recovery action.`,
    };
  }

  // 6. Old attempt alive → must reconcile before any mutation
  if (liveness === "alive") {
    return {
      ...base,
      state: "waiting",
      reason: "old-worker-alive-reconcile",
      nextAction: "reconcile-remote-state",
      recheckAt: null,
      rationale: "Old attempt lease is live. Fetch remote state and fence before mutation. Herdr detach ≠ stop.",
    };
  }

  // 7. Unknown liveness → must reconcile before any mutation
  if (liveness === "unknown") {
    return {
      ...base,
      state: "waiting",
      reason: "old-worker-alive-reconcile",
      nextAction: "reconcile-remote-state",
      recheckAt: null,
      rationale: "Old attempt liveness unknown. Never assume dead without evidence. Reconcile remote state first.",
    };
  }

  // 8. Circuit breaker open
  if (circuitOpen) {
    const resetAt = isoTime(now + CIRCUIT_BREAKER_RESET_MS);
    return {
      ...base,
      state: "waiting",
      reason: "circuit-breaker-open",
      nextAction: "recheck-at",
      recheckAt: resetAt,
      rationale: `Circuit breaker open for scope ${quotaScope ?? "unknown"}. Recheck after cooldown.`,
    };
  }

  // 9. Classify the failure and decide
  const facts = CATEGORY_FACTS[classification.category as LimitCategory] ?? CATEGORY_FACTS.unknown;
  const wr = workerRecovery(classification);

  // Terminal failure categories (auth, billing, context, model-invalid, unknown)
  if (!facts.transient && !facts.resetPossible) {
    if (classification.category === "auth" || classification.category === "billing") {
      const reason: RecoveryReason = classification.category === "auth" ? "auth-blocked" : "billing-blocked";
      return {
        ...base,
        state: "blocked",
        reason,
        nextAction: "await-human-override",
        recheckAt: null,
        rationale: `${classification.category} failure is not transient. No silent re-billing or forced switching. Human override required.`,
      };
    }
    if (classification.category === "context") {
      return {
        ...base,
        state: "blocked",
        reason: "context-compaction-blocked",
        nextAction: "await-human-override",
        recheckAt: null,
        rationale: "Context overflow. Requires explicit context compaction or new attempt with different scope.",
      };
    }
    // model-invalid, unknown → terminal
    return {
      ...base,
      state: "terminal",
      reason: "attempt-failed-terminal",
      nextAction: "none",
      recheckAt: null,
      rationale: `Non-retryable failure category: ${classification.category}.`,
    };
  }

  // 10. Transient with retry budget remaining
  if (retriesUsed < maxRetries) {
    // Quota exhausted with known reset → waiting until reset
    if (classification.category === "quota-exhausted" && classification.resetAt) {
      return {
        ...base,
        state: "waiting",
        reason: "quota-waiting-reset",
        nextAction: "recheck-at",
        recheckAt: classification.resetAt,
        rationale: "Quota exhausted with known reset. Wait until reset, then re-verify fresh readiness. Never assume reset without evidence.",
      };
    }
    // Quota exhausted without known reset → waiting with unknown recheck
    if (classification.category === "quota-exhausted") {
      return {
        ...base,
        state: "waiting",
        reason: "quota-waiting-unknown-reset",
        nextAction: "reconcile-remote-state",
        recheckAt: null,
        rationale: "Quota exhausted, reset unknown. Do not guess. Re-verify readiness before any retry.",
      };
    }
    // Rate limit with retry-after
    if (classification.category === "rate-limit" && classification.retryAfterMs) {
      const recheckAt = isoTime(now + classification.retryAfterMs);
      return {
        ...base,
        state: "waiting",
        reason: "rate-limit-waiting-retry-after",
        nextAction: "recheck-after",
        recheckAt,
        rationale: `Rate limited. Honor provider-stated retry-after (${classification.retryAfterMs}ms). Bounded retry.`,
      };
    }
    // Network transient
    if (classification.category === "network") {
      return {
        ...base,
        state: "waiting",
        reason: "network-transient-waiting",
        nextAction: "acquire-new-generation",
        recheckAt: null,
        rationale: "Network transient. Fence old attempt (dead), acquire new generation, resume from checkpoint.",
      };
    }
    // Other transient (rate-limit without retry-after, concurrency, quota without reset)
    return {
      ...base,
      state: "waiting",
      reason: "network-transient-waiting",
      nextAction: "acquire-new-generation",
      recheckAt: null,
      rationale: `Transient failure (${classification.category}). Fence old attempt, acquire new generation, bounded retry.`,
    };
  }

  // 11. Retry budget exhausted
  if (facts.resetPossible || facts.transient) {
    // Cross-harness reassignment only with explicit permission
    if (crossHarnessAllowed) {
      return {
        ...base,
        state: "blocked",
        reason: "cross-harness-reassign-pending",
        nextAction: "await-explicit-reassign",
        recheckAt: null,
        rationale: "Retry budget exhausted. Cross-harness reassignment explicitly permitted — await human confirmation to construct new attempt from Issue/Spec/Git/checkpoint.",
      };
    }
    return {
      ...base,
      state: "blocked",
      reason: "no-candidates-blocked",
      nextAction: "await-human-override",
      recheckAt: null,
      rationale: "Retry budget exhausted and no cross-harness permission. Blocked for human decision. No silent re-billing or forced switch.",
    };
  }

  // Should not reach here, but fail closed
  return {
    ...base,
    state: "blocked",
    reason: "no-candidates-blocked",
    nextAction: "await-human-override",
    recheckAt: null,
    rationale: "Unrecognized recovery situation. Failing closed to blocked.",
  };
}

// ---------------------------------------------------------------------------
// Recovery execution helpers
// ---------------------------------------------------------------------------

/**
 * Execute the recovery plan's next step. Returns updated plan.
 *
 * This does NOT perform cross-harness migration — that is #101's reassignment
 * path requiring explicit human permission. Same-harness provider fallback is
 * delegated to #136→#139.
 */
export async function executeRecovery(
  plan: RecoveryPlan,
  input: RecoveryInput,
): Promise<RecoveryPlan> {
  const { store, journal, now } = input;

  switch (plan.nextAction) {
    case "none":
      return plan;

    case "recheck-at":
    case "recheck-after":
      // Caller should wait until recheckAt then re-plan. We just return.
      return plan;

    case "reconcile-side-effects": {
      const recon = reconcileSideEffects(journal, plan.attemptKey);
      if (recon.allResolved) {
        // Side effects resolved — re-plan
        return planRecovery(input);
      }
      return { ...plan, pendingEffects: recon.pending };
    }

    case "reconcile-remote-state": {
      // Caller must fetch remote Git/PR/Issue state. We re-probe liveness.
      const liveness = probeAttemptLiveness(store, plan.attemptKey, now);
      if (liveness === "dead") {
        return planRecovery(input);
      }
      return plan; // still alive/unknown — keep waiting
    }

    case "acquire-new-generation": {
      // Old attempt must be dead first
      const liveness = probeAttemptLiveness(store, plan.attemptKey, now);
      if (liveness !== "dead") {
        return plan; // cannot acquire while old is alive/unknown
      }
      try {
        const lease = acquireLease(store, plan.attemptKey, "recovery", { now, leaseMs: 60_000 });
        // Success — new generation acquired
        return {
          ...plan,
          oldGeneration: lease.generation - 1,
          nextAction: "none",
          state: "terminal",
          reason: "attempt-fenced",
          rationale: `New generation ${lease.acquiredAt} acquired after old attempt confirmed dead.`,
        };
      } catch {
        return plan; // CAS race — retry next cycle
      }
    }

    case "await-human-override":
    case "await-explicit-reassign":
      return plan; // blocked until human acts

    default:
      return plan;
  }
}

// ---------------------------------------------------------------------------
// Convenience: full recovery cycle
// ---------------------------------------------------------------------------

/**
 * Run one recovery cycle: probe → plan → execute. Returns the final plan.
 * Caller is responsible for waiting at recheckAt before calling again.
 */
export async function recoveryCycle(input: RecoveryInput): Promise<RecoveryPlan> {
  const plan = planRecovery(input);
  return executeRecovery(plan, input);
}

// ---------------------------------------------------------------------------
// Render helpers
// ---------------------------------------------------------------------------

export function renderRecoveryPlan(plan: RecoveryPlan): string {
  const lines: string[] = [];
  lines.push(`Recovery: ${plan.attemptKey}`);
  lines.push(`State: ${plan.state} (${plan.reason})`);
  lines.push(`Next action: ${plan.nextAction}`);
  if (plan.recheckAt) lines.push(`Recheck at: ${plan.recheckAt}`);
  lines.push(`Retries used: ${plan.retriesUsed}`);
  lines.push(`Circuit open: ${plan.circuitOpen}`);
  lines.push(`Old attempt: ${plan.oldAttemptAlive} (generation ${plan.oldGeneration ?? "?"})`);
  if (plan.pendingEffects.length > 0) {
    lines.push(`Pending effects: ${plan.pendingEffects.map((p) => p.effectId).join(", ")}`);
  }
  lines.push(`Rationale: ${plan.rationale}`);
  return lines.join("\n");
}
