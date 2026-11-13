#!/usr/bin/env bun
/**
 * Opt-in continuity profile for authorized fallback (dotfiles#136, Epic#86 T020).
 *
 * This module defines the schema, resolution and preflight for an explicitly
 * authorized candidate set. It does NOT implement mid-session switching or
 * cross-harness resume — those belong to #139 and #101.
 *
 * The launcher retains strict single-route behavior by default. An opt-in
 * profile only takes effect when explicitly selected and fully validated.
 */

import { ContractError, parseRouteId, formatRouteId, type RouteRef, attest, parseAttested, isUsable, type Attested, type Evidence, type VerificationStatus, type Provenance, type EvidenceSource, DEFAULT_MAX_EVIDENCE_AGE_MS } from "./contract.ts";
import type { E2eObservation } from "./catalog.ts";

// ---------------------------------------------------------------------------
// Schema types
// ---------------------------------------------------------------------------

/** Billing boundary that a fallback must not cross without explicit consent. */
export type BillingBoundary =
  | "free"           // free tier only
  | "subscription"   // bundled subscription plan
  | "metered"        // pay-as-you-go API credits
  | "plan";          // named plan (e.g., MiniMax M Plan, Mistral Education)

/** Credential source authorization for a fallback candidate. */
export type CredentialSourceAuth =
  | "infisical"      // Infisical-injected secret (process-scoped)
  | "native-auth"    // harness-native authentication (e.g., claude subscription)
  | "env-file"       // local .env / models.yml (explicitly allowed per route)
  | "unset";         // not authorized (default)

/** Single authorized fallback candidate. */
export interface FallbackCandidate {
  /** Route identity (must match a configured route in config/agents.toml). */
  route: string;                    // e.g. "omp.mistral"
  /** Model id (must be in the route/provider model allowlist). */
  model: string;                    // e.g. "zai-glm-5-3-flash"
  /** Allowed billing boundary for this candidate. */
  billing: BillingBoundary;
  /** Authorized credential source. */
  credential: CredentialSourceAuth;
  /** Hard spend/overage cap in the provider's currency (optional, provider-specific). */
  maxSpend?: number;
  /** Task/permission scope: what this candidate is allowed to do. */
  scope: FallbackScope;
  /** ISO 8601 UTC expiration; absent = no time limit. */
  expiresAt?: string;
  /** Human-readable note for audit trail. */
  note?: string;
}

/** What a fallback candidate is permitted to execute. */
export type FallbackScope =
  | "read-only"       // no writes, no irreversible operations
  | "local-writes"    // repo/file writes only, no external deploy/push
  | "full";           // same as primary route (requires explicit justification)

/** Complete fallback profile. */
export interface FallbackProfile {
  /** Profile identifier (unique, human-readable). */
  id: string;
  /** Profile version for schema evolution. */
  version: number;
  /** Human-readable description. */
  description: string;
  /** Primary route this profile applies to (the route being protected). */
  primaryRoute: string;
  /** Ordered list of authorized fallback candidates. First usable wins. */
  candidates: FallbackCandidate[];
  /** Global hard cap for total fallback spend across all candidates. */
  globalMaxSpend?: number;
  /** When this profile was authorized. */
  authorizedAt: string;
  /** Who authorized this profile (audit). */
  authorizedBy: string;
  /** Profile expiration; absent = no expiration. */
  expiresAt?: string;
  /** Revocation flag; if true, profile is disabled regardless of dates. */
  revoked?: boolean;
}

/** Result of resolving a fallback profile against current catalog/attestation state. */
export interface FallbackResolution {
  /** The profile that was resolved. */
  profile: FallbackProfile;
  /** The primary route (validated). */
  primaryRoute: RouteRef;
  /** Candidates that passed all validation and are currently usable. */
  usable: ResolvedCandidate[];
  /** Candidates that were considered but rejected, with reasons. */
  rejected: RejectedCandidate[];
  /** Whether any usable candidate exists. */
  hasUsable: boolean;
}

/** A candidate that passed validation and has current usable attestation. */
export interface ResolvedCandidate {
  candidate: FallbackCandidate;
  routeRef: RouteRef;
  /** Current attestation status for this route/model. */
  attestation: Attested<{
    status: VerificationStatus;
    provenance: Provenance;
    evidence: Evidence;
  }>;
}

/** A candidate that was rejected during resolution. */
export interface RejectedCandidate {
  candidate: FallbackCandidate;
  routeRef: RouteRef | null;
  /** Reason for rejection. */
  reason: FallbackRejectionReason;
}

/** Reason a fallback candidate was rejected. */
export type FallbackRejectionReason =
  | "route-not-configured"        // route not in config/agents.toml
  | "model-not-allowed"           // model not in route/provider allowlist
  | "credential-mismatch"         // candidate's credential auth doesn't match route config
  | "billing-boundary-crossed"    // would cross unauthorized billing boundary
  | "billing-unknown"             // provider billing model is not catalogued
  | "provider-restricted"         // the provider itself is observed restricted
  | "primary-quota-unknown"       // the primary's allowance cannot be identified
  | "harness-mismatch"            // candidate is a different harness than the primary
  | "spend-cap-invalid"           // a free candidate declared a positive spend cap, or a billable candidate declared none
  | "spend-cap-exceeded"          // candidate or global maxSpend exceeded
  | "scope-escalation"            // candidate scope exceeds profile allowance
  | "expired"                     // profile or candidate expired
  | "revoked"                     // profile revoked
  | "attestation-stale"           // attestation not fresh (per DEFAULT_MAX_EVIDENCE_AGE_MS)
  | "attestation-unknown"         // attestation status is unknown
  | "attestation-restricted"      // attestation shows restriction (402/403/429)
  | "quota-exhausted-scope"       // candidate shares exhausted quota scope with primary
  | "quota-scope-unknown"         // candidate's shared allowance cannot be proven distinct
  | "validation-error";           // schema/identity validation failed

// ---------------------------------------------------------------------------
// TOML parsing helpers (minimal, mirrors script/agent.ts patterns)
// ---------------------------------------------------------------------------

function requireStr(data: Record<string, unknown>, key: string, where: string): string {
  const v = data[key];
  if (typeof v !== "string") throw new ContractError(`schema`, `${where}.${key}: expected string`);
  return v;
}

/**
 * An optional string. Absent is `null`; a present value must actually be a
 * string. Silently coercing a wrong type to "absent" would turn
 * `expires_at = 123` into "no expiry" — the same fail-open shape the spend cap
 * was hardened against.
 */
function optionalStrStrict(data: Record<string, unknown>, key: string, where: string): string | null {
  const v = data[key];
  if (v === undefined || v === null) return null;
  if (typeof v !== "string") {
    throw new ContractError("schema", `${where}.${key}: expected string`);
  }
  return v;
}

/**
 * An optional boolean. Absent is `null`; a present value must be a boolean.
 * Coercing a wrong type to null would read `revoked = "true"` as "not revoked"
 * — fail-open on the revocation flag.
 */
function optionalBoolStrict(data: Record<string, unknown>, key: string, where: string): boolean | null {
  const v = data[key];
  if (v === undefined || v === null) return null;
  if (typeof v !== "boolean") {
    throw new ContractError("schema", `${where}.${key}: expected boolean`);
  }
  return v;
}

/**
 * A spend cap that is PRESENT must be valid. The former `optionalInt` helper
 * silently mapped any invalid value to null (absent), which for a cap means
 * "uncapped" — so `max_spend = -1` (an operator writing "deny") would have
 * authorised unlimited spend. Absence stays absent; a present-but-invalid
 * value throws. (That helper has been removed so the trap cannot come back.)
 */
function optionalSpendCap(
  data: Record<string, unknown>,
  key: string,
  where: string,
): number | null {
  const v = data[key];
  if (v === undefined || v === null) return null;
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0) {
    throw new ContractError(
      "schema",
      `${where}.${key}: must be a non-negative integer (a present cap cannot be ignored)`,
    );
  }
  return v;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const VALID_BILLING: readonly BillingBoundary[] = ["free", "subscription", "metered", "plan"];
const VALID_CREDENTIAL: readonly CredentialSourceAuth[] = ["infisical", "native-auth", "env-file", "unset"];
const VALID_SCOPE: readonly FallbackScope[] = ["read-only", "local-writes", "full"];

function validateBilling(v: unknown, where: string): BillingBoundary {
  if (typeof v !== "string" || !VALID_BILLING.includes(v as BillingBoundary))
    throw new ContractError("schema", `${where}: invalid billing boundary "${v}"`);
  return v as BillingBoundary;
}

function validateCredential(v: unknown, where: string): CredentialSourceAuth {
  if (typeof v !== "string" || !VALID_CREDENTIAL.includes(v as CredentialSourceAuth))
    throw new ContractError("schema", `${where}: invalid credential source "${v}"`);
  return v as CredentialSourceAuth;
}

function validateScope(v: unknown, where: string): FallbackScope {
  if (typeof v !== "string" || !VALID_SCOPE.includes(v as FallbackScope))
    throw new ContractError("schema", `${where}: invalid scope "${v}"`);
  return v as FallbackScope;
}

/**
 * A candidate's declared billing boundary must be satisfiable by the
 * provider's real charging model.
 *
 *   - `free` is strictly free: a free declaration may never consume a paying
 *     endpoint.
 *   - `metered` requires a metered provider.
 *   - `plan` is the flexible prepaid case: it accepts a `plan` provider and
 *     also a `subscription` one (a bundled allowance is a prepaid plan too).
 *   - `subscription` is strict: it requires an actual subscription provider.
 *
 * Unknown billing never matches anything.
 */
export function billingMatches(
  declared: BillingBoundary,
  providerBilling: string,
): boolean {
  if (providerBilling === "unknown") return false;
  if (declared === "free") return providerBilling === "free";
  if (declared === "metered") return providerBilling === "metered";
  if (declared === "subscription") return providerBilling === "subscription";
  return providerBilling === "plan" || providerBilling === "subscription";
}

function validateISO8601(v: string, where: string): void {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(v))
    throw new ContractError("schema", `${where}: not a valid ISO 8601 UTC timestamp`);
}

function validateProfileVersion(v: unknown, where: string): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < 1)
    throw new ContractError("schema", `${where}: version must be integer >= 1`);
  return v;
}

// ---------------------------------------------------------------------------
// Profile parsing from TOML (config/agents.toml)
// ---------------------------------------------------------------------------

/**
 * Parse a fallback profile from the `[fallback_profile.<id>]` table in
 * config/agents.toml. Returns null if the profile doesn't exist.
 */
export function parseFallbackProfile(
  toml: Record<string, unknown>,
  profileId: string
): FallbackProfile | null {
  // Bun.TOML.parse returns nested structure: { fallback_profile: { "omp-mistral-quota": {...} } }
  const fallbackSection = toml.fallback_profile;
  if (!fallbackSection || typeof fallbackSection !== "object" || Array.isArray(fallbackSection)) return null;
  const table = (fallbackSection as Record<string, unknown>)[profileId];
  if (!table || typeof table !== "object" || Array.isArray(table)) return null;

  const t = table as Record<string, unknown>;
  const key = `fallback_profile.${profileId}`;
  // Required fields
  const id = requireStr(t, "id", key);
  if (id !== profileId) throw new ContractError("identity", `${key}.id: must match table key "${profileId}"`);

  const version = validateProfileVersion(t.version, `${key}.version`);
  const description = requireStr(t, "description", key);
  const primaryRoute = requireStr(t, "primary_route", key);
  // Validate the identity eagerly so `agent check` rejects a malformed profile
  // and `agent fallback` cannot die with a raw ContractError stack trace.
  try {
    parseRouteId(primaryRoute);
  } catch {
    throw new ContractError("identity", `${key}.primary_route: not a '<harness>.<provider>' route id`);
  }
  const authorizedAt = requireStr(t, "authorized_at", key);
  validateISO8601(authorizedAt, `${key}.authorized_at`);
  const authorizedBy = requireStr(t, "authorized_by", key);

  // Optional fields. A present-but-wrong-type value must be rejected, not
  // silently coerced to "absent": `expires_at = 123` becoming "no expiry" is
  // the same fail-open shape the spend cap was hardened against.
  const expiresAt = optionalStrStrict(t, "expires_at", key);
  if (expiresAt) validateISO8601(expiresAt, `${key}.expires_at`);
  const revoked = optionalBoolStrict(t, "revoked", key) ?? false;
  const globalMaxSpend = optionalSpendCap(t, "global_max_spend", key);

  // Candidates array
  const candidatesRaw = t.candidates;
  if (!Array.isArray(candidatesRaw) || candidatesRaw.length === 0)
    throw new ContractError("schema", `${key}.candidates: must be non-empty array`);

  const candidates: FallbackCandidate[] = candidatesRaw.map((c, idx) => {
    if (!c || typeof c !== "object" || Array.isArray(c))
      throw new ContractError("schema", `${key}.candidates[${idx}]: must be object`);
    const ct = c as Record<string, unknown>;
    const route = requireStr(ct, "route", `${key}.candidates[${idx}]`);
    const model = requireStr(ct, "model", `${key}.candidates[${idx}]`);
    const billing = validateBilling(ct.billing, `${key}.candidates[${idx}].billing`);
    const credential = validateCredential(ct.credential, `${key}.candidates[${idx}].credential`);
    const maxSpend = optionalSpendCap(ct, "max_spend", `${key}.candidates[${idx}]`);
    const scope = validateScope(ct.scope, `${key}.candidates[${idx}].scope`);
    const candidateExpiresAt = optionalStrStrict(ct, "expires_at", `${key}.candidates[${idx}]`);
    if (candidateExpiresAt) validateISO8601(candidateExpiresAt, `${key}.candidates[${idx}].expires_at`);
    const note = optionalStrStrict(ct, "note", `${key}.candidates[${idx}]`);
    return { route, model, billing, credential, maxSpend, scope, expiresAt: candidateExpiresAt, note };
  });

  return {
    id,
    version,
    description,
    primaryRoute,
    candidates,
    globalMaxSpend,
    authorizedAt,
    authorizedBy,
    expiresAt,
    revoked,
  };
}

/**
 * List all fallback profile IDs defined in the TOML config.
 */
export function listFallbackProfiles(toml: Record<string, unknown>): string[] {
  const fallbackSection = toml.fallback_profile;
  if (!fallbackSection || typeof fallbackSection !== "object" || Array.isArray(fallbackSection)) return [];
  return Object.keys(fallbackSection as Record<string, unknown>).sort();
}

// ---------------------------------------------------------------------------
// Resolution against catalog and attestation
// ---------------------------------------------------------------------------

export interface CatalogLike {
  routes: Record<string, {
    provider: string;
    models?: string[];
    require_model?: boolean;
    default_model?: string;
    /** Route-declared quota scope key (`<kind>:<id>`), if catalogued. Route
     * scope overrides the provider scope, exactly like `effectiveQuotaKey`. */
    quota_scope?: string | null;
    /** `[catalog.routes.*.restriction]`: an observed block on this route.
     * Checked in the resolver (not only while seeding) because seeding can only
     * attach a per-model fact to models named in that route's e2e list, and a
     * restricted route may have no e2e (e.g. omp.deepseek: 402 with no e2e). */
    restricted?: boolean;
  }>;
  providers: Record<string, {
    models: string[];
    require_model?: boolean;
    default_model?: string;
    require_infisical?: boolean;
    /** `[catalog.providers.*].billing`: the provider's real charging model.
     * Absent = unknown, which is never treated as free. */
    billing?: string;
    /** Provider-declared quota scope key (`<kind>:<id>`), if catalogued. */
    quota_scope?: string | null;
    /** `[catalog.providers.*].restriction`: an observed block on the whole
     * provider (e.g. a client-bound tier). A restricted provider makes every
     * route under it ineligible, regardless of route-level evidence. */
    restricted?: boolean;
  }>;
  harnesses: Record<string, { adapter: string }>;
}

/** Structural view of the launcher config this module needs. Defined here so
 * `fallback.ts` does not import `script/agent.ts` (which runs main() at load). */
export interface FallbackConfigLike {
  routes: Record<string, {
    provider: string;
    models: string[] | null;
    require_model: boolean;
    default_model: string | null;
  }>;
  providers: Record<string, {
    models: string[];
    require_model: boolean;
    default_model: string | null;
    require_infisical: boolean;
  }>;
  harnesses: Record<string, { adapter: string }>;
}

/** Structural view of the validated `[catalog.*]` tables. Provider-level
 * restriction and route-level quota are carried here because the resolver
 * needs both to decide eligibility; dropping them silently disabled those
 * checks. Field names mirror the `Catalog` type so callers can pass it
 * directly. */
export interface FallbackCatalogFacts {
  providers: Record<string, {
    billing: string;
    quota: { kind: string; id: string } | null;
    /** `[catalog.providers.<id>.restriction]`: an observed provider-wide
     * block. Present (with status `restricted`) = the provider is unusable. */
    restriction?: Attested<null> | null;
  }>;
  routes?: Record<string, {
    e2e?: Attested<E2eObservation[]> | null;
    restriction?: Attested<null> | null;
    /** Route-level quota override (wins over the provider scope). */
    quota?: { kind: string; id: string } | null;
  }>;
}

/**
 * Build the resolver's catalog view from the launcher config plus the
 * validated catalog facts. `billing` and `quota_scope` come from the
 * `[catalog.*]` tables (never guessed): a provider with no catalogued billing
 * resolves to `unknown` and is therefore ineligible as a fallback candidate.
 *
 * Single implementation shared by `agent fallback` and
 * `executeWithFallback`, so the CLI display and the executor cannot disagree
 * about which candidates are safe.
 */
export function buildFallbackCatalog(
  config: FallbackConfigLike,
  catalogFacts: FallbackCatalogFacts | null,
): CatalogLike {
  const routes: CatalogLike["routes"] = {};
  for (const [key, route] of Object.entries(config.routes)) {
    const facts = catalogFacts?.routes?.[key] ?? null;
    const scope = facts?.quota ?? null;
    routes[key] = {
      provider: route.provider,
      models: route.models ?? undefined,
      require_model: route.require_model,
      default_model: route.default_model ?? undefined,
      // Route scope wins over the provider scope (effectiveQuotaKey rule).
      quota_scope: scope ? `${scope.kind}:${scope.id}` : null,
      // Same blocking rule as the provider level: any present restriction
      // blocks unless it is explicitly unknown.
      restricted: Boolean(facts?.restriction) && facts?.restriction?.status !== "unknown",
    };
  }

  const providers: CatalogLike["providers"] = {};
  for (const [key, provider] of Object.entries(config.providers)) {
    const facts = catalogFacts?.providers[key] ?? null;
    const scope = facts?.quota ?? null;
    providers[key] = {
      models: provider.models,
      require_model: provider.require_model,
      default_model: provider.default_model ?? undefined,
      require_infisical: provider.require_infisical,
      billing: facts?.billing ?? "unknown",
      quota_scope: scope ? `${scope.kind}:${scope.id}` : null,
      // A provider-wide restriction carries no per-model fact; its presence
      // with status `restricted` is the whole statement. Any present
      // restriction blocks: only an explicit absence is "unrestricted", so an
      // unverified-but-declared block cannot fail open.
      restricted: Boolean(facts?.restriction) && facts?.restriction?.status !== "unknown",
    };
  }

  const harnesses: CatalogLike["harnesses"] = {};
  for (const [key, harness] of Object.entries(config.harnesses)) {
    harnesses[key] = { adapter: harness.adapter };
  }

  return { routes, providers, harnesses };
}

/**
 * The allowance a candidate route draws from, with the same route-first,
 * provider-second precedence as `effectiveQuotaKey`. Using only the provider
 * scope would compare a route that declares its own quota by the wrong
 * allowance, and could accept a candidate sharing the exhausted primary's
 * budget.
 */
export function effectiveRouteQuotaKey(
  catalog: CatalogLike,
  routeId: string,
): string | null {
  const route = catalog.routes[routeId];
  if (!route) return null;
  const routeScope = route.quota_scope ?? null;
  if (routeScope) return routeScope;
  return catalog.providers[route.provider]?.quota_scope ?? null;
}

/**
 * Seed the attestation map with the DURABLE catalog evidence from
 * `config/agents.toml` (`[catalog.routes.*.e2e]` / `.restriction`).
 *
 * Without this, `agent fallback` only sees ephemeral local probe state, so a
 * route whose real E2E is committed in the config would be reported
 * `attestation-unknown` and no profile could ever resolve on a fresh machine.
 * The committed catalog is the reviewed record; local state may override it.
 *
 * A route with a `restriction` attestation seeds `restricted`; a route with an
 * `e2e` observation for the model seeds that observation's status. Routes with
 * neither stay absent, i.e. genuinely unknown.
 */
export function seedAttestationsFromCatalog(
  catalogFacts: FallbackCatalogFacts | null,
): Map<string, Attested<{ status: VerificationStatus; provenance: Provenance; evidence: Evidence }>> {
  const map = new Map<string, Attested<{ status: VerificationStatus; provenance: Provenance; evidence: Evidence }>>();
  if (!catalogFacts?.routes) return map;
  for (const [routeId, facts] of Object.entries(catalogFacts.routes)) {
    if (facts.restriction) {
      // The restriction is a fact in its own right; it carries no per-model e2e.
      const restriction = facts.restriction;
      const affected = facts.e2e?.value?.map((o) => o.model) ?? [];
      for (const model of affected) {
        map.set(`${routeId}#${model}`, {
          value: {
            status: "restricted",
            provenance: restriction.provenance,
            evidence: restriction.evidence as Evidence,
          },
          status: restriction.status,
          provenance: restriction.provenance,
          evidence: restriction.evidence,
          ...(restriction.note ? { note: restriction.note } : {}),
        });
      }
      continue;
    }
    const e2e = facts.e2e;
    if (!e2e?.value) continue;
    for (const observation of e2e.value) {
      map.set(`${routeId}#${observation.model}`, {
        value: {
          status: e2e.status,
          provenance: e2e.provenance,
          evidence: e2e.evidence as Evidence,
        },
        status: e2e.status,
        provenance: e2e.provenance,
        evidence: e2e.evidence,
        ...(e2e.note ? { note: e2e.note } : {}),
      });
    }
  }
  return map;
}

/**
 * Merge committed catalog evidence with local probe state.
 *
 * Rules, in order:
 *   1. `restricted` wins over any non-restricted entry regardless of timestamp.
 *      Catalog evidence is day-precision (`2026-11-04T00:00:00Z`), so a same-day
 *      local `restricted` observation would otherwise TIE and lose to the
 *      committed `verified-live` record — resolving a blocked route as usable.
 *   2. Otherwise the strictly newer `evidence.at` wins.
 *   3. A tie or unparsable timestamp keeps the committed entry (fail closed
 *      toward the reviewed record).
 *
 * `Date.parse` returns NaN for a missing/unparsable timestamp, and NaN compares
 * false, which is why the tie case falls through to the committed entry.
 */
export function mergeAttestations(
  durable: Map<string, Attested<{ status: VerificationStatus; provenance: Provenance; evidence: Evidence }>>,
  local: Map<string, Attested<{ status: VerificationStatus; provenance: Provenance; evidence: Evidence }>>,
): Map<string, Attested<{ status: VerificationStatus; provenance: Provenance; evidence: Evidence }>> {
  const merged = new Map(durable);
  for (const [key, localEntry] of local) {
    const committed = merged.get(key);
    if (!committed) {
      merged.set(key, localEntry);
      continue;
    }
    const committedRestricted = isRestricted(committed);
    const localRestricted = isRestricted(localEntry);
    // A newly observed block always applies; a block is never cleared by
    // recency alone (clearing requires deleting the committed record).
    if (localRestricted && !committedRestricted) {
      merged.set(key, localEntry);
      continue;
    }
    if (committedRestricted && !localRestricted) {
      continue;
    }
    const localAt = Date.parse(localEntry.evidence?.at ?? "");
    const committedAt = Date.parse(committed.evidence?.at ?? "");
    if (localAt > committedAt) {
      merged.set(key, localEntry);
    }
  }
  return merged;
}

/**
 * Effective status of an attestation, tolerating the contract-legal `value:
 * null` shape used for restrictions.
 */
function attestationStatus(
  entry: Attested<{ status: VerificationStatus; provenance: Provenance; evidence: Evidence }>,
): VerificationStatus {
  const value = entry.value;
  if (typeof value === "object" && value !== null && typeof value.status === "string") {
    return value.status;
  }
  return entry.status;
}

/**
 * Is this attestation an observed restriction?
 *
 * The contract allows `value` to be **null** when the status is `restricted`
 * (the restriction itself is the fact, `contract.ts`), so reading
 * `value.status` blindly throws a TypeError on a perfectly legal entry — and
 * that is the shape a probe would write. Read the top-level status first and
 * only fall back to `value` when it is an object.
 */
function isRestricted(
  entry: Attested<{ status: VerificationStatus; provenance: Provenance; evidence: Evidence }>,
): boolean {
  return attestationStatus(entry) === "restricted";
}

/**
 * Resolve a fallback profile against the current catalog and attestation state.
 * This is the core preflight: validates identity, credential auth, billing boundaries,
 * spend caps, scope, expiration, and attestation freshness/usability.
 */
export function resolveFallbackProfile(
  profile: FallbackProfile,
  catalog: CatalogLike,
  attestations: Map<string, Attested<{ status: VerificationStatus; provenance: Provenance; evidence: Evidence }>>,
  primaryQuotaScopeKey: string | null,
  nowMs: number = Date.now()
): FallbackResolution {
  const primaryRouteRef = parseRouteId(profile.primaryRoute);
  const usable: ResolvedCandidate[] = [];
  const rejected: RejectedCandidate[] = [];
  let totalSpend = 0;

  // Check profile-level expiration/revocation
  if (profile.revoked) {
    for (const cand of profile.candidates) {
      rejected.push({ candidate: cand, routeRef: null, reason: "revoked" });
    }
    return { profile, primaryRoute: primaryRouteRef, usable, rejected, hasUsable: false };
  }
  if (profile.expiresAt && new Date(profile.expiresAt).getTime() <= nowMs) {
    for (const cand of profile.candidates) {
      rejected.push({ candidate: cand, routeRef: null, reason: "expired" });
    }
    return { profile, primaryRoute: primaryRouteRef, usable, rejected, hasUsable: false };
  }

  // Fail closed when the primary's allowance cannot be identified. The quota
  // check below can only prove a candidate is independent by comparing scope
  // keys; with no primary key the whole check would be skipped, so a candidate
  // could be declared fresh capacity with no evidence that it is not drawing
  // on the exhausted primary's allowance. An unknown primary scope therefore
  // rejects every candidate instead of silently disabling the comparison.
  if (primaryQuotaScopeKey === null) {
    for (const cand of profile.candidates) {
      rejected.push({ candidate: cand, routeRef: null, reason: "primary-quota-unknown" });
    }
    return { profile, primaryRoute: primaryRouteRef, usable, rejected, hasUsable: false };
  }

  for (const cand of profile.candidates) {
    // Candidate expiration
    if (cand.expiresAt && new Date(cand.expiresAt).getTime() <= nowMs) {
      rejected.push({ candidate: cand, routeRef: null, reason: "expired" });
      continue;
    }

    // Route identity validation
    let routeRef: RouteRef;
    try {
      routeRef = parseRouteId(cand.route);
    } catch {
      rejected.push({ candidate: cand, routeRef: null, reason: "validation-error" });
      continue;
    }

    // Route must exist in catalog
    const routeConfig = catalog.routes[cand.route];
    if (!routeConfig) {
      rejected.push({ candidate: cand, routeRef, reason: "route-not-configured" });
      continue;
    }

    // Same-harness binding. `executeWithFallback` drives ONE harness, so a
    // candidate from a different harness would be handed to the wrong
    // process (or silently ignored). ADR-0018 promises candidates are bound to
    // the primary's harness; enforce it rather than relying on profile
    // authors, which is the whole point of resolver-side checks.
    if (routeRef.harness !== primaryRouteRef.harness) {
      rejected.push({ candidate: cand, routeRef, reason: "harness-mismatch" });
      continue;
    }

    // Model must be allowed by route or provider
    const allowedModels = routeConfig.models ?? catalog.providers[routeConfig.provider]?.models ?? [];
    if (!allowedModels.includes(cand.model)) {
      rejected.push({ candidate: cand, routeRef, reason: "model-not-allowed" });
      continue;
    }

    const providerConfig = catalog.providers[routeConfig.provider];

    // Provider-wide restriction (e.g. a free tier bound to one client). The
    // route may still carry fresh e2e evidence, but a restricted provider
    // means the allowance is not usable at all, so every route under it is
    // ineligible. Seeding cannot express this: it has no route->provider map.
    if (providerConfig?.restricted) {
      rejected.push({ candidate: cand, routeRef, reason: "provider-restricted" });
      continue;
    }

    // Route-level restriction (e.g. an observed 402 on this exact route).
    // Checked here rather than trusting the seeded per-model attestation,
    // because seeding only covers models listed in that route's e2e array —
    // a restricted route with no e2e (`omp.deepseek`) would otherwise have no
    // seeded entry at all and be judged on the candidate's own claim.
    if (routeConfig.restricted) {
      rejected.push({ candidate: cand, routeRef, reason: "attestation-restricted" });
      continue;
    }

    // Credential source authorization
    const requiresInfisical = providerConfig?.require_infisical ?? false;
    if (requiresInfisical && cand.credential !== "infisical") {
      rejected.push({ candidate: cand, routeRef, reason: "credential-mismatch" });
      continue;
    }
    // `unset` is the schema's own "not authorized (default)". It must never be
    // admitted for any provider: a candidate that names no credential source
    // is not evidence that a credential exists.
    if (cand.credential === "unset") {
      rejected.push({ candidate: cand, routeRef, reason: "credential-mismatch" });
      continue;
    }

    // Billing boundary check. The candidate declares which boundary it is
    // allowed to consume; the provider's catalogued billing is the fact. A
    // declared boundary that does not match the provider's real billing model
    // is rejected (fail closed), and an UNKNOWN billing model is never
    // accepted as `free` — that would let a paid endpoint be labelled free by
    // a mere preference.
    const providerBilling = providerConfig?.billing ?? "unknown";
    if (providerBilling === "unknown") {
      rejected.push({ candidate: cand, routeRef, reason: "billing-unknown" });
      continue;
    }
    if (!billingMatches(cand.billing, providerBilling)) {
      // This also covers the `free`-labelled-paid case: billingMatches returns
      // true for `free` only when the provider is actually `free`, so no
      // separate re-check is needed (nor kept, so no reader mistakes a dead
      // branch for defence in depth).
      rejected.push({ candidate: cand, routeRef, reason: "billing-boundary-crossed" });
      continue;
    }

    // Spend cap checks.
    //   - A `free` candidate that carries a positive cap is a contradiction: a
    //     free route has nothing to cap, and a positive value would silently
    //     authorise spend.
    //   - A profile whose total budget is 0 must not admit any candidate whose
    //     billing boundary can bill at all. Without this, a `metered`/`plan`
    //     candidate with an omitted or zero `max_spend` contributes 0 to the
    //     running total and slips under a 0 budget — the cap would authorise
    //     spend it does not model.
    //   - Under a POSITIVE budget, a billable candidate MUST declare a cap.
    //     Otherwise `totalSpend` counts it as 0 and any budget admits it, so
    //     the "cap" would only bound spend someone remembered to declare.
    if (cand.billing === "free" && (cand.maxSpend ?? 0) > 0) {
      rejected.push({ candidate: cand, routeRef, reason: "spend-cap-invalid" });
      continue;
    }
    const profileBudget = profile.globalMaxSpend ?? null;
    if (profileBudget === 0 && cand.billing !== "free") {
      rejected.push({ candidate: cand, routeRef, reason: "billing-boundary-crossed" });
      continue;
    }
    // Note `== null` covers BOTH `null` (what parseFallbackProfile yields for an
    // absent key) and `undefined` (a programmatic caller): `=== undefined`
    // silently never matched a parsed profile, which is the only real input.
    if (profileBudget !== null && cand.billing !== "free" && cand.maxSpend == null) {
      rejected.push({ candidate: cand, routeRef, reason: "spend-cap-invalid" });
      continue;
    }
    if (cand.maxSpend != null && cand.maxSpend < 0) {
      rejected.push({ candidate: cand, routeRef, reason: "spend-cap-exceeded" });
      continue;
    }
    if (profileBudget !== null && totalSpend + (cand.maxSpend ?? 0) > profileBudget) {
      rejected.push({ candidate: cand, routeRef, reason: "spend-cap-exceeded" });
      continue;
    }

    // Scope escalation: candidate scope must not exceed what the profile allows
    // (Profile itself doesn't have a max scope; this is a per-candidate check against primary)
    // For now, we just ensure the scope is valid.

    // Attestation check
    const attestKey = `${cand.route}#${cand.model}`;
    const attestation = attestations.get(attestKey);

    if (!attestation) {
      rejected.push({ candidate: cand, routeRef, reason: "attestation-unknown" });
      continue;
    }

    // Parse and validate attestation
    let parsedAttestation: Attested<{ status: VerificationStatus; provenance: Provenance; evidence: Evidence }>;
    try {
      parsedAttestation = parseAttested(attestation, `fallback:${attestKey}`);
    } catch {
      rejected.push({ candidate: cand, routeRef, reason: "validation-error" });
      continue;
    }

    // Check attestation status. The contract permits `value: null` when the
    // status is `restricted` (the restriction is the fact), so read the
    // top-level status rather than assuming `value` is an object.
    const attStatus = attestationStatus(parsedAttestation);
    if (attStatus === "restricted") {
      rejected.push({ candidate: cand, routeRef, reason: "attestation-restricted" });
      continue;
    }
    if (attStatus === "unknown") {
      rejected.push({ candidate: cand, routeRef, reason: "attestation-unknown" });
      continue;
    }

    // Check freshness
    if (!isUsable(parsedAttestation, { maxAgeMs: DEFAULT_MAX_EVIDENCE_AGE_MS, now: nowMs })) {
      rejected.push({ candidate: cand, routeRef, reason: "attestation-stale" });
      continue;
    }

    // Quota scope check: a candidate that draws on the SAME allowance as the
    // exhausted primary is not fresh capacity, so it is rejected. The key uses
    // the same route-first, provider-second precedence as `effectiveQuotaKey`
    // (see `effectiveRouteQuotaKey`); comparing by provider scope alone would
    // misjudge a candidate route that declares its own quota. An unknown
    // candidate scope cannot prove independence, so it fails closed.
    const candidateScopeKey = effectiveRouteQuotaKey(catalog, cand.route);
    if (candidateScopeKey === null) {
      rejected.push({ candidate: cand, routeRef, reason: "quota-scope-unknown" });
      continue;
    }
    if (candidateScopeKey === primaryQuotaScopeKey) {
      rejected.push({ candidate: cand, routeRef, reason: "quota-exhausted-scope" });
      continue;
    }

    // All checks passed
    usable.push({ candidate: cand, routeRef, attestation: parsedAttestation });
    if (cand.maxSpend) totalSpend += cand.maxSpend;
  }

  return {
    profile,
    primaryRoute: primaryRouteRef,
    usable,
    rejected,
    hasUsable: usable.length > 0,
  };
}

// ---------------------------------------------------------------------------
// CLI integration helpers
// ---------------------------------------------------------------------------

/** Human-readable summary of a fallback resolution. */
export function renderFallbackResolution(resolution: FallbackResolution): string {
  const lines: string[] = [];
  lines.push(`Fallback Profile: ${resolution.profile.id} (v${resolution.profile.version})`);
  lines.push(`Primary Route: ${formatRouteId(resolution.primaryRoute)}`);
  lines.push(`Authorized: ${resolution.profile.authorizedAt} by ${resolution.profile.authorizedBy}`);
  if (resolution.profile.revoked) lines.push("STATUS: REVOKED");
  else if (resolution.profile.expiresAt && new Date(resolution.profile.expiresAt).getTime() <= Date.now())
    lines.push("STATUS: EXPIRED");
  else if (resolution.hasUsable) lines.push("STATUS: USABLE");
  else lines.push("STATUS: NO USABLE CANDIDATES");

  if (resolution.usable.length > 0) {
    lines.push("\nUsable candidates (in priority order):");
    for (const [i, uc] of resolution.usable.entries()) {
      const c = uc.candidate;
      lines.push(`  ${i + 1}. ${formatRouteId(uc.routeRef)} / ${c.model}`);
      lines.push(`     billing: ${c.billing}, credential: ${c.credential}, scope: ${c.scope}`);
      lines.push(
        `     attestation: ${attestationStatus(uc.attestation)} (${uc.attestation.provenance})`,
      );
      if (c.note) lines.push(`     note: ${c.note}`);
    }
  }

  if (resolution.rejected.length > 0) {
    lines.push("\nRejected candidates:");
    for (const rc of resolution.rejected) {
      const routeStr = rc.routeRef ? formatRouteId(rc.routeRef) : rc.candidate.route;
      lines.push(`  - ${routeStr} / ${rc.candidate.model}: ${rc.reason}`);
    }
  }

  return lines.join("\n");
}
