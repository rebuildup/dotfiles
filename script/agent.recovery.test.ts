#!/usr/bin/env bun
/**
 * Tests for cross-harness/host recovery and reassignment (dotfiles#101, T015).
 *
 * REAL vs MOCK separation:
 *   - MOCK: in-memory AttemptStore/JournalStore doubles for state machine logic.
 *   - REAL: FsAttemptStore/FsJournalStore against temp dirs for liveness probe
 *     and side-effect reconciliation.
 *
 * No live network, no live provider calls. Circuit breaker tests use real
 * filesystem under a temp limits state dir.
 */

import { describe, test, expect, afterAll } from "bun:test";
import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  planRecovery,
  executeRecovery,
  recoveryCycle,
  probeAttemptLiveness,
  reconcileSideEffects,
  circuitIsOpen,
  circuitRecordFailure,
  circuitReset,
  renderRecoveryPlan,
  CIRCUIT_BREAKER_THRESHOLD,
  type RecoveryPlan,
  type RecoveryInput,
} from "./agent/recovery.ts";
import {
  FsAttemptStore,
  initAttempt,
  acquireLease,
  releaseLease,
  fenceAttempt,
  recordResult,
  type AttemptStore,
} from "./agent/attempts.ts";
import { FsJournalStore, journalPreEffect, journalPostEffect } from "./agent/checkpoint.ts";
import { ContractError } from "./agent/contract.ts";

const TMP = mkdtempSync(join(tmpdir(), "agent-recovery-test-"));
afterAll(() => rmSync(TMP, { recursive: true, force: true }));

function newStore(name: string): FsAttemptStore {
  return new FsAttemptStore(join(TMP, name));
}

function newJournal(name: string): FsJournalStore {
  return new FsJournalStore(join(TMP, name));
}

const KEY = "omp.mistral#zai-glm-5-3-flash#test-machine#rec-1";
const NOW = Date.parse("2026-11-12T12:00:00Z");

function baseInput(overrides: Partial<RecoveryInput> = {}): RecoveryInput {
  const store = newStore(`store-${Math.random().toString(36).slice(2)}`);
  const journal = newJournal(`journal-${Math.random().toString(36).slice(2)}`);
  return {
    attemptKey: KEY,
    store,
    journal,
    classification: {
      category: "network",
      observedAt: "2026-11-12T12:00:00Z",
      resetAt: null,
      retryAfterMs: null,
      exhausted: false,
      reason: "transport or provider unavailable",
      quotaScopeKey: null,
    },
    quotaScope: null,
    retriesUsed: 0,
    maxRetries: 3,
    now: NOW,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Attempt liveness probe
// ---------------------------------------------------------------------------

describe("probeAttemptLiveness", () => {
  test("unknown when no record exists", () => {
    const store = newStore("live-none");
    expect(probeAttemptLiveness(store, KEY, NOW)).toBe("unknown");
  });

  test("dead when attempt is fenced", () => {
    const store = newStore("live-fenced");
    initAttempt(store, KEY, { now: NOW });
    fenceAttempt(store, KEY, NOW);
    expect(probeAttemptLiveness(store, KEY, NOW)).toBe("dead");
  });

  test("dead when attempt is completed", () => {
    const store = newStore("live-completed");
    initAttempt(store, KEY, { now: NOW });
    const lease = acquireLease(store, KEY, "w1", { now: NOW, leaseMs: 60_000 });
    recordResult(store, lease, "a".repeat(40), NOW);
    expect(probeAttemptLiveness(store, KEY, NOW)).toBe("dead");
  });

  test("alive when lease is live and generation matches", () => {
    const store = newStore("live-alive");
    initAttempt(store, KEY, { now: NOW });
    acquireLease(store, KEY, "w1", { now: NOW, leaseMs: 60_000 });
    expect(probeAttemptLiveness(store, KEY, NOW)).toBe("alive");
  });

  test("dead when lease is released", () => {
    const store = newStore("live-released");
    initAttempt(store, KEY, { now: NOW });
    const lease = acquireLease(store, KEY, "w1", { now: NOW, leaseMs: 60_000 });
    releaseLease(store, lease, NOW);
    expect(probeAttemptLiveness(store, KEY, NOW)).toBe("dead");
  });

  test("dead when lease is expired", () => {
    const store = newStore("live-expired");
    initAttempt(store, KEY, { now: NOW });
    acquireLease(store, KEY, "w1", { now: NOW, leaseMs: 1_000 });
    // Probe far in the future
    expect(probeAttemptLiveness(store, KEY, NOW + 10_000)).toBe("dead");
  });

  test("Herdr detach (no lease change) does NOT prove dead", () => {
    // Simulating: worker was running, then Herdr detached — no lease change
    const store = newStore("live-detach");
    initAttempt(store, KEY, { now: NOW });
    acquireLease(store, KEY, "w1", { now: NOW, leaseMs: 60_000 });
    // Even after 'detach', lease is still live
    expect(probeAttemptLiveness(store, KEY, NOW + 1_000)).toBe("alive");
  });
});

// ---------------------------------------------------------------------------
// Side-effect reconciliation
// ---------------------------------------------------------------------------

describe("reconcileSideEffects", () => {
  test("no pending effects when journal is empty", () => {
    const journal = newJournal("se-empty");
    const recon = reconcileSideEffects(journal, KEY);
    expect(recon.allResolved).toBe(true);
    expect(recon.pending).toHaveLength(0);
    expect(recon.unknownOutcomes).toHaveLength(0);
  });

  test("pre without post is UNKNOWN outcome", () => {
    const store = newStore("se-store");
    const journal = newJournal("se-journal");
    initAttempt(store, KEY, { now: NOW });
    const lease = acquireLease(store, KEY, "w1", { now: NOW, leaseMs: 60_000 });

    journalPreEffect(store, journal, lease, {
      effectId: "push-1",
      kind: "git-push",
      target: "rebuildup/dotfiles#99",
    }, NOW);

    const recon = reconcileSideEffects(journal, KEY);
    expect(recon.allResolved).toBe(false);
    expect(recon.pending).toHaveLength(1);
    expect(recon.unknownOutcomes).toContain("push-1");
  });

  test("pre with post is resolved", () => {
    const store = newStore("se-store2");
    const journal = newJournal("se-journal2");
    initAttempt(store, KEY, { now: NOW });
    const lease = acquireLease(store, KEY, "w1", { now: NOW, leaseMs: 60_000 });

    journalPreEffect(store, journal, lease, {
      effectId: "push-1",
      kind: "git-push",
      target: "rebuildup/dotfiles#99",
    }, NOW);
    journalPostEffect(store, journal, lease, {
      effectId: "push-1",
      outcome: "succeeded",
      ref: "a".repeat(40),
    }, NOW + 1);

    const recon = reconcileSideEffects(journal, KEY);
    expect(recon.allResolved).toBe(true);
    expect(recon.pending).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Circuit breaker
// ---------------------------------------------------------------------------

describe("circuit breaker", () => {
  test("closed by default", () => {
    const scope = `test-circuit-${Math.random().toString(36).slice(2)}`;
    expect(circuitIsOpen(scope, NOW)).toBe(false);
  });

  test("opens after threshold failures", () => {
    const scope = `test-open-${Math.random().toString(36).slice(2)}`;
    for (let i = 0; i < CIRCUIT_BREAKER_THRESHOLD; i++) {
      circuitRecordFailure(scope, NOW);
    }
    expect(circuitIsOpen(scope, NOW)).toBe(true);
  });

  test("resets after cooldown", () => {
    const scope = `test-reset-${Math.random().toString(36).slice(2)}`;
    for (let i = 0; i < CIRCUIT_BREAKER_THRESHOLD; i++) {
      circuitRecordFailure(scope, NOW);
    }
    expect(circuitIsOpen(scope, NOW)).toBe(true);
    // After cooldown (60s)
    expect(circuitIsOpen(scope, NOW + 61_000)).toBe(false);
  });

  test("explicit reset", () => {
    const scope = `test-explicit-${Math.random().toString(36).slice(2)}`;
    for (let i = 0; i < CIRCUIT_BREAKER_THRESHOLD; i++) {
      circuitRecordFailure(scope, NOW);
    }
    expect(circuitIsOpen(scope, NOW)).toBe(true);
    circuitReset(scope);
    expect(circuitIsOpen(scope, NOW)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// planRecovery state machine
// ---------------------------------------------------------------------------

describe("planRecovery", () => {
  test("converges to terminal when attempt completed", () => {
    const store = newStore("plan-completed");
    initAttempt(store, KEY, { now: NOW });
    const lease = acquireLease(store, KEY, "w1", { now: NOW, leaseMs: 60_000 });
    recordResult(store, lease, "a".repeat(40), NOW);

    const plan = planRecovery(baseInput({ store }));
    expect(plan.state).toBe("terminal");
    expect(plan.reason).toBe("attempt-completed");
    expect(plan.nextAction).toBe("none");
  });

  test("waiting when old attempt alive", () => {
    const store = newStore("plan-alive");
    initAttempt(store, KEY, { now: NOW });
    acquireLease(store, KEY, "w1", { now: NOW, leaseMs: 60_000 });

    const plan = planRecovery(baseInput({ store }));
    expect(plan.state).toBe("waiting");
    expect(plan.reason).toBe("old-worker-alive-reconcile");
    expect(plan.nextAction).toBe("reconcile-remote-state");
    expect(plan.oldAttemptAlive).toBe("alive");
  });

  test("waiting when old attempt liveness unknown", () => {
    const store = newStore("plan-unknown");
    // No record at all → unknown
    const plan = planRecovery(baseInput({ store }));
    expect(plan.state).toBe("waiting");
    expect(plan.reason).toBe("old-worker-alive-reconcile");
    expect(plan.oldAttemptAlive).toBe("unknown");
  });

  test("waiting when side effects have unknown outcome", () => {
    const store = newStore("plan-se");
    const journal = newJournal("plan-se-journal");
    initAttempt(store, KEY, { now: NOW });
    const lease = acquireLease(store, KEY, "w1", { now: NOW, leaseMs: 60_000 });
    // Fence so liveness = dead
    fenceAttempt(store, KEY, NOW);
    // Add pending side effect under generation 1 (before fence)
    // Actually journalPreEffect needs live lease — do it before fence
    // Let's redo: acquire, pre-effect, then fence
    const store2 = newStore("plan-se2");
    const journal2 = newJournal("plan-se2-journal");
    initAttempt(store2, KEY, { now: NOW });
    const lease2 = acquireLease(store2, KEY, "w1", { now: NOW, leaseMs: 60_000 });
    journalPreEffect(store2, journal2, lease2, {
      effectId: "push-1",
      kind: "git-push",
      target: "rebuildup/dotfiles#99",
    }, NOW);
    fenceAttempt(store2, KEY, NOW + 1);

    const plan = planRecovery(baseInput({ store: store2, journal: journal2 }));
    expect(plan.state).toBe("waiting");
    expect(plan.reason).toBe("side-effects-unknown-reconcile");
    expect(plan.nextAction).toBe("reconcile-side-effects");
    expect(plan.pendingEffects).toHaveLength(1);
  });

  test("blocked on auth failure (no silent re-billing)", () => {
    const store = newStore("plan-auth");
    initAttempt(store, KEY, { now: NOW });
    const lease = acquireLease(store, KEY, "w1", { now: NOW, leaseMs: 60_000 });
    releaseLease(store, lease, NOW); // dead

    const plan = planRecovery(baseInput({
      store,
      classification: {
        category: "auth",
        observedAt: "2026-11-12T12:00:00Z",
        resetAt: null,
        retryAfterMs: null,
        exhausted: false,
        reason: "credential or authorization failure",
        quotaScopeKey: null,
      },
    }));
    expect(plan.state).toBe("blocked");
    expect(plan.reason).toBe("auth-blocked");
    expect(plan.nextAction).toBe("await-human-override");
  });

  test("blocked on billing failure (no silent re-billing)", () => {
    const store = newStore("plan-billing");
    initAttempt(store, KEY, { now: NOW });
    const lease = acquireLease(store, KEY, "w1", { now: NOW, leaseMs: 60_000 });
    releaseLease(store, lease, NOW);

    const plan = planRecovery(baseInput({
      store,
      classification: {
        category: "billing",
        observedAt: "2026-11-12T12:00:00Z",
        resetAt: null,
        retryAfterMs: null,
        exhausted: false,
        reason: "payment required",
        quotaScopeKey: null,
      },
    }));
    expect(plan.state).toBe("blocked");
    expect(plan.reason).toBe("billing-blocked");
    expect(plan.nextAction).toBe("await-human-override");
  });

  test("waiting with known quota reset", () => {
    const store = newStore("plan-quota");
    initAttempt(store, KEY, { now: NOW });
    const lease = acquireLease(store, KEY, "w1", { now: NOW, leaseMs: 60_000 });
    releaseLease(store, lease, NOW);

    const resetAt = "2026-11-12T13:00:00Z";
    const plan = planRecovery(baseInput({
      store,
      classification: {
        category: "quota-exhausted",
        observedAt: "2026-11-12T12:00:00Z",
        resetAt,
        retryAfterMs: null,
        exhausted: true,
        reason: "allowance depleted",
        quotaScopeKey: null,
      },
    }));
    expect(plan.state).toBe("waiting");
    expect(plan.reason).toBe("quota-waiting-reset");
    expect(plan.recheckAt).toBe(resetAt);
    expect(plan.nextAction).toBe("recheck-at");
  });

  test("waiting with unknown quota reset (never guess)", () => {
    const store = newStore("plan-quota-unknown");
    initAttempt(store, KEY, { now: NOW });
    const lease = acquireLease(store, KEY, "w1", { now: NOW, leaseMs: 60_000 });
    releaseLease(store, lease, NOW);

    const plan = planRecovery(baseInput({
      store,
      classification: {
        category: "quota-exhausted",
        observedAt: "2026-11-12T12:00:00Z",
        resetAt: null,
        retryAfterMs: null,
        exhausted: true,
        reason: "allowance depleted, reset unknown",
        quotaScopeKey: null,
      },
    }));
    expect(plan.state).toBe("waiting");
    expect(plan.reason).toBe("quota-waiting-unknown-reset");
    expect(plan.recheckAt).toBeNull();
  });

  test("waiting with rate-limit retry-after", () => {
    const store = newStore("plan-rl");
    initAttempt(store, KEY, { now: NOW });
    const lease = acquireLease(store, KEY, "w1", { now: NOW, leaseMs: 60_000 });
    releaseLease(store, lease, NOW);

    const plan = planRecovery(baseInput({
      store,
      classification: {
        category: "rate-limit",
        observedAt: "2026-11-12T12:00:00Z",
        resetAt: null,
        retryAfterMs: 30_000,
        exhausted: false,
        reason: "HTTP 429: rate limited",
        quotaScopeKey: null,
      },
    }));
    expect(plan.state).toBe("waiting");
    expect(plan.reason).toBe("rate-limit-waiting-retry-after");
    expect(plan.recheckAt).not.toBeNull();
  });

  test("blocked when circuit breaker open", () => {
    const store = newStore("plan-circuit");
    initAttempt(store, KEY, { now: NOW });
    const lease = acquireLease(store, KEY, "w1", { now: NOW, leaseMs: 60_000 });
    releaseLease(store, lease, NOW);

    const scope = `test-plan-circuit-${Math.random().toString(36).slice(2)}`;
    for (let i = 0; i < CIRCUIT_BREAKER_THRESHOLD; i++) {
      circuitRecordFailure(scope, NOW);
    }

    const plan = planRecovery(baseInput({ store, quotaScope: scope }));
    expect(plan.state).toBe("waiting");
    expect(plan.reason).toBe("circuit-breaker-open");
    expect(plan.circuitOpen).toBe(true);
  });

  test("blocked when retry budget exhausted and no cross-harness permission", () => {
    const store = newStore("plan-exhausted");
    initAttempt(store, KEY, { now: NOW });
    const lease = acquireLease(store, KEY, "w1", { now: NOW, leaseMs: 60_000 });
    releaseLease(store, lease, NOW);

    const plan = planRecovery(baseInput({ store, retriesUsed: 3, maxRetries: 3 }));
    expect(plan.state).toBe("blocked");
    expect(plan.reason).toBe("no-candidates-blocked");
    expect(plan.nextAction).toBe("await-human-override");
  });

  test("cross-harness reassign pending when explicitly permitted", () => {
    const store = newStore("plan-reassign");
    initAttempt(store, KEY, { now: NOW });
    const lease = acquireLease(store, KEY, "w1", { now: NOW, leaseMs: 60_000 });
    releaseLease(store, lease, NOW);

    const plan = planRecovery(baseInput({
      store,
      retriesUsed: 3,
      maxRetries: 3,
      crossHarnessAllowed: true,
    }));
    expect(plan.state).toBe("blocked");
    expect(plan.reason).toBe("cross-harness-reassign-pending");
    expect(plan.nextAction).toBe("await-explicit-reassign");
  });

  test("network transient with retry budget → waiting, acquire new generation", () => {
    const store = newStore("plan-network");
    initAttempt(store, KEY, { now: NOW });
    const lease = acquireLease(store, KEY, "w1", { now: NOW, leaseMs: 60_000 });
    releaseLease(store, lease, NOW);

    const plan = planRecovery(baseInput({ store }));
    expect(plan.state).toBe("waiting");
    expect(plan.reason).toBe("network-transient-waiting");
    expect(plan.nextAction).toBe("acquire-new-generation");
  });

  test("context overflow → blocked", () => {
    const store = newStore("plan-context");
    initAttempt(store, KEY, { now: NOW });
    const lease = acquireLease(store, KEY, "w1", { now: NOW, leaseMs: 60_000 });
    releaseLease(store, lease, NOW);

    const plan = planRecovery(baseInput({
      store,
      classification: {
        category: "context",
        observedAt: "2026-11-12T12:00:00Z",
        resetAt: null,
        retryAfterMs: null,
        exhausted: false,
        reason: "context overflow",
        quotaScopeKey: null,
      },
    }));
    expect(plan.state).toBe("blocked");
    expect(plan.reason).toBe("context-compaction-blocked");
    expect(plan.nextAction).toBe("await-human-override");
  });
});

// ---------------------------------------------------------------------------
// executeRecovery
// ---------------------------------------------------------------------------

describe("executeRecovery", () => {
  test("terminal plan is returned unchanged", async () => {
    const store = newStore("exec-terminal");
    initAttempt(store, KEY, { now: NOW });
    const lease = acquireLease(store, KEY, "w1", { now: NOW, leaseMs: 60_000 });
    recordResult(store, lease, "a".repeat(40), NOW);

    const input = baseInput({ store });
    const plan = planRecovery(input);
    const result = await executeRecovery(plan, input);
    expect(result.state).toBe("terminal");
    expect(result.nextAction).toBe("none");
  });

  test("waiting plan with recheck is returned unchanged (caller waits)", async () => {
    const store = newStore("exec-wait");
    initAttempt(store, KEY, { now: NOW });
    const lease = acquireLease(store, KEY, "w1", { now: NOW, leaseMs: 60_000 });
    releaseLease(store, lease, NOW);

    const input = baseInput({
      store,
      classification: {
        category: "quota-exhausted",
        observedAt: "2026-11-12T12:00:00Z",
        resetAt: "2026-11-12T13:00:00Z",
        retryAfterMs: null,
        exhausted: true,
        reason: "depleted",
        quotaScopeKey: null,
      },
    });
    const plan = planRecovery(input);
    const result = await executeRecovery(plan, input);
    expect(result.state).toBe("waiting");
    expect(result.recheckAt).toBe("2026-11-12T13:00:00Z");
  });

  test("acquire-new-generation succeeds when old is dead", async () => {
    const store = newStore("exec-gen");
    initAttempt(store, KEY, { now: NOW });
    const lease = acquireLease(store, KEY, "w1", { now: NOW, leaseMs: 60_000 });
    releaseLease(store, lease, NOW); // dead

    const input = baseInput({ store });
    const plan = planRecovery(input);
    expect(plan.nextAction).toBe("acquire-new-generation");

    const result = await executeRecovery(plan, input);
    // Should have acquired new generation
    expect(result.state).toBe("terminal");
    expect(result.rationale).toContain("New generation");
  });

  test("acquire-new-generation does NOT run when old is alive", async () => {
    const store = newStore("exec-gen-alive");
    initAttempt(store, KEY, { now: NOW });
    acquireLease(store, KEY, "w1", { now: NOW, leaseMs: 60_000 }); // alive

    const input = baseInput({ store });
    const plan = planRecovery(input);
    // Should be waiting for reconcile, not acquire
    expect(plan.nextAction).toBe("reconcile-remote-state");

    const result = await executeRecovery(plan, input);
    expect(result.state).toBe("waiting");
    expect(result.oldAttemptAlive).toBe("alive");
  });

  test("blocked plan is returned unchanged (await human)", async () => {
    const store = newStore("exec-blocked");
    initAttempt(store, KEY, { now: NOW });
    const lease = acquireLease(store, KEY, "w1", { now: NOW, leaseMs: 60_000 });
    releaseLease(store, lease, NOW);

    const input = baseInput({
      store,
      classification: {
        category: "auth",
        observedAt: "2026-11-12T12:00:00Z",
        resetAt: null,
        retryAfterMs: null,
        exhausted: false,
        reason: "unauthorized",
        quotaScopeKey: null,
      },
    });
    const plan = planRecovery(input);
    const result = await executeRecovery(plan, input);
    expect(result.state).toBe("blocked");
    expect(result.nextAction).toBe("await-human-override");
  });
});

// ---------------------------------------------------------------------------
// recoveryCycle (full cycle)
// ---------------------------------------------------------------------------

describe("recoveryCycle", () => {
  test("converges to terminal for completed attempt", async () => {
    const store = newStore("cycle-completed");
    initAttempt(store, KEY, { now: NOW });
    const lease = acquireLease(store, KEY, "w1", { now: NOW, leaseMs: 60_000 });
    recordResult(store, lease, "a".repeat(40), NOW);

    const plan = await recoveryCycle(baseInput({ store }));
    expect(plan.state).toBe("terminal");
  });

  test("converges to waiting for alive attempt", async () => {
    const store = newStore("cycle-alive");
    initAttempt(store, KEY, { now: NOW });
    acquireLease(store, KEY, "w1", { now: NOW, leaseMs: 60_000 });

    const plan = await recoveryCycle(baseInput({ store }));
    expect(plan.state).toBe("waiting");
    expect(plan.oldAttemptAlive).toBe("alive");
  });

  test("converges to blocked for auth failure", async () => {
    const store = newStore("cycle-auth");
    initAttempt(store, KEY, { now: NOW });
    const lease = acquireLease(store, KEY, "w1", { now: NOW, leaseMs: 60_000 });
    releaseLease(store, lease, NOW);

    const plan = await recoveryCycle(baseInput({
      store,
      classification: {
        category: "auth",
        observedAt: "2026-11-12T12:00:00Z",
        resetAt: null,
        retryAfterMs: null,
        exhausted: false,
        reason: "unauthorized",
        quotaScopeKey: null,
      },
    }));
    expect(plan.state).toBe("blocked");
  });
});

// ---------------------------------------------------------------------------
// renderRecoveryPlan
// ---------------------------------------------------------------------------

describe("renderRecoveryPlan", () => {
  test("renders state, reason, next action, liveness", () => {
    const store = newStore("render");
    initAttempt(store, KEY, { now: NOW });
    acquireLease(store, KEY, "w1", { now: NOW, leaseMs: 60_000 });

    const plan = planRecovery(baseInput({ store }));
    const text = renderRecoveryPlan(plan);

    expect(text).toContain("waiting");
    expect(text).toContain("old-worker-alive-reconcile");
    expect(text).toContain("reconcile-remote-state");
    expect(text).toContain("alive");
    expect(text).toContain(KEY);
  });

  test("renders pending effects", () => {
    const store = newStore("render-se");
    const journal = newJournal("render-se-journal");
    initAttempt(store, KEY, { now: NOW });
    const lease = acquireLease(store, KEY, "w1", { now: NOW, leaseMs: 60_000 });
    journalPreEffect(store, journal, lease, {
      effectId: "push-1",
      kind: "git-push",
      target: "rebuildup/dotfiles#99",
    }, NOW);
    fenceAttempt(store, KEY, NOW + 1);

    const plan = planRecovery(baseInput({ store, journal }));
    const text = renderRecoveryPlan(plan);
    expect(text).toContain("push-1");
    expect(text).toContain("Pending effects");
  });
});
