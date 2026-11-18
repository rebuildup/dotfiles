#!/usr/bin/env bun
/**
 * Tests for same-harness fallback execution (dotfiles#139, T021).
 */

import { describe, it, expect } from "bun:test";
import {
  classifyFailure,
  executeWithFallback,
  FallbackExhaustedError,
  FallbackExecutionState,
  type ClassifiedError,
  type LimitCategory,
  CATEGORY_FACTS,
  CATEGORY_SEVERITY,
  FALLBACK_CIRCUIT_BREAKER_THRESHOLD,
  FALLBACK_CIRCUIT_BREAKER_RESET_MS,
  FALLBACK_MAX_RETRIES_PER_CANDIDATE,
  FALLBACK_MAX_TOTAL_RETRIES,
} from "./agent/fallback-exec.ts";
import { loadConfig } from "./agent.ts";
import { ContractError, formatRouteId } from "./agent/contract.ts";
import { dirname, join } from "node:path";
import { realpathSync } from "node:fs";

/** Repo root, derived from this file's location (script/<file> -> repo). */
function repoRoot(): string {
  return dirname(dirname(realpathSync(import.meta.path)));
}

// ---------------------------------------------------------------------------
// Tests for classifyFailure (compatible with #92 limits.ts)
// ---------------------------------------------------------------------------

describe("classifyFailure", () => {
  const baseSignal = { quotaScopeKey: "test:scope" };

  it("classifies 429 with remaining 0 as quota-exhausted", () => {
    const result = classifyFailure({
      ...baseSignal,
      httpStatus: 429,
      usage: [{ metric: "requests", remaining: 0 }],
    }, "2026-11-12T00:00:00Z");
    expect(result.category).toBe("quota-exhausted");
    expect(result.exhausted).toBe(true);
    expect(result.reason).toBe("HTTP 429: allowance depleted (remaining 0 observed)");
  });

  it("classifies 429 with retry-after as rate-limit", () => {
    const result = classifyFailure({
      ...baseSignal,
      httpStatus: 429,
      retryAfterMs: 60000,
      usage: [{ metric: "requests", remaining: 10 }],
      resetAt: "2026-11-12T01:00:00Z",
    }, "2026-11-12T00:00:00Z");
    expect(result.category).toBe("rate-limit");
    expect(result.retryAfterMs).toBe(60000);
    expect(result.resetAt).not.toBeNull();
  });

  it("classifies 402 as billing (no reset)", () => {
    const result = classifyFailure({
      ...baseSignal,
      httpStatus: 402,
      resetAt: "2026-11-13T00:00:00Z", // should be ignored for billing
    }, "2026-11-12T00:00:00Z");
    expect(result.category).toBe("billing");
    expect(result.resetAt).toBeNull(); // billing never has reset
    expect(result.retryAfterMs).toBeNull();
  });

  it("classifies 401/403 as auth (no reset)", () => {
    const result = classifyFailure({
      ...baseSignal,
      httpStatus: 401,
    }, "2026-11-12T00:00:00Z");
    expect(result.category).toBe("auth");
    expect(result.resetAt).toBeNull();
    expect(result.retryAfterMs).toBeNull();
  });

  it("classifies 5xx as network", () => {
    const result = classifyFailure({
      ...baseSignal,
      httpStatus: 500,
    }, "2026-11-12T00:00:00Z");
    expect(result.category).toBe("network");
    expect(result.retryAfterMs).toBeNull(); // network has no retry-after in this impl
  });

  it("classifies 413 as context", () => {
    const result = classifyFailure({
      ...baseSignal,
      httpStatus: 413,
    }, "2026-11-12T00:00:00Z");
    expect(result.category).toBe("context");
  });

  it("classifies provider error kind: insufficient_quota -> billing", () => {
    const result = classifyFailure({
      ...baseSignal,
      httpStatus: 429,
      errorKind: "insufficient_quota",
      usage: [{ metric: "requests", remaining: 10 }],
    }, "2026-11-12T00:00:00Z");
    expect(result.category).toBe("billing");
  });

  it("classifies provider error kind: context_length_exceeded -> context", () => {
    const result = classifyFailure({
      ...baseSignal,
      httpStatus: 400,
      errorKind: "context_length_exceeded",
    }, "2026-11-12T00:00:00Z");
    expect(result.category).toBe("context");
  });

  it("classifies probe failure kind: timeout -> network", () => {
    const result = classifyFailure({
      ...baseSignal,
      failureKind: "timeout",
    }, "2026-11-12T00:00:00Z");
    expect(result.category).toBe("network");
  });

  it("classifies probe failure kind: payment -> billing", () => {
    const result = classifyFailure({
      ...baseSignal,
      failureKind: "payment",
    }, "2026-11-12T00:00:00Z");
    expect(result.category).toBe("billing");
  });

  it("classifies exit code 429 as rate-limit", () => {
    const result = classifyFailure({
      ...baseSignal,
      exitCode: 429,
    }, "2026-11-12T00:00:00Z");
    expect(result.category).toBe("rate-limit");
  });

  it("includes quota scope key", () => {
    const result = classifyFailure({
      ...baseSignal,
      httpStatus: 429,
      quotaScopeKey: "mistral:MISTRAL_API_KEY",
    }, "2026-11-12T00:00:00Z");
    expect(result.quotaScopeKey).toBe("mistral:MISTRAL_API_KEY");
  });

  it("validates observedAt format", () => {
    expect(() => classifyFailure(baseSignal, "invalid")).toThrow(ContractError);
  });

  it("rejects httpStatus < 400", () => {
    expect(() => classifyFailure({ ...baseSignal, httpStatus: 200 }, "2026-11-12T00:00:00Z")).toThrow(ContractError);
  });

  it("rejects unknown failureKind", () => {
    expect(() => classifyFailure({ ...baseSignal, failureKind: "unknown-kind" }, "2026-11-12T00:00:00Z")).toThrow(ContractError);
  });

  it("rejects malformed errorKind", () => {
    expect(() => classifyFailure({ ...baseSignal, errorKind: "bad@error" }, "2026-11-12T00:00:00Z")).toThrow(ContractError);
  });
});

// ---------------------------------------------------------------------------
// Category facts tests
// ---------------------------------------------------------------------------

describe("CATEGORY_FACTS", () => {
  it("billing is not transient, no reset, scope blocks", () => {
    const facts = CATEGORY_FACTS.billing;
    expect(facts.transient).toBe(false);
    expect(facts.resetPossible).toBe(false);
    expect(facts.scopeBlock).toBe(true);
    expect(facts.checkpointRecovery).toBe(false);
  });

  it("auth is not transient, no reset, scope blocks", () => {
    const facts = CATEGORY_FACTS.auth;
    expect(facts.transient).toBe(false);
    expect(facts.resetPossible).toBe(false);
  });

  it("rate-limit is transient with reset", () => {
    const facts = CATEGORY_FACTS["rate-limit"];
    expect(facts.transient).toBe(true);
    expect(facts.resetPossible).toBe(true);
  });

  it("quota-exhausted is transient with reset", () => {
    const facts = CATEGORY_FACTS["quota-exhausted"];
    expect(facts.transient).toBe(true);
    expect(facts.resetPossible).toBe(true);
  });

  it("network is transient but no reset, no scope block", () => {
    const facts = CATEGORY_FACTS.network;
    expect(facts.transient).toBe(true);
    expect(facts.resetPossible).toBe(false);
    expect(facts.scopeBlock).toBe(false);
  });

  it("context and model-invalid are terminal", () => {
    expect(CATEGORY_FACTS.context.transient).toBe(false);
    expect(CATEGORY_FACTS["model-invalid"].transient).toBe(false);
  });

  it("unknown is terminal fail-closed", () => {
    const facts = CATEGORY_FACTS.unknown;
    expect(facts.transient).toBe(false);
    expect(facts.resetPossible).toBe(false);
    expect(facts.scopeBlock).toBe(false);
    expect(facts.checkpointRecovery).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Severity tests
// ---------------------------------------------------------------------------

describe("CATEGORY_SEVERITY", () => {
  it("billing and auth are most severe (0)", () => {
    expect(CATEGORY_SEVERITY.billing).toBe(0);
    expect(CATEGORY_SEVERITY.auth).toBe(0);
  });

  it("quota-exhausted (1) < rate-limit (2) < concurrency (3)", () => {
    expect(CATEGORY_SEVERITY["quota-exhausted"]).toBeLessThan(CATEGORY_SEVERITY["rate-limit"]);
    expect(CATEGORY_SEVERITY["rate-limit"]).toBeLessThan(CATEGORY_SEVERITY.concurrency);
  });

  it("network (4) > concurrency (3)", () => {
    expect(CATEGORY_SEVERITY.network).toBeGreaterThan(CATEGORY_SEVERITY.concurrency);
  });
});

// ---------------------------------------------------------------------------
// executeWithFallback tests (structure only - requires full mocking)
// ---------------------------------------------------------------------------

describe("executeWithFallback", () => {
  it("has correct constants", () => {
    expect(FALLBACK_CIRCUIT_BREAKER_THRESHOLD).toBe(3);
    expect(FALLBACK_CIRCUIT_BREAKER_RESET_MS).toBe(60000);
    expect(FALLBACK_MAX_RETRIES_PER_CANDIDATE).toBe(2);
    expect(FALLBACK_MAX_TOTAL_RETRIES).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// Classification propagation: the classified failure must survive the
// executor, so a caller never has to re-derive "unknown" from a blank signal.
// ---------------------------------------------------------------------------

describe("FallbackExhaustedError", () => {
  const realConfigPath = join(repoRoot(), "config", "agents.toml");

  /** Run the executor against a real profile with a stub task function. */
  async function exhaustWith(
    profileId: string,
    error: Record<string, unknown>,
  ): Promise<FallbackExhaustedError> {
    const config = loadConfig(realConfigPath);
    try {
      await executeWithFallback(config, profileId, async () => ({ success: false, error }));
      throw new Error("expected executeWithFallback to exhaust every candidate");
    } catch (thrown) {
      if (!(thrown instanceof FallbackExhaustedError)) throw thrown;
      return thrown;
    }
  }

  it("carries the classified category for an auth failure", async () => {
    const exhausted = await exhaustWith("free-kilo-quota", {
      httpStatus: 403,
      exitCode: 403,
      failureKind: "forbidden",
      retryAfterMs: null,
      resetAt: null,
      usage: [],
      errorKind: "agent-blocked",
    });
    expect(exhausted.lastError?.category).toBe("auth");
  });

  it("carries the classified category for a network failure", async () => {
    const exhausted = await exhaustWith("free-kilo-quota", {
      httpStatus: 503,
      exitCode: 1,
      failureKind: "network",
      retryAfterMs: null,
      resetAt: null,
      usage: [],
      errorKind: "upstream-unavailable",
    });
    expect(exhausted.lastError?.category).toBe("network");
  });

  it("carries the classified category for a billing failure", async () => {
    const exhausted = await exhaustWith("free-kilo-quota", {
      httpStatus: 402,
      exitCode: 402,
      failureKind: "payment",
      retryAfterMs: null,
      resetAt: null,
      usage: [],
      errorKind: "insufficient_quota",
    });
    expect(exhausted.lastError?.category).toBe("billing");
  });

  it("is a ContractError so existing state handling still applies", async () => {
    const exhausted = await exhaustWith("free-kilo-quota", {
      httpStatus: 403,
      failureKind: "forbidden",
    });
    expect(exhausted).toBeInstanceOf(ContractError);
    expect(exhausted.code).toBe("state");
  });

  it("stops on an unrecognized failure instead of advancing the candidate", async () => {
    // An unknown failure is not evidence that another candidate would fare
    // better, so the executor must not keep switching accounts. This profile
    // has two usable candidates, so advancing is observable.
    const config = loadConfig(realConfigPath);
    let calls = 0;
    try {
      await executeWithFallback(config, "free-go-to-kilo", async () => {
        calls++;
        // No structured evidence: the classifier cannot place this failure.
        return { success: false, error: {} };
      });
      throw new Error("expected executeWithFallback to stop on an unknown failure");
    } catch (thrown) {
      if (!(thrown instanceof FallbackExhaustedError)) throw thrown;
      expect(thrown.lastError?.category).toBe("unknown");
    }
    expect(calls).toBe(1);
  });

  it("advances to the next candidate on a classified non-transient failure", async () => {
    // A classified failure (auth) is evidence about that route, so the
    // executor continues with the next authorized attempt. The primary is
    // tried first, then the profile's candidates.
    const config = loadConfig(realConfigPath);
    const routes: string[] = [];
    try {
      await executeWithFallback(config, "free-go-to-kilo", async (routeRef) => {
        routes.push(formatRouteId(routeRef));
        return {
          success: false,
          error: { httpStatus: 403, failureKind: "forbidden", retryAfterMs: null, resetAt: null, usage: [], errorKind: "agent-blocked" },
        };
      });
      throw new Error("expected executeWithFallback to exhaust every candidate");
    } catch (thrown) {
      if (!(thrown instanceof FallbackExhaustedError)) throw thrown;
      expect(thrown.lastError?.category).toBe("auth");
    }
    // The primary route first, then the profile's candidates in order.
    expect(routes).toEqual(["omp.opencode-go", "omp.kilo", "omp.groq"]);
  });
});
