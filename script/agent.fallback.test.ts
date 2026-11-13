#!/usr/bin/env bun
/**
 * Tests for opt-in continuity profile (dotfiles#136, T020).
 */

import { describe, it, expect } from "bun:test";
import {
  parseFallbackProfile,
  listFallbackProfiles,
  resolveFallbackProfile,
  renderFallbackResolution,
  seedAttestationsFromCatalog,
  mergeAttestations,
  buildFallbackCatalog,
  effectiveRouteQuotaKey,
  type FallbackCatalogFacts,
  type FallbackConfigLike,
  type FallbackRejectionReason,
  type FallbackProfile,
  type FallbackCandidate,
  type CatalogLike,
} from "./agent/fallback.ts";
import { ContractError } from "./agent/contract.ts";
import { attest, type Attested, type Evidence, type VerificationStatus, type Provenance, type EvidenceSource } from "./agent/contract.ts";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const MOCK_TOML = {
  fallback_profile: {
    "test-profile": {
      id: "test-profile",
      version: 1,
      description: "Test fallback for omp.mistral",
      primary_route: "omp.mistral",
      authorized_at: "2026-11-12T00:00:00Z",
      authorized_by: "test-user",
      expires_at: "2026-12-31T23:59:59Z",
      revoked: false,
      global_max_spend: 100,
      candidates: [
        {
          route: "omp.openrouter",
          model: "z-ai/glm-5.3-flash",
          billing: "metered",
          credential: "infisical",
          max_spend: 50,
          scope: "local-writes",
          note: "Primary paid fallback",
        },
        {
          route: "omp.openrouter-free",
          model: "nvidia/nemotron-3-ultra-550b-a55b:free",
          billing: "free",
          credential: "infisical",
          max_spend: 0,
          scope: "read-only",
          note: "Free tier fallback",
        },
      ],
    },
    "expired-profile": {
      id: "expired-profile",
      version: 1,
      description: "Expired profile",
      primary_route: "omp.deepseek",
      authorized_at: "2026-11-12T00:00:00Z",
      authorized_by: "test-user",
      expires_at: "2026-11-11T23:59:59Z", // yesterday
      revoked: false,
      candidates: [
        {
          route: "omp.openrouter",
          model: "z-ai/glm-5.3-flash",
          billing: "metered",
          credential: "infisical",
          scope: "full",
        },
      ],
    },
    "revoked-profile": {
      id: "revoked-profile",
      version: 1,
      description: "Revoked profile",
      primary_route: "omp.minimax",
      authorized_at: "2026-11-12T00:00:00Z",
      authorized_by: "test-user",
      revoked: true,
      candidates: [
        {
          route: "omp.openrouter",
          model: "z-ai/glm-5.3-flash",
          billing: "metered",
          credential: "infisical",
          scope: "full",
        },
      ],
    },
  },
};

const MOCK_CATALOG: CatalogLike = {
  routes: {
    "omp.mistral": { provider: "mistral", models: ["zai-glm-5-3-flash"], require_model: true },
    "omp.openrouter": { provider: "openrouter", models: ["z-ai/glm-5.3-flash"], require_model: false },
    "omp.openrouter-free": { provider: "openrouter-free", models: ["nvidia/nemotron-3-ultra-550b-a55b:free"], require_model: true },
    "omp.deepseek": { provider: "deepseek", models: ["deepseek-flash", "deepseek-v4-pro"] },
    "omp.minimax": { provider: "minimax", models: ["MiniMax-M3.1-Flash"] },
    "omp.opencode-go": { provider: "opencode-go", models: ["mimo-v2.6-flash", "deepseek-v4.1-flash"], require_infisical: true },
    // Free-tier routes from ADR-0018, used by the billing/scope cases below.
    "omp.kilo": { provider: "kilo", models: ["nvidia/nemotron-3-ultra-550b-a55b:free"] },
    "omp.groq": { provider: "groq", models: ["openai/gpt-oss-120b"] },
  },
  providers: {
    mistral: {
      models: ["zai-glm-5-3-flash", "deepseek-v4-1-flash-1017"],
      require_infisical: true,
      billing: "subscription",
      quota_scope: "account:mistral-education",
    },
    openrouter: {
      models: ["z-ai/glm-5.3-flash"],
      billing: "metered",
      quota_scope: "account:openrouter",
    },
    "openrouter-free": {
      models: ["nvidia/nemotron-3-ultra-550b-a55b:free"],
      billing: "free",
      // Shares the paid account's allowance: not independent capacity.
      quota_scope: "account:openrouter",
    },
    deepseek: {
      models: ["deepseek-flash", "deepseek-v4-pro"],
      billing: "metered",
      quota_scope: "account:deepseek",
    },
    minimax: {
      models: ["MiniMax-M3.1-Flash", "MiniMax-M3"],
      billing: "subscription",
      quota_scope: "plan:minimax-m-plan",
    },
    "opencode-go": {
      models: ["mimo-v2.6-flash", "deepseek-v4.1-flash"],
      require_infisical: true,
      billing: "subscription",
      quota_scope: "plan:opencode-go",
    },
    kilo: {
      models: ["nvidia/nemotron-3-ultra-550b-a55b:free"],
      billing: "free",
      quota_scope: "account:kilo",
    },
    groq: {
      models: ["openai/gpt-oss-120b"],
      billing: "free",
      quota_scope: "account:groq",
    },
  },
  harnesses: {
    omp: { adapter: "omp" },
  },
};

function makeAttestation(
  status: VerificationStatus,
  provenance: Provenance,
  source: EvidenceSource = "live-e2e"
): Attested<{ status: VerificationStatus; provenance: Provenance; evidence: Evidence }> {
  const evidence: Evidence = {
    at: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(), // 1 day ago
    source,
    sha: "a".repeat(40),
  };
  return attest({
    value: { status, provenance, evidence },
    status: "verified-live",
    provenance: "measured",
    evidence,
  });
}

function makeStaleAttestation(
  status: VerificationStatus,
  provenance: Provenance
): Attested<{ status: VerificationStatus; provenance: Provenance; evidence: Evidence }> {
  const evidence: Evidence = {
    at: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString(), // 10 days ago (stale)
    source: "live-e2e",
    sha: "b".repeat(40),
  };
  return attest({
    value: { status, provenance, evidence },
    status: "verified-live",
    provenance: "measured",
    evidence,
  });
}

const MOCK_ATTESTATIONS = new Map<string, Attested<{ status: VerificationStatus; provenance: Provenance; evidence: Evidence }>>([
  ["omp.openrouter#z-ai/glm-5.3-flash", makeAttestation("verified-live", "measured")],
  ["omp.openrouter-free#nvidia/nemotron-3-ultra-550b-a55b:free", makeAttestation("verified-live", "measured")],
  ["omp.deepseek#deepseek-flash", makeAttestation("restricted", "measured")], // 402 restricted
  ["omp.minimax#MiniMax-M3.1-Flash", makeAttestation("unknown", "estimated")], // unknown
  ["omp.opencode-go#mimo-v2.6-flash", makeStaleAttestation("verified-live", "measured")], // stale
]);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("parseFallbackProfile", () => {
  it("parses a valid profile", () => {
    const profile = parseFallbackProfile(MOCK_TOML, "test-profile");
    expect(profile).not.toBeNull();
    expect(profile!.id).toBe("test-profile");
    expect(profile!.version).toBe(1);
    expect(profile!.primaryRoute).toBe("omp.mistral");
    expect(profile!.candidates).toHaveLength(2);
    expect(profile!.candidates[0].route).toBe("omp.openrouter");
    expect(profile!.candidates[0].model).toBe("z-ai/glm-5.3-flash");
    expect(profile!.candidates[0].billing).toBe("metered");
    expect(profile!.candidates[0].credential).toBe("infisical");
    expect(profile!.candidates[0].maxSpend).toBe(50);
    expect(profile!.candidates[0].scope).toBe("local-writes");
  });

  it("returns null for non-existent profile", () => {
    const profile = parseFallbackProfile(MOCK_TOML, "non-existent");
    expect(profile).toBeNull();
  });

  it("rejects mismatched id", () => {
    const badToml = {
      fallback_profile: {
        bad: { ...MOCK_TOML.fallback_profile["test-profile"], id: "mismatch" },
      },
    };
    expect(() => parseFallbackProfile(badToml, "bad")).toThrow(ContractError);
  });

  it("rejects missing required fields", () => {
    const badToml = {
      fallback_profile: {
        incomplete: { id: "incomplete", version: 1 }, // missing primary_route, etc.
      },
    };
    expect(() => parseFallbackProfile(badToml, "incomplete")).toThrow(ContractError);
  });

  it("rejects invalid billing boundary", () => {
    const baseProfile = MOCK_TOML.fallback_profile["test-profile"];
    const badToml = {
      fallback_profile: {
        bad: {
          ...baseProfile,
          candidates: [{ ...baseProfile.candidates[0], billing: "invalid" }],
        },
      },
    };
    expect(() => parseFallbackProfile(badToml, "bad")).toThrow(ContractError);
  });

  it("rejects invalid credential source", () => {
    const baseProfile = MOCK_TOML.fallback_profile["test-profile"];
    const badToml = {
      fallback_profile: {
        bad: {
          ...baseProfile,
          candidates: [{ ...baseProfile.candidates[0], credential: "invalid" }],
        },
      },
    };
    expect(() => parseFallbackProfile(badToml, "bad")).toThrow(ContractError);
  });

  it("rejects invalid scope", () => {
    const baseProfile = MOCK_TOML.fallback_profile["test-profile"];
    const badToml = {
      fallback_profile: {
        bad: {
          ...baseProfile,
          candidates: [{ ...baseProfile.candidates[0], scope: "invalid" }],
        },
      },
    };
    expect(() => parseFallbackProfile(badToml, "bad")).toThrow(ContractError);
  });

  it("rejects empty candidates array", () => {
    const baseProfile = MOCK_TOML.fallback_profile["test-profile"];
    const badToml = {
      fallback_profile: {
        bad: { ...baseProfile, candidates: [] },
      },
    };
    expect(() => parseFallbackProfile(badToml, "bad")).toThrow(ContractError);
  });

  it("rejects negative max_spend", () => {
    const baseProfile = MOCK_TOML.fallback_profile["test-profile"];
    const badToml = {
      fallback_profile: {
        bad: {
          ...baseProfile,
          candidates: [{ ...baseProfile.candidates[0], max_spend: -1 }],
        },
      },
    };
    expect(() => parseFallbackProfile(badToml, "bad")).toThrow(ContractError);
  });
});

describe("listFallbackProfiles", () => {
  it("lists all profile IDs", () => {
    const ids = listFallbackProfiles(MOCK_TOML);
    expect(ids).toEqual(["expired-profile", "revoked-profile", "test-profile"]);
  });

  it("returns empty array for no profiles", () => {
    expect(listFallbackProfiles({})).toEqual([]);
  });
});

const BASE_PROFILE = parseFallbackProfile(MOCK_TOML, "test-profile")!;

// A resolvable primary allowance. Candidate-level tests must supply one: a
// null primary scope now fails closed with `primary-quota-unknown`, so using
// null here would test the wrong rejection.
const MOCK_PRIMARY_SCOPE = "account:mistral-education";

describe("resolveFallbackProfile", () => {
  it("resolves a valid profile with usable candidates", () => {
    const resolution = resolveFallbackProfile(BASE_PROFILE, MOCK_CATALOG, MOCK_ATTESTATIONS, "account:mistral-education");

    expect(resolution.hasUsable).toBe(true);
    // Both candidates should be usable (different routes, valid attestations)
    expect(resolution.usable.length).toBeGreaterThanOrEqual(1);
    expect(resolution.usable[0].candidate.route).toBe("omp.openrouter");
    // Second candidate may be rejected if it shares quota scope with first (same provider)
    // but since primary is mistral, both openrouter candidates should pass quota check
  });

  it("rejects expired profile", () => {
    const profile = parseFallbackProfile(MOCK_TOML, "expired-profile")!;
    const resolution = resolveFallbackProfile(profile, MOCK_CATALOG, MOCK_ATTESTATIONS, MOCK_PRIMARY_SCOPE);

    expect(resolution.hasUsable).toBe(false);
    expect(resolution.usable).toHaveLength(0);
    expect(resolution.rejected[0].reason).toBe("expired");
  });

  it("rejects revoked profile", () => {
    const profile = parseFallbackProfile(MOCK_TOML, "revoked-profile")!;
    const resolution = resolveFallbackProfile(profile, MOCK_CATALOG, MOCK_ATTESTATIONS, MOCK_PRIMARY_SCOPE);

    expect(resolution.hasUsable).toBe(false);
    expect(resolution.rejected[0].reason).toBe("revoked");
  });

  it("rejects candidate with non-existent route", () => {
    const profile: FallbackProfile = {
      ...BASE_PROFILE,
      candidates: [{ ...BASE_PROFILE.candidates[0], route: "omp.nonexistent" }],
    };
    const resolution = resolveFallbackProfile(profile, MOCK_CATALOG, MOCK_ATTESTATIONS, MOCK_PRIMARY_SCOPE);

    expect(resolution.rejected[0].reason).toBe("route-not-configured");
  });

  it("rejects candidate with disallowed model", () => {
    const profile: FallbackProfile = {
      ...BASE_PROFILE,
      candidates: [{ ...BASE_PROFILE.candidates[0], model: "invalid-model" }],
    };
    const resolution = resolveFallbackProfile(profile, MOCK_CATALOG, MOCK_ATTESTATIONS, MOCK_PRIMARY_SCOPE);

    expect(resolution.rejected[0].reason).toBe("model-not-allowed");
  });

  it("rejects candidate with credential mismatch (requires infisical but not authorized)", () => {
    const profile: FallbackProfile = {
      ...BASE_PROFILE,
      candidates: [{ ...BASE_PROFILE.candidates[0], route: "omp.opencode-go", model: "mimo-v2.6-flash", credential: "env-file" }],
    };
    const resolution = resolveFallbackProfile(profile, MOCK_CATALOG, MOCK_ATTESTATIONS, MOCK_PRIMARY_SCOPE);

    expect(resolution.rejected[0].reason).toBe("credential-mismatch");
  });

  it("rejects candidate sharing exhausted quota scope with primary", () => {
    // Add attestation for the mistral candidate
    const attestationsWithMistral = new Map(MOCK_ATTESTATIONS);
    attestationsWithMistral.set("omp.mistral#zai-glm-5-3-flash", makeAttestation("verified-live", "measured"));
    const profile: FallbackProfile = {
      ...BASE_PROFILE,
      candidates: [{
        ...BASE_PROFILE.candidates[0],
        route: "omp.mistral",
        model: "zai-glm-5-3-flash",
        billing: "subscription",
      }],
    };
    const resolution = resolveFallbackProfile(profile, MOCK_CATALOG, attestationsWithMistral, "account:mistral-education");

    expect(resolution.rejected[0].reason).toBe("quota-exhausted-scope");
  });

  it("rejects candidate with restricted attestation (402/403/429)", () => {
    const profile: FallbackProfile = {
      ...BASE_PROFILE,
      candidates: [{ ...BASE_PROFILE.candidates[0], route: "omp.deepseek", model: "deepseek-flash" }],
    };
    const resolution = resolveFallbackProfile(profile, MOCK_CATALOG, MOCK_ATTESTATIONS, MOCK_PRIMARY_SCOPE);

    expect(resolution.rejected[0].reason).toBe("attestation-restricted");
  });

  it("rejects candidate with unknown attestation", () => {
    const profile: FallbackProfile = {
      ...BASE_PROFILE,
      candidates: [{
        ...BASE_PROFILE.candidates[0],
        route: "omp.minimax",
        model: "MiniMax-M3.1-Flash",
        billing: "subscription",
      }],
    };
    const resolution = resolveFallbackProfile(profile, MOCK_CATALOG, MOCK_ATTESTATIONS, MOCK_PRIMARY_SCOPE);

    expect(resolution.rejected[0].reason).toBe("attestation-unknown");
  });

  it("rejects candidate with stale attestation", () => {
    const profile: FallbackProfile = {
      ...BASE_PROFILE,
      candidates: [{
        ...BASE_PROFILE.candidates[0],
        route: "omp.opencode-go",
        model: "mimo-v2.6-flash",
        billing: "subscription",
      }],
    };
    const resolution = resolveFallbackProfile(profile, MOCK_CATALOG, MOCK_ATTESTATIONS, MOCK_PRIMARY_SCOPE);

    expect(resolution.rejected[0].reason).toBe("attestation-stale");
  });

  it("rejects candidate sharing exhausted quota scope with primary", () => {
    // Add attestation for the mistral candidate
    const attestationsWithMistral = new Map(MOCK_ATTESTATIONS);
    attestationsWithMistral.set("omp.mistral#zai-glm-5-3-flash", makeAttestation("verified-live", "measured"));
    const profile: FallbackProfile = {
      ...BASE_PROFILE,
      candidates: [{
        ...BASE_PROFILE.candidates[0],
        route: "omp.mistral",
        model: "zai-glm-5-3-flash",
        billing: "subscription",
      }],
    };
    const resolution = resolveFallbackProfile(profile, MOCK_CATALOG, attestationsWithMistral, "account:mistral-education");

    expect(resolution.rejected[0].reason).toBe("quota-exhausted-scope");
  });

  it("enforces global max spend", () => {
    // Two PAID candidates so the global cap actually binds: a free candidate
    // may not declare a positive cap (that would authorise spend on a
    // zero-cost route) and is no longer usable for this check.
    const profile: FallbackProfile = {
      ...BASE_PROFILE,
      globalMaxSpend: 30, // less than the sum of candidate caps (20 + 20)
      candidates: [
        { ...BASE_PROFILE.candidates[0], route: "omp.openrouter", maxSpend: 20 },
        { ...BASE_PROFILE.candidates[0], route: "omp.deepseek", model: "deepseek-v4-pro", maxSpend: 20 },
      ],
    };
    const attestations = new Map(MOCK_ATTESTATIONS);
    attestations.set("omp.deepseek#deepseek-v4-pro", makeAttestation("verified-live", "measured"));
    const resolution = resolveFallbackProfile(profile, MOCK_CATALOG, attestations, MOCK_PRIMARY_SCOPE);

    // Second candidate should be rejected due to global cap
    expect(resolution.usable).toHaveLength(1);
    expect(resolution.rejected.some((r) => r.reason === "spend-cap-exceeded")).toBe(true);
  });

  it("rejects candidate with expired candidate-level expiration", () => {
    const profile: FallbackProfile = {
      ...BASE_PROFILE,
      candidates: [
        { ...BASE_PROFILE.candidates[0], expiresAt: "2020-01-01T00:00:00Z" }, // long expired
      ],
    };
    const resolution = resolveFallbackProfile(profile, MOCK_CATALOG, MOCK_ATTESTATIONS, MOCK_PRIMARY_SCOPE);

    expect(resolution.rejected[0].reason).toBe("expired");
  });
});

describe("renderFallbackResolution", () => {
  it("renders a human-readable summary", () => {
    const resolution = resolveFallbackProfile(BASE_PROFILE, MOCK_CATALOG, MOCK_ATTESTATIONS, "account:mistral-education");
    const output = renderFallbackResolution(resolution);

    expect(output).toContain("Fallback Profile: test-profile");
    expect(output).toContain("Primary Route: omp.mistral");
    expect(output).toContain("STATUS: USABLE");
    expect(output).toContain("Usable candidates");
    expect(output).toContain("omp.openrouter");
  });

  it("shows REVOKED status for revoked profile", () => {
    const profile = parseFallbackProfile(MOCK_TOML, "revoked-profile")!;
    const resolution = resolveFallbackProfile(profile, MOCK_CATALOG, MOCK_ATTESTATIONS, MOCK_PRIMARY_SCOPE);
    const output = renderFallbackResolution(resolution);

    expect(output).toContain("STATUS: REVOKED");
  });

  it("shows EXPIRED status for expired profile", () => {
    const profile = parseFallbackProfile(MOCK_TOML, "expired-profile")!;
    const resolution = resolveFallbackProfile(profile, MOCK_CATALOG, MOCK_ATTESTATIONS, MOCK_PRIMARY_SCOPE);
    const output = renderFallbackResolution(resolution);

    expect(output).toContain("STATUS: EXPIRED");
  });
});

// ---------------------------------------------------------------------------
// Anti-paid-drift guarantees (ADR-0018). A free profile must never reach a
// paying endpoint through a labelling mistake, and a candidate that cannot be
// proven independent must not be counted as fresh capacity.
// ---------------------------------------------------------------------------

describe("resolveFallbackProfile: no paid drift", () => {
  const withKilo = (overrides: Partial<FallbackCandidate> = {}): FallbackProfile => ({
    ...BASE_PROFILE,
    globalMaxSpend: 0,
    candidates: [
      {
        route: "omp.kilo",
        model: "nvidia/nemotron-3-ultra-550b-a55b:free",
        billing: "free",
        credential: "infisical",
        maxSpend: 0,
        scope: "read-only",
        ...overrides,
      },
    ],
  });

  const kiloAttestations = (): typeof MOCK_ATTESTATIONS => {
    const map = new Map(MOCK_ATTESTATIONS);
    map.set(
      "omp.kilo#nvidia/nemotron-3-ultra-550b-a55b:free",
      makeAttestation("verified-live", "measured"),
    );
    map.set("omp.groq#openai/gpt-oss-120b", makeAttestation("verified-live", "measured"));
    return map;
  };

  it("accepts a free candidate on a catalogued free provider", () => {
    const resolution = resolveFallbackProfile(
      withKilo(),
      MOCK_CATALOG,
      kiloAttestations(),
      "account:mistral-education",
    );
    expect(resolution.hasUsable).toBe(true);
    expect(resolution.usable[0].candidate.route).toBe("omp.kilo");
  });

  it("rejects a free-labelled candidate whose provider is metered", () => {
    // The dangerous mislabelling: declare `free` and point at a paid route.
    const resolution = resolveFallbackProfile(
      withKilo({ route: "omp.openrouter", model: "z-ai/glm-5.3-flash", billing: "free" }),
      MOCK_CATALOG,
      MOCK_ATTESTATIONS,
      MOCK_PRIMARY_SCOPE,
    );
    expect(resolution.hasUsable).toBe(false);
    expect(resolution.rejected[0].reason).toBe("billing-boundary-crossed");
  });

  it("rejects a metered candidate on a free provider", () => {
    const resolution = resolveFallbackProfile(
      withKilo({ billing: "metered" }),
      MOCK_CATALOG,
      kiloAttestations(),
      MOCK_PRIMARY_SCOPE,
    );
    expect(resolution.hasUsable).toBe(false);
    expect(resolution.rejected[0].reason).toBe("billing-boundary-crossed");
  });

  it("rejects any candidate whose provider billing is not catalogued", () => {
    // An uncatalogued provider has an UNKNOWN billing model. Treating that as
    // free is exactly the implicit paid path this check exists to stop.
    const catalog: CatalogLike = {
      ...MOCK_CATALOG,
      providers: { ...MOCK_CATALOG.providers },
    };
    delete catalog.providers.kilo;
    // Keep the route resolvable so billing is the only failing check.
    catalog.routes = { ...catalog.routes, "omp.kilo": { provider: "unlisted" } };
    catalog.providers.unlisted = {
      models: ["nvidia/nemotron-3-ultra-550b-a55b:free"],
      quota_scope: "account:unlisted",
    };
    const profile: FallbackProfile = {
      ...withKilo(),
      candidates: [{ ...withKilo().candidates[0], route: "omp.kilo" }],
    };
    const resolution = resolveFallbackProfile(profile, catalog, kiloAttestations(), MOCK_PRIMARY_SCOPE);

    expect(resolution.hasUsable).toBe(false);
    expect(resolution.rejected[0].reason).toBe("billing-unknown");
  });

  it("rejects every candidate when the primary allowance is unknown", () => {
    // No primary scope means the independence check cannot run at all. Skipping
    // it would let a candidate be counted as fresh capacity with no evidence
    // that it is not drawing on the exhausted primary's allowance.
    const resolution = resolveFallbackProfile(
      withKilo(),
      MOCK_CATALOG,
      kiloAttestations(),
      null,
    );
    expect(resolution.hasUsable).toBe(false);
    expect(resolution.rejected).toHaveLength(1);
    expect(resolution.rejected[0].reason).toBe("primary-quota-unknown");
  });

  it("rejects a candidate under a provider-wide restriction", () => {
    // The provider is observed restricted (e.g. a free tier bound to one
    // client) while the route itself carries fresh e2e evidence. The route
    // must still be rejected: route-level evidence cannot unlock a provider
    // whose allowance is unusable.
    const catalog: CatalogLike = {
      ...MOCK_CATALOG,
      providers: {
        ...MOCK_CATALOG.providers,
        kilo: { ...MOCK_CATALOG.providers.kilo, restricted: true },
      },
    };
    const resolution = resolveFallbackProfile(
      withKilo(),
      catalog,
      kiloAttestations(),
      MOCK_PRIMARY_SCOPE,
    );
    expect(resolution.hasUsable).toBe(false);
    expect(resolution.rejected[0].reason).toBe("provider-restricted");
  });

  it("compares a candidate by its OWN route quota, not its provider's", () => {
    // The candidate route declares an independent scope that overrides the
    // provider scope (same rule as effectiveQuotaKey). Comparing only the
    // provider scope would reject this genuinely independent candidate.
    const catalog: CatalogLike = {
      ...MOCK_CATALOG,
      routes: {
        ...MOCK_CATALOG.routes,
        "omp.kilo": { ...MOCK_CATALOG.routes["omp.kilo"], quota_scope: "account:kilo-dedicated" },
      },
      // Provider scope deliberately collides with the primary.
      providers: {
        ...MOCK_CATALOG.providers,
        kilo: { ...MOCK_CATALOG.providers.kilo, quota_scope: "account:kilo" },
      },
    };
    const resolution = resolveFallbackProfile(
      withKilo(),
      catalog,
      kiloAttestations(),
      "account:kilo",
    );
    expect(resolution.hasUsable).toBe(true);
    expect(resolution.usable[0].candidate.route).toBe("omp.kilo");
  });

  it("rejects a candidate whose route quota equals the primary allowance", () => {
    // The inverse: a route override that resolves to the primary's allowance is
    // the same exhausted budget even though the provider scope differs.
    const catalog: CatalogLike = {
      ...MOCK_CATALOG,
      routes: {
        ...MOCK_CATALOG.routes,
        "omp.kilo": { ...MOCK_CATALOG.routes["omp.kilo"], quota_scope: "account:shared-with-primary" },
      },
    };
    const resolution = resolveFallbackProfile(
      withKilo(),
      catalog,
      kiloAttestations(),
      "account:shared-with-primary",
    );
    expect(resolution.hasUsable).toBe(false);
    expect(resolution.rejected[0].reason).toBe("quota-exhausted-scope");
  });

  it("rejects a free candidate that declares a positive spend cap", () => {
    const resolution = resolveFallbackProfile(
      withKilo({ maxSpend: 5 }),
      MOCK_CATALOG,
      kiloAttestations(),
      MOCK_PRIMARY_SCOPE,
    );
    expect(resolution.hasUsable).toBe(false);
    expect(resolution.rejected[0].reason).toBe("spend-cap-invalid");
  });

  it("rejects a candidate whose quota scope cannot be proven distinct", () => {
    const catalog: CatalogLike = {
      ...MOCK_CATALOG,
      providers: {
        ...MOCK_CATALOG.providers,
        kilo: { ...MOCK_CATALOG.providers.kilo, quota_scope: null },
      },
    };
    const resolution = resolveFallbackProfile(
      withKilo(),
      catalog,
      kiloAttestations(),
      "account:mistral-education",
    );
    expect(resolution.hasUsable).toBe(false);
    expect(resolution.rejected[0].reason).toBe("quota-scope-unknown");
  });

  it("rejects a free candidate sharing the exhausted scope with the primary", () => {
    // e.g. a profile whose primary is the Kilo account and whose candidate is
    // another model on the SAME Kilo account: not new capacity.
    const resolution = resolveFallbackProfile(
      withKilo(),
      MOCK_CATALOG,
      kiloAttestations(),
      "account:kilo",
    );
    expect(resolution.hasUsable).toBe(false);
    expect(resolution.rejected[0].reason).toBe("quota-exhausted-scope");
  });

  it("never mixes free providers into one allowance", () => {
    // Kilo and Groq are separate free accounts, so one can cover the other.
    const profile: FallbackProfile = {
      ...withKilo({ maxSpend: 0 }),
      primaryRoute: "omp.kilo",
      globalMaxSpend: 0,
      candidates: [
        {
          route: "omp.groq",
          model: "openai/gpt-oss-120b",
          billing: "free",
          credential: "infisical",
          maxSpend: 0,
          scope: "read-only",
        },
      ],
    };
    const resolution = resolveFallbackProfile(
      profile,
      MOCK_CATALOG,
      kiloAttestations(),
      "account:kilo",
    );
    expect(resolution.hasUsable).toBe(true);
    expect(resolution.usable[0].candidate.route).toBe("omp.groq");
  });
});
// ---------------------------------------------------------------------------
// Durable catalog evidence seeding (ADR-0018). `agent fallback` must resolve a
// profile on a fresh machine from the REVIEWED config, not only from
// ephemeral local probe state — while never inventing a fact it does not have.
// ---------------------------------------------------------------------------

describe("seedAttestationsFromCatalog", () => {
  const evidence: Evidence = {
    at: new Date(Date.now() - 1000).toISOString(),
    source: "live-e2e",
    sha: "c".repeat(40),
  };
  const attested = <T,>(value: T): Attested<T> =>
    attest({ value, status: "verified-live", provenance: "measured", evidence });

  it("seeds one attestation per committed e2e observation", () => {
    const facts: FallbackCatalogFacts = {
      providers: {},
      routes: {
        "omp.kilo": {
          e2e: attested([
            { model: "m-a", tool_call: true },
            { model: "m-b", tool_call: true },
          ]),
        },
      },
    };
    const map = seedAttestationsFromCatalog(facts);
    expect(map.size).toBe(2);
    expect(map.get("omp.kilo#m-a")?.value.status).toBe("verified-live");
    expect(map.get("omp.kilo#m-b")?.provenance).toBe("measured");
  });

  it("seeds a restricted observation for a route with a restriction", () => {
    const facts: FallbackCatalogFacts = {
      providers: {},
      routes: {
        "opencode.ovhcloud": {
          e2e: attested([{ model: "gpt-oss-120b", tool_call: true }]),
          restriction: attest({
            value: null,
            status: "restricted",
            provenance: "measured",
            evidence,
            note: "2 req/min",
          }),
        },
      },
    };
    const map = seedAttestationsFromCatalog(facts);
    expect(map.get("opencode.ovhcloud#gpt-oss-120b")?.value.status).toBe("restricted");
  });

  it("leaves a route without e2e/restriction absent (genuinely unknown)", () => {
    const facts: FallbackCatalogFacts = { providers: {}, routes: { "omp.kilo": {} } };
    expect(seedAttestationsFromCatalog(facts).size).toBe(0);
    expect(seedAttestationsFromCatalog(null).size).toBe(0);
  });

  it("a NEWER local probe observation overrides the durable record", () => {
    const durable = seedAttestationsFromCatalog({
      providers: {},
      routes: { "omp.kilo": { e2e: attested([{ model: "m", tool_call: true }]) } },
    });
    const newer = new Date(Date.now() - 1000).toISOString();
    const local = new Map(durable);
    local.set(
      "omp.kilo#m",
      attest({
        value: {
          status: "restricted",
          provenance: "measured",
          evidence: { ...evidence, at: newer },
        },
        status: "restricted",
        provenance: "measured",
        evidence: { ...evidence, at: newer },
        note: "just hit 429",
      }),
    );
    const merged = mergeAttestations(durable, local);
    expect(merged.get("omp.kilo#m")?.value.status).toBe("restricted");
  });

  it("an OLDER local observation must not replace newer committed evidence", () => {
    // Two unsafe outcomes if this regressed: stale local evidence would make a
    // healthy route look stale, and an older verified-live entry would hide a
    // newer committed restriction.
    const committedAt = new Date(Date.now() - 1000).toISOString();
    const olderAt = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const durable = seedAttestationsFromCatalog({
      providers: {},
      routes: {
        "omp.kilo": {
          e2e: attested([{ model: "m", tool_call: true }]),
          restriction: attest({
            value: null,
            status: "restricted",
            provenance: "measured",
            evidence: { ...evidence, at: committedAt },
            note: "committed 429 observation",
          }),
        },
      },
    });
    expect(durable.get("omp.kilo#m")?.value.status).toBe("restricted");
    const local = new Map<string, Attested<{ status: VerificationStatus; provenance: Provenance; evidence: Evidence }>>();
    local.set(
      "omp.kilo#m",
      attest({
        value: {
          status: "verified-live",
          provenance: "measured",
          evidence: { ...evidence, at: olderAt },
        },
        status: "verified-live",
        provenance: "measured",
        evidence: { ...evidence, at: olderAt },
      }),
    );
    const merged = mergeAttestations(durable, local);
    expect(merged.get("omp.kilo#m")?.value.status).toBe("restricted");
  });

  it("a timestamp tie keeps the committed entry", () => {
    const durable = seedAttestationsFromCatalog({
      providers: {},
      routes: { "omp.kilo": { e2e: attested([{ model: "m", tool_call: true }]) } },
    });
    const sameAt = evidence.at;
    const local = new Map(durable);
    local.set(
      "omp.kilo#m",
      attest({
        value: { status: "verified-live", provenance: "measured", evidence: { ...evidence, at: sameAt } },
        status: "verified-live",
        provenance: "measured",
        evidence: { ...evidence, at: sameAt },
        note: "tie, should be ignored",
      }),
    );
    // Tie keeps the committed entry, which is identifiable by its own note.
    const merged = mergeAttestations(durable, local);
    expect(merged.get("omp.kilo#m")?.value.status).toBe("verified-live");
    expect(merged.get("omp.kilo#m")?.note).toBeUndefined();
  });

  it("a seeded attestation still has to pass freshness", () => {
    // Seeding does not bypass freshness: the resolver's isUsable() check still
    // rejects an old observation, so a committed record cannot make a dead
    // route look healthy forever.
    const staleEvidence: Evidence = {
      at: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString(),
      source: "live-e2e",
      sha: "d".repeat(40),
    };
    const staleMap = seedAttestationsFromCatalog({
      providers: {},
      routes: {
        "omp.kilo": {
          e2e: attest({
            value: [{ model: "nvidia/nemotron-3-ultra-550b-a55b:free", tool_call: true }],
            status: "verified-live",
            provenance: "measured",
            evidence: staleEvidence,
          }),
        },
      },
    });
    const profile: FallbackProfile = {
      ...BASE_PROFILE,
      globalMaxSpend: 0,
      candidates: [{
        route: "omp.kilo", model: "nvidia/nemotron-3-ultra-550b-a55b:free",
        billing: "free", credential: "infisical", maxSpend: 0, scope: "read-only",
      }],
    };
    const resolution = resolveFallbackProfile(profile, MOCK_CATALOG, staleMap, MOCK_PRIMARY_SCOPE);
    expect(resolution.hasUsable).toBe(false);
    expect(resolution.rejected[0].reason).toBe("attestation-stale");
  });
});

// ---------------------------------------------------------------------------
// buildFallbackCatalog wiring. The resolver checks are only meaningful if the
// facts they read actually survive the config -> CatalogLike conversion; a
// dropped field silently disables a safety check (which is exactly how the
// provider restriction and route quota overrides went unchecked).
// ---------------------------------------------------------------------------

describe("buildFallbackCatalog", () => {
  const evidence: Evidence = {
    at: new Date(Date.now() - 1000).toISOString(),
    source: "live-e2e",
    sha: "e".repeat(40),
  };
  const config: FallbackConfigLike = {
    routes: {
      "omp.kilo": { provider: "kilo", models: null, require_model: false, default_model: null },
      "omp.groq": { provider: "groq", models: null, require_model: false, default_model: null },
    },
    providers: {
      kilo: { models: ["m"], require_model: false, default_model: null, require_infisical: true },
      groq: { models: ["m"], require_model: false, default_model: null, require_infisical: true },
      uncatalogued: { models: ["m"], require_model: false, default_model: null, require_infisical: false },
    },
    harnesses: { omp: { adapter: "omp" } },
  };

  it("carries provider billing, quota and restriction", () => {
    const built = buildFallbackCatalog(config, {
      providers: {
        kilo: { billing: "free", quota: { kind: "account", id: "kilo" }, restriction: attest({ value: null, status: "restricted", provenance: "measured", evidence, note: "client-bound tier" }) },
        groq: { billing: "free", quota: { kind: "account", id: "groq" }, restriction: null },
      },
      routes: {},
    });
    expect(built.providers.kilo.billing).toBe("free");
    expect(built.providers.kilo.quota_scope).toBe("account:kilo");
    expect(built.providers.kilo.restricted).toBe(true);
    // An absent restriction is false, never undefined (so the check is a
    // boolean test, not a truthiness test on a missing field).
    expect(built.providers.groq.restricted).toBe(false);
  });

  it("carries route-level quota overrides", () => {
    const built = buildFallbackCatalog(config, {
      providers: { kilo: { billing: "free", quota: { kind: "account", id: "kilo" }, restriction: null } },
      routes: { "omp.kilo": { quota: { kind: "api-key", id: "KILO_DEDICATED" } } },
    });
    expect(built.routes["omp.kilo"].quota_scope).toBe("api-key:KILO_DEDICATED");
    // A route with no override carries null, so effectiveRouteQuotaKey falls
    // back to the provider scope.
    expect(built.routes["omp.groq"].quota_scope).toBeNull();
  });

  it("resolves billing as unknown for an uncatalogued provider", () => {
    const built = buildFallbackCatalog(config, null);
    expect(built.providers.uncatalogued.billing).toBe("unknown");
    expect(built.providers.uncatalogued.restricted).toBe(false);
  });

  it("effectiveRouteQuotaKey prefers the route scope, then the provider scope", () => {
    const built = buildFallbackCatalog(config, {
      providers: { kilo: { billing: "free", quota: { kind: "account", id: "kilo" }, restriction: null } },
      routes: { "omp.kilo": { quota: { kind: "api-key", id: "DEDICATED" } } },
    });
    expect(effectiveRouteQuotaKey(built, "omp.kilo")).toBe("api-key:DEDICATED");
    expect(effectiveRouteQuotaKey(built, "omp.groq")).toBeNull();
    expect(effectiveRouteQuotaKey(built, "missing.route")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Rejection-reason contract. The docs and ADR enumerate these reasons; pinning
// the set makes a silently added/removed safety verdict fail loudly instead of
// drifting away from the documented record.
// ---------------------------------------------------------------------------

describe("FallbackRejectionReason contract", () => {
  it("covers exactly the documented safety verdicts", () => {
    // Typed as a total Record so adding a union member without updating this
    // list is a compile error, not a silent documentation gap.
    const documented: Record<FallbackRejectionReason, true> = {
      "route-not-configured": true,
      "model-not-allowed": true,
      "credential-mismatch": true,
      "billing-boundary-crossed": true,
      "billing-unknown": true,
      "provider-restricted": true,
      "primary-quota-unknown": true,
      "spend-cap-invalid": true,
      "spend-cap-exceeded": true,
      "scope-escalation": true,
      expired: true,
      revoked: true,
      "attestation-stale": true,
      "attestation-unknown": true,
      "attestation-restricted": true,
      "quota-exhausted-scope": true,
      "quota-scope-unknown": true,
      "validation-error": true,
    };
    expect(Object.keys(documented).sort()).toEqual(
      [
        "attestation-restricted",
        "attestation-stale",
        "attestation-unknown",
        "billing-boundary-crossed",
        "billing-unknown",
        "credential-mismatch",
        "expired",
        "model-not-allowed",
        "primary-quota-unknown",
        "provider-restricted",
        "quota-exhausted-scope",
        "quota-scope-unknown",
        "revoked",
        "route-not-configured",
        "scope-escalation",
        "spend-cap-exceeded",
        "spend-cap-invalid",
        "validation-error",
      ].sort(),
    );
  });
});
