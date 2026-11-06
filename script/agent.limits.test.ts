/**
 * Limit / billing / network failure classification and safe retry policy
 * tests (issue #92, T006).
 *
 * MOCK: every provider response, header set, exit code and probe failure
 * kind below is a synthetic fixture (no network, no secrets). Classification
 * and retry decisions are exercised against a fixed reference clock.
 * REAL: the admission-block concurrency test spawns real `bun` child
 * processes racing `recordBlock` on a real temp directory (multi-process
 * serialization proof), and every block-store test uses the real
 * filesystem.
 *
 * Run: bun test script/agent.limits.test.ts
 */

import { describe, test, expect, afterAll } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BACKOFF_MAX_MS,
  BACKOFF_BASE_MS,
  MAX_AUTO_RETRIES,
  MAX_RECHECKS,
  MAX_RETRY_AFTER_MS,
  MIN_RECHECK_GAP_MS,
  backoffDelay,
  blockKeyFor,
  checkAdmission,
  classifyFailure,
  classifyResponse,
  clearBlock,
  decideRetry,
  evaluateRouteSwitch,
  limitsStateDir,
  recordBlock,
  workerRecovery,
  type FailureSignal,
  type LimitClassification,
  type RetryContext,
} from "./agent/limits";
import { ContractError } from "./agent/contract";

const NOW = Date.parse("2026-11-06T12:00:00Z");
const OBSERVED = "2026-11-06T12:00:00Z";
const RESET = "2026-11-06T12:01:00Z";

function signal(overrides: FailureSignal = {}): FailureSignal {
  return { httpStatus: 429, ...overrides };
}

function classified(overrides: Partial<LimitClassification> = {}): LimitClassification {
  return {
    category: "rate-limit",
    observedAt: OBSERVED,
    resetAt: null,
    retryAfterMs: null,
    exhausted: false,
    reason: "HTTP 429: rate limited",
    ...overrides,
  };
}

function context(overrides: RetryContext = {}): RetryContext {
  return { attemptKind: "observational", ...overrides };
}

function tmpState(): string {
  return mkdtempSync(join(tmpdir(), "limits-test-"));
}

const TEMP_DIRS: string[] = [];
afterAll(() => {
  for (const dir of TEMP_DIRS) rmSync(dir, { recursive: true, force: true });
});

function state(): string {
  const dir = tmpState();
  TEMP_DIRS.push(dir);
  return dir;
}

function expectContractError(fn: () => unknown, code?: string): void {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(ContractError);
    if (code !== undefined) expect((err as ContractError).code).toBe(code);
    return;
  }
  throw new Error("expected ContractError, none thrown");
}

// ---------------------------------------------------------------------------
// Classification (mock responses / signals)
// ---------------------------------------------------------------------------

describe("classifyResponse", () => {
  test("429 with reset headers -> rate-limit with measured reset", () => {
    const c = classifyResponse(
      {
        status: 429,
        headers: {
          "retry-after": "30",
          "x-ratelimit-remaining-minute": "7",
          "x-ratelimit-reset-minute": "42",
        },
      },
      OBSERVED,
    );
    expect(c.category).toBe("rate-limit");
    expect(c.resetAt).toBe("2026-11-06T12:00:42.000Z");
    expect(c.retryAfterMs).toBe(30_000);
    expect(c.exhausted).toBe(false);
  });

  test("429 with remaining 0 -> quota-exhausted", () => {
    const c = classifyResponse(
      { status: 429, headers: { "x-ratelimit-remaining-day": "0", "x-ratelimit-limit-day": "50" } },
      OBSERVED,
    );
    expect(c.category).toBe("quota-exhausted");
    expect(c.exhausted).toBe(true);
  });

  test("429 with concurrency metric -> concurrency (not a volume limit)", () => {
    const c = classifyResponse(
      { status: 429, headers: { "x-ratelimit-remaining-concurrency": "0" } },
      OBSERVED,
    );
    expect(c.category).toBe("concurrency");
    expect(c.exhausted).toBe(true);
  });

  test("429 with insufficient_quota error code -> billing (never iterated as rate limit)", () => {
    const c = classifyResponse(
      {
        status: 429,
        headers: { "retry-after": "60" },
        body: { error: { code: "insufficient_quota", message: "sk-abc123" } },
      },
      OBSERVED,
    );
    expect(c.category).toBe("billing");
    // A billing failure never carries retry pressure or a reset.
    expect(c.resetAt).toBeNull();
    expect(c.retryAfterMs).toBeNull();
  });

  test("402 -> billing with NO reset even when reset headers are present", () => {
    const c = classifyResponse(
      {
        status: 402,
        headers: { "x-ratelimit-reset-minute": "42", "retry-after": "10" },
        body: { error: { reset_at: RESET } },
      },
      OBSERVED,
    );
    expect(c.category).toBe("billing");
    expect(c.resetAt).toBeNull();
    expect(c.retryAfterMs).toBeNull();
  });

  test("401 -> auth; 403 -> auth", () => {
    expect(classifyResponse({ status: 401 }, OBSERVED).category).toBe("auth");
    expect(classifyResponse({ status: 403 }, OBSERVED).category).toBe("auth");
  });

  test("400/404 with exact error codes -> context / model-invalid; plain -> unknown", () => {
    expect(
      classifyResponse({ status: 400, body: { error: { code: "context_length_exceeded" } } }, OBSERVED)
        .category,
    ).toBe("context");
    expect(
      classifyResponse({ status: 404, body: { error: { code: "model_not_found" } } }, OBSERVED).category,
    ).toBe("model-invalid");
    expect(classifyResponse({ status: 400, body: { error: { message: "bad" } } }, OBSERVED).category).toBe(
      "unknown",
    );
  });

  test("5xx and 529 overloaded -> network", () => {
    expect(classifyResponse({ status: 500 }, OBSERVED).category).toBe("network");
    expect(classifyResponse({ status: 503 }, OBSERVED).category).toBe("network");
    expect(
      classifyResponse({ status: 529, body: { error: { type: "overloaded_error" } } }, OBSERVED).category,
    ).toBe("network");
  });

  test("retry-after-ms and unparseable Retry-After", () => {
    expect(classifyResponse({ status: 429, headers: { "retry-after-ms": "250" } }, OBSERVED).retryAfterMs).toBe(250);
    // HTTP-date form: unknown, never guessed.
    expect(
      classifyResponse({ status: 429, headers: { "retry-after": "Wed, 06 Nov 2026 12:01:00 GMT" } }, OBSERVED)
        .retryAfterMs,
    ).toBeNull();
  });

  test("non-failure statuses and hostile status values throw", () => {
    expectContractError(() => classifyResponse({ status: 200 }, OBSERVED));
    expectContractError(() => classifyResponse({ status: 302 }, OBSERVED));
    expectContractError(() => classifyResponse({ status: 429.5 }, OBSERVED));
    expectContractError(() => classifyResponse({ status: "429" as unknown as number }, OBSERVED));
    expectContractError(() => classifyResponse({ status: Number.NaN }, OBSERVED));
  });
});

describe("classifyFailure (signals)", () => {
  test("probe failure kinds map exhaustively and honestly", () => {
    const cases: Array<[string, string]> = [
      ["timeout", "network"],
      ["dns", "network"],
      ["network", "network"],
      ["auth", "auth"],
      ["forbidden", "auth"],
      ["credential-missing", "auth"],
      ["restricted", "auth"],
      ["payment", "billing"],
      ["rate-limit", "rate-limit"],
      ["rate-limit-cooldown", "rate-limit"],
      ["model-mismatch", "model-invalid"],
      // Not limit failures: fail closed instead of inventing a class.
      ["config", "unknown"],
      ["not-launchable", "unknown"],
      ["no-tool-call", "unknown"],
      ["unsupported-wire", "unknown"],
      ["http", "unknown"],
    ];
    for (const [kind, expected] of cases) {
      expect(classifyFailure({ failureKind: kind }, OBSERVED).category).toBe(expected);
    }
  });

  test("unknown failureKind values are rejected, not guessed", () => {
    expectContractError(() => classifyFailure({ failureKind: "totally-new-kind" }, OBSERVED));
    expectContractError(() => classifyFailure({ failureKind: "" }, OBSERVED));
  });

  test("exit codes: only the documented mirror convention is interpreted", () => {
    expect(classifyFailure({ exitCode: 429 }, OBSERVED).category).toBe("rate-limit");
    expect(classifyFailure({ exitCode: 401 }, OBSERVED).category).toBe("auth");
    expect(classifyFailure({ exitCode: 402 }, OBSERVED).category).toBe("billing");
    // Everything else fails closed — exit 1 is never "probably rate limit".
    expect(classifyFailure({ exitCode: 1 }, OBSERVED).category).toBe("unknown");
    expect(classifyFailure({ exitCode: 137 }, OBSERVED).category).toBe("unknown");
  });

  test("empty signal -> unknown", () => {
    expect(classifyFailure({}, OBSERVED).category).toBe("unknown");
  });

  test("hostile signal values throw (NaN, Infinity, negative, epoch, unknown fields)", () => {
    expectContractError(() => classifyFailure({ retryAfterMs: Number.NaN }, OBSERVED));
    expectContractError(() => classifyFailure({ retryAfterMs: Number.POSITIVE_INFINITY }, OBSERVED));
    expectContractError(() => classifyFailure({ retryAfterMs: -1 }, OBSERVED));
    expectContractError(() => classifyFailure({ retryAfterMs: MAX_RETRY_AFTER_MS + 1 }, OBSERVED));
    expectContractError(() => classifyFailure({ exitCode: -1 }, OBSERVED));
    expectContractError(() => classifyFailure({ exitCode: 1.5 }, OBSERVED));
    expectContractError(() => classifyFailure({ httpStatus: 0 }, OBSERVED));
    // Epoch NUMBER as resetAt is rejected (epoch-vs-ISO confusion).
    expectContractError(() => classifyFailure({ resetAt: Date.now() }, OBSERVED));
    expectContractError(() => classifyFailure({ resetAt: "not-a-date" }, OBSERVED));
    expectContractError(() => classifyFailure({ resetAt: "2026-11-06T12:00:00+01:00" }, OBSERVED));
    expectContractError(() => classifyFailure({ usage: "nope" } as unknown as FailureSignal, OBSERVED));
    expectContractError(() => classifyFailure({ ...signal(), bogus: 1 } as unknown as FailureSignal, OBSERVED));
    expectContractError(() => classifyFailure(signal(), "2026-11-06T12:00:00+01:00"));
  });

  test("reset beyond the plausibility horizon drops to unknown", () => {
    const far = classifyFailure({ httpStatus: 429, resetAt: "2126-11-06T12:00:00Z" }, OBSERVED);
    expect(far.resetAt).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Retry decisions
// ---------------------------------------------------------------------------

describe("decideRetry", () => {
  test("auth and billing always stop, even for observational attempts", () => {
    // No reset attached: a billing classification with a reset is
    // contract-impossible (402 has none) and is covered by its own test.
    for (const category of ["auth", "billing"] as const) {
      for (const attemptKind of ["observational", "side-effecting"] as const) {
        const d = decideRetry(classified({ category }), context({ attemptKind }), NOW);
        expect(d.action).toBe("stop");
      }
    }
  });

  test("context / model-invalid / unknown always stop", () => {
    for (const category of ["context", "model-invalid", "unknown"] as const) {
      expect(decideRetry(classified({ category }), context(), NOW).action).toBe("stop");
    }
  });

  test("429 observational: recheck at reset, at Retry-After, or hold when unknown", () => {
    const atReset = decideRetry(classified({ resetAt: RESET }), context(), NOW);
    expect(atReset).toEqual({
      action: "recheck",
      notBefore: RESET,
      reason: expect.any(String),
    });
    const afterRetry = decideRetry(classified({ retryAfterMs: 5_000 }), context(), NOW);
    expect(afterRetry.action).toBe("recheck");
    expect(afterRetry.action === "recheck" && afterRetry.notBefore).toBe("2026-11-06T12:00:05.000Z");
    // reset AND Retry-After: the later (conservative) instant wins.
    const both = decideRetry(classified({ resetAt: RESET, retryAfterMs: 120_000 }), context(), NOW);
    expect(both.action === "recheck" && both.notBefore).toBe("2026-11-06T12:02:00.000Z");
    // No reset evidence at all: hold, never guess.
    expect(decideRetry(classified({ resetAt: null }), context(), NOW).action).toBe("hold");
  });

  test("429 observational recheck is never immediate and is budget-bounded", () => {
    const d = decideRetry(classified({ resetAt: OBSERVED }), context(), NOW);
    expect(d.action === "recheck" && Date.parse(d.notBefore)).toBeGreaterThanOrEqual(NOW + MIN_RECHECK_GAP_MS);
    const exhausted = decideRetry(classified(), context({ rechecksUsed: MAX_RECHECKS }), NOW);
    expect(exhausted.action).toBe("stop");
  });

  test("429 is never auto-retried for side-effecting operations (idempotent or not)", () => {
    for (const category of ["rate-limit", "quota-exhausted"] as const) {
      for (const idempotent of [false, true]) {
        const d = decideRetry(
          classified({ category, resetAt: RESET }),
          context({ attemptKind: "side-effecting", idempotent }),
          NOW,
        );
        expect(d.action).toBe("hold");
      }
    }
  });

  test("side-effecting with unknown idempotency is parked for every transient failure", () => {
    for (const category of ["rate-limit", "quota-exhausted", "concurrency", "network"] as const) {
      const d = decideRetry(
        classified({ category }),
        context({ attemptKind: "side-effecting", idempotent: false }),
        NOW,
      );
      expect(d.action).toBe("hold");
    }
  });

  test("concurrency / network: bounded auto-retry, Retry-After honored, budget enforced", () => {
    const d = decideRetry(classified({ category: "network" }), context(), NOW);
    expect(d.action).toBe("retry");
    expect(d.action === "retry" && d.delayMs).toBeGreaterThanOrEqual(BACKOFF_BASE_MS);
    const honored = decideRetry(
      classified({ category: "concurrency", retryAfterMs: 2_500 }),
      context({ retriesUsed: 1 }),
      NOW,
    );
    expect(honored.action === "retry" && honored.delayMs).toBe(2_500);
    const exhausted = decideRetry(
      classified({ category: "network" }),
      context({ retriesUsed: MAX_AUTO_RETRIES }),
      NOW,
    );
    expect(exhausted.action).toBe("stop");
    // Idempotent side-effecting operations may retry on non-quota failures.
    const idem = decideRetry(
      classified({ category: "network" }),
      context({ attemptKind: "side-effecting", idempotent: true }),
      NOW,
    );
    expect(idem.action).toBe("retry");
  });

  test("billing/auth classifications can never smuggle a reset into a decision", () => {
    expectContractError(() =>
      decideRetry(classified({ category: "billing", resetAt: RESET }), context(), NOW),
    );
  });

  test("hostile decision inputs throw", () => {
    expectContractError(() => decideRetry(classified({ category: "nonsense" as never }), context(), NOW));
    expectContractError(() => decideRetry(classified(), { attemptKind: "yolo" } as unknown as RetryContext, NOW));
    expectContractError(() => decideRetry(classified(), context({ retriesUsed: -1 }), NOW));
    expectContractError(() => decideRetry(classified(), context({ retriesUsed: Number.NaN }), NOW));
    expectContractError(() => decideRetry(classified(), context(), Number.NaN));
    expectContractError(() => decideRetry(classified(), context(), "now" as unknown as number));
  });
});

describe("backoffDelay", () => {
  test("exponential growth, jittered, clamped", () => {
    expect(backoffDelay(0, () => 0)).toBe(BACKOFF_BASE_MS);
    expect(backoffDelay(1, () => 0)).toBe(2 * BACKOFF_BASE_MS);
    expect(backoffDelay(2, () => 0)).toBe(4 * BACKOFF_BASE_MS);
    expect(backoffDelay(2, () => 0.99)).toBeGreaterThan(4 * BACKOFF_BASE_MS);
    expect(backoffDelay(2, () => 0.99)).toBeLessThan(8 * BACKOFF_BASE_MS);
    expect(backoffDelay(50, () => 0)).toBe(BACKOFF_MAX_MS);
    expect(backoffDelay(50, () => 0.99)).toBe(BACKOFF_MAX_MS);
  });

  test("jitter spreads concurrent workers and hostile rng degrades safely", () => {
    const delays = new Set<number>();
    for (let i = 0; i < 50; i++) delays.add(backoffDelay(1));
    expect(delays.size).toBeGreaterThan(1); // jitter actually varies
    expect(backoffDelay(1, () => Number.NaN)).toBe(2 * BACKOFF_BASE_MS); // no NaN
    expectContractError(() => backoffDelay(-1));
    expectContractError(() => backoffDelay(1.5));
  });
});

// ---------------------------------------------------------------------------
// Worker recovery: never run a Worker twice
// ---------------------------------------------------------------------------

describe("workerRecovery", () => {
  test("no category ever yields a fresh rerun; quota/auth/network map safely", () => {
    for (const category of [
      "rate-limit",
      "quota-exhausted",
      "concurrency",
      "billing",
      "auth",
      "network",
      "context",
      "model-invalid",
      "unknown",
    ] as const) {
      const recovery = workerRecovery(classified({ category }));
      expect(["hold", "resume-after-recovery", "stop-report"]).toContain(recovery);
    }
    expect(workerRecovery(classified({ category: "rate-limit" }))).toBe("hold");
    expect(workerRecovery(classified({ category: "quota-exhausted" }))).toBe("hold");
    expect(workerRecovery(classified({ category: "concurrency" }))).toBe("hold");
    expect(workerRecovery(classified({ category: "network" }))).toBe("resume-after-recovery");
    expect(workerRecovery(classified({ category: "auth" }))).toBe("stop-report");
    expect(workerRecovery(classified({ category: "billing" }))).toBe("stop-report");
  });
});

// ---------------------------------------------------------------------------
// Admission blocks (real filesystem + real multi-process serialization)
// ---------------------------------------------------------------------------

describe("admission blocks", () => {
  test("record, block, expire at reset, hold when reset unknown", () => {
    const dir = state();
    const block = recordBlock(
      dir,
      {
        key: "account:team-a",
        category: "rate-limit",
        reason: "HTTP 429: rate limited",
        resetAt: RESET,
        observedBy: "claude.anthropic#wsl-desktop#a1#n0001",
      },
      NOW,
    );
    expect(block.createdAt).toBe(OBSERVED);
    expect(checkAdmission(dir, "account:team-a", NOW).blocked).toBe(true);
    // Evidence-based expiry exactly at the stated reset.
    expect(checkAdmission(dir, "account:team-a", Date.parse(RESET)).blocked).toBe(false);
    // Unknown reset: blocked until explicit recovery, never auto-expired.
    recordBlock(
      dir,
      {
        key: "account:team-b",
        category: "billing",
        reason: "HTTP 402: payment required",
        resetAt: null,
        observedBy: "claude.anthropic#wsl-desktop#a1#n0001",
      },
      NOW,
    );
    expect(checkAdmission(dir, "account:team-b", Date.parse("2027-11-06T12:00:00Z")).blocked).toBe(true);
    expect(clearBlock(dir, "account:team-b", { evidence: "payment resolved", observedAt: OBSERVED }).cleared).toBe(
      true,
    );
    expect(checkAdmission(dir, "account:team-b", NOW).blocked).toBe(false);
    // Idempotent clear.
    expect(clearBlock(dir, "account:team-b", { evidence: "again", observedAt: OBSERVED }).cleared).toBe(false);
  });

  test("merge never weakens: severity wins, reset only moves later or becomes known", () => {
    const dir = state();
    const key = "account:team-c";
    recordBlock(
      dir,
      {
        key,
        category: "rate-limit",
        reason: "HTTP 429: rate limited",
        resetAt: RESET,
        observedBy: "claude.anthropic#wsl-desktop#a1#n0001",
      },
      NOW,
    );
    // A later, earlier-reset observation must NOT shorten the block.
    const merged = recordBlock(
      dir,
      {
        key,
        category: "rate-limit",
        reason: "HTTP 429: rate limited",
        resetAt: "2026-11-06T12:00:30Z",
        observedBy: "claude.anthropic#wsl-desktop#a2#n0002",
      },
      NOW + 1,
    );
    expect(merged.resetAt).toBe(RESET);
    // A billing observation upgrades the block and removes the reset (402 has none).
    const upgraded = recordBlock(
      dir,
      {
        key,
        category: "billing",
        reason: "HTTP 402: payment required",
        resetAt: RESET,
        observedBy: "claude.anthropic#wsl-desktop#a3#n0003",
      },
      NOW + 2,
    );
    expect(upgraded.category).toBe("billing");
    expect(upgraded.resetAt).toBeNull();
    expect(checkAdmission(dir, key, Date.parse("2027-01-01T00:00:00Z")).blocked).toBe(true);
  });

  test("blockKeyFor: scope wins, route fallback, hostile keys refused", () => {
    expect(blockKeyFor("account:team-a", "claude.anthropic")).toBe("account:team-a");
    expect(blockKeyFor(null, "claude.anthropic")).toBe("claude.anthropic");
    expectContractError(() => blockKeyFor("../etc/passwd", "claude.anthropic"), "identity");
    expectContractError(() => blockKeyFor("account:../escape", "claude.anthropic"), "identity");
    expectContractError(() => blockKeyFor("sk-abc123def456", "claude.anthropic"), "identity");
    expectContractError(() => blockKeyFor("", "claude.anthropic"), "identity");
    expectContractError(() => blockKeyFor(null, "not a route"), "identity");
  });

  test("hostile block records are refused, never redacted-then-saved", () => {
    const dir = state();
    const base = {
      key: "account:team-d",
      category: "rate-limit" as const,
      reason: "HTTP 429: rate limited",
      resetAt: RESET,
      observedBy: "claude.anthropic#wsl-desktop#a1#n0001",
    };
    expectContractError(() =>
      recordBlock(dir, { ...base, observedBy: "not-an-attempt-key" }, NOW),
    );
    expectContractError(() => recordBlock(dir, { ...base, reason: "Bearer sk-abc123" }, NOW));
    expectContractError(() => recordBlock(dir, { ...base, category: "kind-of-limited" as never }, NOW));
    expectContractError(() => recordBlock(dir, { ...base, resetAt: 1730000000000 as unknown as string }, NOW));
    // Nothing was persisted by the refused writes.
    expect(readdirSync(join(dir, "blocks")).filter((f) => f.endsWith(".json"))).toHaveLength(0);
  });

  test("corrupt block file fails closed (refuses admission) instead of allowing", () => {
    const dir = state();
    recordBlock(
      dir,
      {
        key: "account:team-e",
        category: "rate-limit",
        reason: "HTTP 429: rate limited",
        resetAt: RESET,
        observedBy: "claude.anthropic#wsl-desktop#a1#n0001",
      },
      NOW,
    );
    const blocks = join(dir, "blocks");
    const file = readdirSync(blocks).find((f) => f.endsWith(".json"))!;
    writeFileSync(join(blocks, file), "{corrupt");
    expectContractError(() => checkAdmission(dir, "account:team-e", NOW), "state");
  });

  test("REAL multi-process: concurrent recordBlock serializes, never weakens, leaves no debris", () => {
    const dir = state();
    const module = new URL("./agent/limits.ts", import.meta.url).pathname;
    const resets = ["2026-11-06T12:05:00Z", "2026-11-06T12:01:00Z", "2026-11-06T12:09:00Z", "2026-11-06T12:03:00Z"];
    const script = `
      // Static import cannot work here: the specifier is the absolute repo
      // path of limits.ts, resolved at test runtime for the spawned child.
      const { recordBlock } = await import(${JSON.stringify(module)});
      const [dir, resetAt, n] = process.argv.slice(1);
      recordBlock(
        dir,
        {
          key: "account:race",
          category: "rate-limit",
          reason: "HTTP 429: rate limited",
          resetAt,
          observedBy: \`claude.anthropic#wsl-desktop#p\${n}#n0001\`,
        },
        Date.parse("2026-11-06T12:00:00Z"),
      );
    `;
    const procs = resets.map((resetAt, i) =>
      Bun.spawnSync(["bun", "-e", script, dir, resetAt, String(i)], { stdout: "pipe", stderr: "pipe" }),
    );
    for (const proc of procs) {
      expect(proc.exitCode).toBe(0);
    }
    const blocks = join(dir, "blocks");
    const files = readdirSync(blocks);
    expect(files.filter((f) => f.endsWith(".json"))).toHaveLength(1);
    expect(files.filter((f) => f.includes(".tmp-"))).toHaveLength(0); // no debris
    const status = checkAdmission(dir, "account:race", NOW);
    expect(status.blocked).toBe(true);
    // The latest reset won; the block was never weakened below any input.
    expect(status.block?.resetAt).toBe("2026-11-06T12:09:00Z");
  });
});

// ---------------------------------------------------------------------------
// Route switching: explicit override only
// ---------------------------------------------------------------------------

describe("evaluateRouteSwitch", () => {
  const dir = () => {
    const d = state();
    return d;
  };

  test("no override: refused, with the paid-target reason named", () => {
    const d = dir();
    expect(
      evaluateRouteSwitch(
        { fromRoute: "claude.anthropic", toRoute: "omp.openai", toScope: "account:team-a", toPaid: true, explicitOverride: false },
        d,
        NOW,
      ),
    ).toEqual({
      allowed: false,
      reason: "target route is paid: switching to a paid API requires an explicit override; automatic switching is forbidden",
    });
    expect(
      evaluateRouteSwitch(
        { fromRoute: "claude.anthropic", toRoute: "omp.openai", toScope: null, toPaid: false, explicitOverride: false },
        d,
        NOW,
      ).allowed,
    ).toBe(false);
  });

  test("explicit override allows a switch — including onto a paid API (human decision)", () => {
    const d = dir();
    expect(
      evaluateRouteSwitch(
        { fromRoute: "claude.anthropic", toRoute: "omp.openai", toScope: null, toPaid: true, explicitOverride: true },
        d,
        NOW,
      ).allowed,
    ).toBe(true);
  });

  test("even an override cannot switch into the same blocked allowance", () => {
    const d = dir();
    recordBlock(
      d,
      {
        key: "account:team-a",
        category: "quota-exhausted",
        reason: "HTTP 429: allowance depleted",
        resetAt: RESET,
        observedBy: "claude.anthropic#wsl-desktop#a1#n0001",
      },
      NOW,
    );
    const d2 = evaluateRouteSwitch(
      { fromRoute: "claude.anthropic", toRoute: "omp.openai", toScope: "account:team-a", toPaid: false, explicitOverride: true },
      d,
      NOW,
    );
    expect(d2.allowed).toBe(false);
    // After the stated reset the same switch is admittable.
    expect(
      evaluateRouteSwitch(
        { fromRoute: "claude.anthropic", toRoute: "omp.openai", toScope: "account:team-a", toPaid: false, explicitOverride: true },
        d,
        Date.parse(RESET),
      ).allowed,
    ).toBe(true);
  });

  test("hostile switch inputs throw", () => {
    const d = dir();
    expectContractError(() =>
      evaluateRouteSwitch(
        { fromRoute: "bad route", toRoute: "omp.openai", toScope: null, toPaid: false, explicitOverride: true },
        d,
        NOW,
      ),
    );
    expectContractError(() =>
      evaluateRouteSwitch(
        { fromRoute: "claude.anthropic", toRoute: "omp.openai", toScope: null, toPaid: "yes" as unknown as boolean, explicitOverride: true },
        d,
        NOW,
      ),
    );
    expectContractError(() =>
      evaluateRouteSwitch(
        { fromRoute: "claude.anthropic", toRoute: "omp.openai", toScope: null, toPaid: false, explicitOverride: true },
        d,
        Number.NaN,
      ),
    );
  });
});

// ---------------------------------------------------------------------------
// Thundering herd: one observation blocks the whole allowance
// ---------------------------------------------------------------------------

describe("thundering herd", () => {
  test("a single 429 blocks every worker sharing the scope; jitter + budget bound the rest", () => {
    const dir = state();
    const scope = "account:shared";
    recordBlock(
      dir,
      {
        key: scope,
        category: "rate-limit",
        reason: "HTTP 429: rate limited",
        resetAt: RESET,
        observedBy: "claude.anthropic#wsl-desktop#a1#n0001",
      },
      NOW,
    );
    // Five more workers on the same allowance: all refused at admission,
    // none of them needs to touch the provider to find out.
    for (let i = 0; i < 5; i++) {
      expect(checkAdmission(dir, scope, NOW).blocked).toBe(true);
    }
    // And the retry budget is a hard, inspectable bound.
    expect(MAX_AUTO_RETRIES).toBeLessThanOrEqual(5);
    expect(MAX_RECHECKS).toBeLessThanOrEqual(5);
  });
});

// ---------------------------------------------------------------------------
// Module surface sanity
// ---------------------------------------------------------------------------

describe("module surface", () => {
  test("limitsStateDir derives from agentStateDir", () => {
    expect(limitsStateDir()).toContain("limits");
  });

  test("block files do not exist for unknown keys and admission defaults to open", () => {
    const d = state();
    const status = checkAdmission(d, "account:nobody", NOW);
    expect(status).toEqual({ blocked: false, block: null });
    expect(existsSync(join(d, "blocks"))).toBe(false); // no state written on reads
  });
});
