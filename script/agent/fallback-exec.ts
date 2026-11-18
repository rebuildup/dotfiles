#!/usr/bin/env bun
/**
 * Same-harness fallback execution (dotfiles#139, Epic#86 T021).
 *
 * Implements authorized provider/model switching within the same harness
 * when the primary route becomes unusable. Uses the validated fallback
 * profile from #136 and error classification compatible with #92 (limits.ts).
 *
 * Does NOT implement cross-harness or cross-host migration (those belong to #101).
 */

import {
  ContractError,
  parseRouteId,
  parseTomlTable,
  type RouteRef,
} from "./contract.ts";
import {
  type FallbackProfile,
  type FallbackCandidate,
  type FallbackResolution,
  type ResolvedCandidate,
  type RejectedCandidate,
  type FallbackRejectionReason,
  parseFallbackProfile,
  resolveFallbackProfile,
  buildFallbackCatalog,
  loadCatalogAttestations,
  mergeAttestations,
  seedAttestationsFromCatalog,
} from "./fallback.ts";
import { loadConfig, type Config } from "../agent.ts";
import { getPrimaryQuotaScope, loadCatalog, type Catalog } from "./catalog.ts";
import {
  CATEGORY_FACTS,
  CATEGORY_SEVERITY,
  LIMIT_CATEGORIES,
  classifyFailure as classifyLimitFailure,
  type CategoryFacts,
  type FailureSignal as LimitFailureSignal,
  type LimitCategory,
  type LimitClassification,
} from "./limits.ts";
import { readFileSync } from "node:fs";

// ---------------------------------------------------------------------------
// Error classification — canonical implementation lives in limits.ts (#92).
// This module re-exports the taxonomy and adapts the signal shape: the only
// local addition is `quotaScopeKey`, which limits.ts does not carry.
// ---------------------------------------------------------------------------

export { CATEGORY_FACTS, CATEGORY_SEVERITY, LIMIT_CATEGORIES };
export type { CategoryFacts, LimitCategory };

/** Structured failure evidence. `quotaScopeKey` is fallback-exec's own
 * provenance field; every other field is the canonical limits.ts signal. */
export type FailureSignal = LimitFailureSignal & { quotaScopeKey?: string | null };

/** The classified verdict plus the quota scope it was observed under. */
export interface ClassifiedError extends LimitClassification {
  quotaScopeKey: string | null;
}

/**
 * Classify a failure from structured evidence ONLY, via the canonical
 * limits.ts classifier. `quotaScopeKey` is stripped before classification
 * (limits.ts rejects unknown signal fields) and re-attached to the verdict.
 */
export function classifyFailure(signal: FailureSignal, observedAt: string): ClassifiedError {
  if (!signal || typeof signal !== "object") {
    throw new ContractError("schema", "signal object expected");
  }
  const { quotaScopeKey, ...rest } = signal;
  const base = classifyLimitFailure(rest, observedAt);
  return { ...base, quotaScopeKey: quotaScopeKey ?? null };
}

// ---------------------------------------------------------------------------
// Fallback execution state
// ---------------------------------------------------------------------------

export interface FallbackExecutionState {
  profileId: string;
  primaryRoute: RouteRef;
  primaryModel: string;
  currentCandidateIndex: number;
  usableCandidates: ResolvedCandidate[];
  attemptStartTime: number;
  lastError: ClassifiedError | null;
  retryCount: number;
  maxRetries: number;
  circuitBreakerOpen: boolean;
  circuitBreakerOpenedAt: number | null;
}

export const FALLBACK_CIRCUIT_BREAKER_THRESHOLD = 3;
export const FALLBACK_CIRCUIT_BREAKER_RESET_MS = 60000;
export const FALLBACK_MAX_RETRIES_PER_CANDIDATE = 2;
export const FALLBACK_MAX_TOTAL_RETRIES = 5;

/**
 * Thrown when every usable candidate was exhausted. The classified failure is
 * carried structurally (`lastError`) so a caller can act on the real category
 * (auth, billing, quota-exhausted, ...) instead of re-deriving "unknown" from
 * a blank signal.
 */
export class FallbackExhaustedError extends ContractError {
  /** The last classified failure, or null when no candidate produced evidence. */
  readonly lastError: ClassifiedError | null;

  constructor(profileId: string, lastError: ClassifiedError | null) {
    super("state", `All fallback candidates exhausted for profile ${profileId}. Last error: ${lastError?.category ?? "unknown"}`);
    this.name = "FallbackExhaustedError";
    this.lastError = lastError;
  }
}

/**
 * Execute a task with same-harness fallback support.
 *
 * The primary route is tried first, then the profile's candidates in order.
 * Returns the result of the first attempt that succeeds, or throws when every
 * attempt is exhausted.
 *
 * `candidate` is null for the primary attempt and set for a fallback
 * candidate, so the caller can tell which one it is running.
 */
/** Durable record of one execution attempt, delivered to `onAttempt`
 * immediately after the attempt resolves so a caller can persist it even
 * when the executor later throws (exhaustion, circuit breaker, stop). */
export interface FallbackAttemptRecord {
  route: RouteRef;
  model: string;
  candidate: FallbackCandidate | null;
  success: boolean;
  /** Raw structured failure evidence, when the attempt failed. */
  error: FailureSignal | null;
  /** The classified verdict for `error` (or the success path's null). */
  classified: ClassifiedError | null;
  result: unknown;
}

export interface FallbackExecutionOptions {
  /**
   * The model the task actually requested on the primary route (e.g. a
   * `--model` override). Defaults to the route's declared default. Must be
   * in the route/provider model allowlist — the worker is pinned to it, so
   * recording anything else would misstate what ran.
   */
  primaryModel?: string;
  /** Called after EVERY attempt outcome, in order, before the executor
   * decides whether to retry, advance, or throw. */
  onAttempt?: (record: FallbackAttemptRecord) => void | Promise<void>;
}

export async function executeWithFallback(
  config: Config,
  profileId: string,
  taskFn: (route: RouteRef, model: string, candidate: FallbackCandidate | null) => Promise<{ success: boolean; error?: FailureSignal; result?: unknown }>,
  options: FallbackExecutionOptions = {}
): Promise<{ route: RouteRef; model: string; candidate: FallbackCandidate | null; result: unknown }> {
  // Load and validate profile
  const tomlText = readFileSync(config.path, "utf-8");
  const parsedToml = parseTomlTable(tomlText, config.path);
  const profile = parseFallbackProfile(parsedToml, profileId);
  if (!profile) {
    throw new ContractError("identity", `Fallback profile not found: ${profileId}`);
  }

  // Build the resolver's catalog view from config PLUS the validated catalog
  // facts. Without the catalog, a provider's billing model and shared
  // allowance are unknown, and an unknown billing model is not eligible — so
  // executing on the config alone would be strictly less safe than the CLI
  // preflight it mirrors. Fail closed instead.
  const catalogFacts = loadCatalog(config.path);
  const catalogLike = buildFallbackCatalog(config, catalogFacts);

  // Durable committed evidence first, then local probe state (local wins).
  const attestationMap = mergeAttestations(
    seedAttestationsFromCatalog(catalogFacts),
    loadCatalogAttestations(),
  );

  // Get primary quota scope
  const primaryQuotaScope = getPrimaryQuotaScope(catalogFacts, profile.primaryRoute);

  // Resolve profile
  const resolution = resolveFallbackProfile(profile, catalogLike, attestationMap, primaryQuotaScope);
  // Zero usable candidates is NOT an error: the profile authorizes fallback,
  // it does not require it. A healthy primary must still run normally; the
  // rejected candidates are simply unavailable if the primary fails.
  // (resolution.rejected stays available for callers that want the audit.)

  const primaryRouteRef = parseRouteId(profile.primaryRoute);
  let state: FallbackExecutionState = {
    profileId,
    primaryRoute: primaryRouteRef,
    primaryModel: "",
    currentCandidateIndex: 0,
    usableCandidates: resolution.usable,
    attemptStartTime: Date.now(),
    lastError: null,
    retryCount: 0,
    maxRetries: FALLBACK_MAX_TOTAL_RETRIES,
    circuitBreakerOpen: false,
    circuitBreakerOpenedAt: null,
  };

  // The primary route is tried FIRST: it is the route the task was requested
  // on, and the candidates exist to continue it when the primary is
  // unusable. Executing only the candidates would silently run a different
  // provider than the task asked for.
  const primaryRouteConfig = config.routes[profile.primaryRoute];
  const routeProvider = primaryRouteConfig ? config.providers[primaryRouteConfig.provider] : undefined;
  const allowedModels = primaryRouteConfig?.models ?? routeProvider?.models ?? [];
  let primaryModel: string | null;
  if (options.primaryModel !== undefined) {
    // The worker was already pinned to the requested model at dispatch; the
    // executor must record/run THAT model, not silently substitute the route
    // default. An id outside the allowlist is a caller bug — fail closed.
    if (!allowedModels.includes(options.primaryModel)) {
      throw new ContractError(
        "identity",
        `requested primary model '${options.primaryModel}' is not allowed on route '${profile.primaryRoute}'`,
      );
    }
    primaryModel = options.primaryModel;
  } else {
    primaryModel = primaryRouteConfig?.default_model ?? primaryRouteConfig?.models?.[0] ?? null;
  }
  if (!primaryModel) {
    throw new ContractError(
      "state",
      `primary route '${profile.primaryRoute}' declares no model; refusing to guess one`,
    );
  }
  state.primaryModel = primaryModel;

  // The primary route, then the resolved candidates in order.
  const attempts: Array<{ routeRef: RouteRef; model: string; candidate: FallbackCandidate | null }> = [
    { routeRef: primaryRouteRef, model: primaryModel, candidate: null },
    ...resolution.usable.map(c => ({
      routeRef: c.routeRef,
      model: c.candidate.model,
      candidate: c.candidate,
    })),
  ];

  // Try each attempt in order
  for (let i = 0; i < attempts.length; i++) {
    state.currentCandidateIndex = i;
    const { routeRef, model, candidate } = attempts[i];

    // Check circuit breaker
    if (state.circuitBreakerOpen) {
      const elapsed = Date.now() - (state.circuitBreakerOpenedAt ?? 0);
      if (elapsed > FALLBACK_CIRCUIT_BREAKER_RESET_MS) {
        state.circuitBreakerOpen = false;
        state.circuitBreakerOpenedAt = null;
        state.retryCount = 0;
      } else {
        throw new ContractError("state", `Circuit breaker open for profile ${profileId}; wait ${FALLBACK_CIRCUIT_BREAKER_RESET_MS - elapsed}ms`);
      }
    }

    let candidateRetries = 0;
    while (candidateRetries <= FALLBACK_MAX_RETRIES_PER_CANDIDATE && state.retryCount < state.maxRetries) {
      // Only the task call is guarded: an exception thrown by the task itself
      // carries no structured evidence, so it is classified as unknown. The
      // classification and the fail-fast decision below stay outside this
      // guard, so a deliberate stop is never re-labelled as "unknown".
      let outcome: { success: boolean; error?: FailureSignal; result?: unknown };
      try {
        outcome = await taskFn(routeRef, model, candidate);
      } catch (error) {
        // A ContractError is a launcher/config defect (missing provider,
        // credential, adapter), not provider evidence: it carries its own
        // structured message and must surface unchanged. It must NOT be
        // retried on, or silently advance, to another candidate.
        if (error instanceof ContractError) throw error;
        // Any other exception carries no structured evidence. Record it as
        // unknown and STOP: advancing to another candidate on unknown facts
        // would silently change account/model/billing scope (ADR-0017).
        const classified: ClassifiedError = {
          category: "unknown",
          observedAt: new Date().toISOString(),
          resetAt: null,
          retryAfterMs: null,
          exhausted: false,
          reason: "unexpected error during task execution",
          quotaScopeKey: null,
        };
        state.lastError = classified;
        await options.onAttempt?.({
          route: routeRef, model, candidate,
          success: false, error: null, classified, result: null,
        });
        throw new FallbackExhaustedError(profileId, classified);
      }

      if (outcome.success) {
        await options.onAttempt?.({
          route: routeRef, model, candidate,
          success: true, error: null, classified: null, result: outcome.result ?? null,
        });
        return { route: routeRef, model, candidate, result: outcome.result };
      }

      // Task failed - classify error from structured evidence
      const classified = classifyFailure(outcome.error ?? {}, new Date().toISOString());
      state.lastError = classified;
      await options.onAttempt?.({
        route: routeRef, model, candidate,
        success: false, error: outcome.error ?? null, classified, result: outcome.result ?? null,
      });

      // An unrecognized failure is not evidence that another candidate would
      // fare better, and ADR-0017 forbids silently changing accounts,
      // billing or executing a new mutable attempt on unknown facts. Stop
      // here and report the failure instead of advancing.
      if (classified.category === "unknown") {
        throw new FallbackExhaustedError(profileId, classified);
      }

      // Handle based on category
      const facts = CATEGORY_FACTS[classified.category];
      
      if (facts.transient && classified.retryAfterMs) {
        // Rate limit with explicit retry-after: wait and retry
        await sleep(Math.min(classified.retryAfterMs, 60000));
        candidateRetries++;
        state.retryCount++;
        continue;
      }

      // Non-transient or no retry-after: move to next candidate
      // Quota/billing/auth never auto-retry on same or another paid route
      candidateRetries = FALLBACK_MAX_RETRIES_PER_CANDIDATE + 1;
    }

    // Check if we should open circuit breaker
    state.retryCount++;
    if (state.retryCount >= FALLBACK_CIRCUIT_BREAKER_THRESHOLD) {
      state.circuitBreakerOpen = true;
      state.circuitBreakerOpenedAt = Date.now();
    }
  }

  // All candidates exhausted. The classified failure travels with the error so
  // the caller keeps the real category (auth, billing, quota-exhausted, ...)
  // rather than re-deriving "unknown" from a blank signal.
  throw new FallbackExhaustedError(profileId, state.lastError);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

