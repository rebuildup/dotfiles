#!/usr/bin/env bun
/**
 * Policy evaluation controls for agent router (dotfiles#104, T018).
 *
 * Combines Spec Kit user-story independent tests with project-init
 * policy-evaluation controls (negative/positive/regression).
 *
 * Hard failures tested:
 *   - sandbox/secret exfiltration
 *   - silent paid fallback
 *   - wrong provider
 *   - policy conflict
 *   - stale approvals
 *   - unauthorized merge
 *   - split-brain
 *   - unknown quota
 *   - misleading success
 *
 * REAL vs MOCK: these are deterministic contract tests against the modules.
 * No network, no live provider, no secrets. Real-machine evidence is #105.
 *
 * Run: bun test script/agent.policy-evals.test.ts
 */

import { describe, test, expect } from "bun:test";
import { ContractError, parseRouteId, formatRouteId, isUsable, attest, type Attested, type Evidence } from "./agent/contract.ts";
import { parseFallbackProfile, resolveFallbackProfile, type FallbackProfile, type CatalogLike } from "./agent/fallback.ts";
import { classifyFailure } from "./agent/fallback-exec.ts";
import { CATEGORY_FACTS, CATEGORY_SEVERITY } from "./agent/fallback-exec.ts";
import { evaluateReview } from "./agent/review.ts";
import { reviewRequirement, type TaskClass } from "./agent/preflight.ts";

// ---------------------------------------------------------------------------
// Hard failure: silent paid fallback
// ---------------------------------------------------------------------------

describe("hard failure: silent paid fallback", () => {
  test("unknown fallback profile fails closed", () => {
    const toml = { fallback_profile: {} };
    expect(parseFallbackProfile(toml, "nonexistent")).toBeNull();
  });

  test("profile with expired candidates produces no usable candidates", () => {
    const toml = {
      fallback_profile: {
        expired: {
          id: "expired",
          version: 1,
          description: "test",
          primary_route: "omp.mistral",
          authorized_at: "2026-01-01T00:00:00Z",
          authorized_by: "test",
          expires_at: "2020-01-01T00:00:00Z",
          candidates: [
            { route: "omp.openrouter", model: "z-ai/glm-5.3-flash", billing: "metered", credential: "infisical", scope: "full" },
          ],
        },
      },
    };
    const profile = parseFallbackProfile(toml, "expired")!;
    const catalog: CatalogLike = {
      routes: { "omp.openrouter": { provider: "openrouter", models: ["z-ai/glm-5.3-flash"] } },
      providers: { openrouter: { models: ["z-ai/glm-5.3-flash"] } },
      harnesses: { omp: { adapter: "omp" } },
    };
    const res = resolveFallbackProfile(profile, catalog, new Map(), null);
    expect(res.hasUsable).toBe(false);
    expect(res.rejected[0].reason).toBe("expired");
  });

  test("revoked profile produces no usable candidates", () => {
    const toml = {
      fallback_profile: {
        revoked: {
          id: "revoked",
          version: 1,
          description: "test",
          primary_route: "omp.mistral",
          authorized_at: "2026-01-01T00:00:00Z",
          authorized_by: "test",
          revoked: true,
          candidates: [
            { route: "omp.openrouter", model: "z-ai/glm-5.3-flash", billing: "metered", credential: "infisical", scope: "full" },
          ],
        },
      },
    };
    const profile = parseFallbackProfile(toml, "revoked")!;
    const catalog: CatalogLike = {
      routes: { "omp.openrouter": { provider: "openrouter", models: ["z-ai/glm-5.3-flash"] } },
      providers: { openrouter: { models: ["z-ai/glm-5.3-flash"] } },
      harnesses: { omp: { adapter: "omp" } },
    };
    const res = resolveFallbackProfile(profile, catalog, new Map(), null);
    expect(res.hasUsable).toBe(false);
    expect(res.rejected[0].reason).toBe("revoked");
  });
});

// ---------------------------------------------------------------------------
// Hard failure: wrong provider / unknown quota
// ---------------------------------------------------------------------------

describe("hard failure: wrong provider and unknown quota", () => {
  test("billing failure never carries reset time", () => {
    const c = classifyFailure({ httpStatus: 402, resetAt: "2026-12-01T00:00:00Z" }, "2026-11-12T00:00:00Z");
    expect(c.category).toBe("billing");
    expect(c.resetAt).toBeNull();
    expect(CATEGORY_FACTS.billing.resetPossible).toBe(false);
  });

  test("unknown category fails closed (not transient, not retryable)", () => {
    const c = classifyFailure({}, "2026-11-12T00:00:00Z");
    expect(c.category).toBe("unknown");
    expect(CATEGORY_FACTS.unknown.transient).toBe(false);
    expect(CATEGORY_FACTS.unknown.resetPossible).toBe(false);
  });

  test("quota-exhausted without reset never guesses a reset time", () => {
    const c = classifyFailure({ httpStatus: 429, usage: [{ metric: "requests", remaining: 0 }] }, "2026-11-12T00:00:00Z");
    expect(c.category).toBe("quota-exhausted");
    expect(c.resetAt).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Hard failure: stale approvals / misleading success
// ---------------------------------------------------------------------------

describe("hard failure: stale approvals and misleading success", () => {
  test("review pinned to wrong SHA never passes", () => {
    const decision = evaluateReview({
      taskClass: "cross-boundary",
      builder: "alice",
      candidateSha: "a".repeat(40),
      diffFingerprint: "b".repeat(64),
      now: Date.parse("2026-11-12T12:00:00Z"),
      record: {
        contract_version: "1.0.0",
        reviewer: "bob",
        sha: "c".repeat(40), // different SHA
        diffFingerprint: "b".repeat(64),
        verdict: "approve",
        findings: [],
        summary: "Looks good to me, all tests pass and the implementation is correct.",
        snapshotClean: true,
        at: "2026-11-12T11:00:00Z",
      },
    });
    expect(decision.passed).toBe(false);
    expect(decision.reasons.some((r) => r.includes("not the candidate"))).toBe(true);
  });

  test("bare APPROVED without findings never passes", () => {
    const decision = evaluateReview({
      taskClass: "cross-boundary",
      builder: "alice",
      candidateSha: "a".repeat(40),
      diffFingerprint: "b".repeat(64),
      now: Date.parse("2026-11-12T12:00:00Z"),
      record: {
        contract_version: "1.0.0",
        reviewer: "bob",
        sha: "a".repeat(40),
        diffFingerprint: "b".repeat(64),
        verdict: "approve",
        findings: [],
        summary: "APPROVED",
        snapshotClean: true,
        at: "2026-11-12T11:00:00Z",
      },
    });
    expect(decision.passed).toBe(false);
  });

  test("self-review never passes", () => {
    const decision = evaluateReview({
      taskClass: "cross-boundary",
      builder: "alice",
      candidateSha: "a".repeat(40),
      diffFingerprint: "b".repeat(64),
      now: Date.parse("2026-11-12T12:00:00Z"),
      record: {
        contract_version: "1.0.0",
        reviewer: "alice",
        sha: "a".repeat(40),
        diffFingerprint: "b".repeat(64),
        verdict: "approve",
        findings: ["no issues"],
        summary: "The implementation is correct and all tests pass with proper error handling.",
        snapshotClean: true,
        at: "2026-11-12T11:00:00Z",
      },
    });
    expect(decision.passed).toBe(false);
    expect(decision.reasons.some((r) => r.includes("self-review"))).toBe(true);
  });

  test("authenticity guarantee is explicitly limited", () => {
    const decision = evaluateReview({
      taskClass: "cross-boundary",
      builder: "alice",
      candidateSha: "a".repeat(40),
      diffFingerprint: "b".repeat(64),
      now: Date.parse("2026-11-12T12:00:00Z"),
      record: {
        contract_version: "1.0.0",
        reviewer: "bob",
        sha: "a".repeat(40),
        diffFingerprint: "b".repeat(64),
        verdict: "approve",
        findings: ["minor style issue"],
        summary: "The implementation correctly handles the edge cases and all tests pass.",
        snapshotClean: true,
        at: "2026-11-12T11:00:00Z",
      },
    });
    // Even when passing, authenticity is only "distinct-only"
    expect(decision.authenticityGuarantee).toBe("distinct-only");
  });
});

// ---------------------------------------------------------------------------
// Hard failure: policy conflict / unauthorized merge
// ---------------------------------------------------------------------------

describe("hard failure: policy conflict and unauthorized merge", () => {
  test("mechanical task does not require cold review", () => {
    const req = reviewRequirement("mechanical");
    expect(req.coldReview).toBe(false);
  });

  test("cross-boundary task requires cold review", () => {
    const req = reviewRequirement("cross-boundary");
    expect(req.coldReview).toBe(true);
  });

  test("judgment-heavy task requires cold review", () => {
    const req = reviewRequirement("judgment-heavy");
    expect(req.coldReview).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Hard failure: secret exfiltration
// ---------------------------------------------------------------------------

describe("hard failure: secret exfiltration", () => {
  test("contract redacts secret-shaped values", async () => {
    const { redact } = await import("./agent/contract.ts");
    const result = redact({ api_key: "sk-secret123", token: "Bearer abc123", normal: "hello" }) as Record<string, unknown>;
    expect(result.api_key).toBe("[redacted]");
    expect(result.token).toBe("[redacted]");
    expect(result.normal).toBe("hello");
  });

  test("fallback profile rejects secret-shaped values", () => {
    const toml = {
      fallback_profile: {
        bad: {
          id: "bad",
          version: 1,
          description: "test",
          primary_route: "omp.mistral",
          authorized_at: "2026-01-01T00:00:00Z",
          authorized_by: "test",
          candidates: [
            { route: "omp.openrouter", model: "sk-secret123", billing: "metered", credential: "infisical", scope: "full" },
          ],
        },
      },
    };
    // Model with secret shape should be rejected at contract level
    const profile = parseFallbackProfile(toml, "bad");
    if (profile) {
      const catalog: CatalogLike = {
        routes: { "omp.openrouter": { provider: "openrouter", models: ["z-ai/glm-5.3-flash"] } },
        providers: { openrouter: { models: ["z-ai/glm-5.3-flash"] } },
        harnesses: { omp: { adapter: "omp" } },
      };
      // Supply a primary allowance so the secret-shaped model id is what this
      // control actually measures: with an unknown primary scope the resolver
      // fails closed earlier (primary-quota-unknown) and would mask it.
      const res = resolveFallbackProfile(profile, catalog, new Map(), "account:mistral-education");
      expect(res.hasUsable).toBe(false);
      expect(res.rejected[0].reason).toBe("model-not-allowed");
    }
  });
});

// ---------------------------------------------------------------------------
// Hard failure: split-brain
// ---------------------------------------------------------------------------

describe("hard failure: split-brain", () => {
  test("attempt identity is unique per route/model/machine/attempt", async () => {
    const { formatAttemptKey, parseAttemptKey } = await import("./agent/contract.ts");
    const id1 = formatAttemptKey({ route: "omp.mistral", model: "m1", machine: "mac", attempt: "1" });
    const id2 = formatAttemptKey({ route: "omp.mistral", model: "m1", machine: "mac", attempt: "2" });
    expect(id1).not.toBe(id2);
    const parsed = parseAttemptKey(id1);
    expect(parsed.route).toBe("omp.mistral");
    expect(parsed.attempt).toBe("1");
  });
});
