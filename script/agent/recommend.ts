#!/usr/bin/env bun
/**
 * Task-aware route recommendation (issue #94, Epic #86 T008).
 *
 * Pure functions only: every input is injected (catalog, measured ledger
 * records, probe reports, live quota observations, reference clock). Nothing
 * here reads the filesystem, touches the network, or launches a process.
 *
 * Design rules (issue invariants, fail-closed throughout):
 *   - Every verdict cites its evidence and provenance. A fact without fresh,
 *     valid evidence is UNKNOWN, never assumed healthy.
 *   - Unknown or stale quota/credential/capability state caps a route at
 *     `conditional` (usable only after verification); it is never `recommended`.
 *   - Provider CAPACITY events (HTTP 402/429, quota exhaustion, observed
 *     restrictions, auth failures) affect AVAILABILITY only and are never
 *     counted as model quality. Quality comes exclusively from measured
 *     ledger outcomes (outcome success AND verification pass).
 *   - Measured and estimated values are kept apart: every reason carries the
 *     provenance of the fact it cites, and cost states which basis it used.
 *   - A user-pinned route is evaluated honestly like any other: a pin never
 *     upgrades a verdict.
 *   - The entire request is validated with strict bounds FIRST; any malformed
 *     field throws `ContractError` instead of producing a ranking.
 */

import {
  ContractError,
  isPlainObject,
  isStale,
  looksLikeSecretValue,
  parseAttested,
  parseModelId,
  parseRouteId,
  redactJson,
  type Attested,
  type Evidence,
  type Provenance,
} from "./contract";
import { modelEntry, type Catalog, type ModelCatalogEntry } from "./catalog";
import { quotaReport, type QuotaReport, type QuotaUsage } from "./quota";
import { parseUsageRecord, type UsageRecord } from "./telemetry";
import {
  PROBE_LAYER_STATUSES,
  PROBE_TTL_MS,
  probeOverall,
  type ProbeFailureKind,
  type ProbeLayerResult,
  type ProbeReport,
} from "./probe";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Recommendation strength, in decreasing order. `deprecated` = known
 * negatives that do not hard-block; `unavailable` = hard blocker. */
export type Verdict = "recommended" | "conditional" | "deprecated" | "unavailable";

/** What the caller needs the route to do. Unknown capability requirements
 * (null) never gate; known requirements fail closed. */
export interface TaskRequest {
  /** Opaque non-secret task id (matches telemetry `UsageRecord.task`). */
  id: string;
  /** Task needs tool calling. */
  requiresToolCall: boolean;
  /** Context the task needs, in tokens; null when not a requirement. */
  contextTokens: number | null;
  /** Judgement needs: drives the quality/cost/latency weight mix. */
  complexity: "low" | "standard" | "high";
  /** Hard per-task spend cap in USD; null when unrestricted. Only USD costs
   * are compared — other currencies are NEVER converted (no guessed FX). */
  budgetUsd: number | null;
  /** Parallel workers the task wants (default 1). */
  workers: number;
  /** Explicitly pinned route; only this route is evaluated, and its pin
   * never upgrades an honest verdict. */
  fixedRoute: string | null;
}

/** One evidence-backed statement contributing to a verdict. `provenance` is
 * null only for structural facts (e.g. "route not in catalog") that are not
 * attested values. */
export interface Reason {
  kind:
    | "capability"
    | "quality"
    | "cost"
    | "latency"
    | "quota"
    | "concurrency"
    | "budget"
    | "probe"
    | "evidence"
    | "pin";
  impact: "positive" | "negative" | "neutral" | "blocking";
  detail: string;
  provenance: Provenance | null;
  evidence: Evidence | null;
}

export interface RouteRecommendation {
  routeId: string;
  /** Model the recommendation applies to (latest probe, else latest measured
   * record); null when no evidence names one — capability facts are then
   * unknown and cap the verdict. */
  model: string | null;
  verdict: Verdict;
  /** 0..1, relative to the evaluated candidate set; null when no scored
   * component had data. */
  score: number | null;
  /** 1-based position in `Recommendation.routes` (best first). */
  rank: number;
  /** Decided measured outcomes used for the quality component. */
  sampleSize: number;
  confidence: "none" | "low" | "medium" | "high";
  reasons: Reason[];
  /** Routes ranked above this one that are usable (recommended/conditional);
   * empty for the best usable route and for pinned evaluations. */
  alternatives: string[];
}

export interface Recommendation {
  task: {
    id: string;
    complexity: TaskRequest["complexity"];
    requiresToolCall: boolean;
    contextTokens: number | null;
    budgetUsd: number | null;
    workers: number;
    fixedRoute: string | null;
  };
  /** ISO 8601 UTC derived from the reference clock. */
  generatedAt: string;
  /** Ranked best-first: recommended, then conditional, deprecated,
   * unavailable; ties by score desc, then route id. */
  routes: RouteRecommendation[];
  knownLimitations: string[];
}

export interface RecommendInput {
  task: TaskRequest;
  catalog: Catalog;
  /** Measured ledger records (validated with telemetry `parseUsageRecord`;
   * a malformed record throws — hostile input never silently narrows). */
  records?: readonly unknown[];
  /** Probe reports; the latest per route (by report time) is used. */
  probes?: readonly unknown[];
  /** Live quota observations (quota.ts `QuotaUsage` shape). */
  live?: readonly unknown[];
  /** Reference clock (ms epoch); defaults to Date.now(). */
  now?: number;
  /** Freshness window for catalog facts; defaults to contract
   * DEFAULT_MAX_EVIDENCE_AGE_MS. May be tightened, never removed. */
  maxAgeMs?: number;
}

/** Honest, static scope statement shipped with every recommendation. */
export const RECOMMEND_KNOWN_LIMITATIONS: readonly string[] = [
  "Scores are relative to the evaluated candidate set, not absolute quality.",
  "Cost mixes billed (measured) and catalog-price-derived (estimated) bases; every cost reason states its basis via provenance.",
  "Provider capacity events (HTTP 402/429, quota exhaustion, observed restrictions, auth failures) affect availability only and are never counted as model quality.",
  "A route whose quota or credential state is unknown or stale is never marked recommended; it is capped at conditional pending verification.",
  "Only USD budgets are enforced; costs in other currencies are never converted.",
];

// ---------------------------------------------------------------------------
// Input validation (fail closed, strict bounds, hostile-input safe)
// ---------------------------------------------------------------------------

const ID_MAX = 128;
/** Sanity ceiling for required context tokens (100 Mtok — far above any real
 * window; rejects Infinity-class hostile values without rejecting real ones). */
const CONTEXT_TOKENS_MAX = 100_000_000;
const BUDGET_MAX = 1e9;
const WORKERS_MAX = 1024;

function reqFinite(value: unknown, where: string, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ContractError("schema", `${where} must be a finite number`);
  }
  if (value < 0) throw new ContractError("schema", `${where} must be non-negative`);
  if (value > max) throw new ContractError("schema", `${where} must be at most ${max}`);
  return value;
}

function reqPositiveInt(value: unknown, where: string, max: number): number {
  const n = reqFinite(value, where, max);
  if (!Number.isInteger(n) || n <= 0) {
    throw new ContractError("schema", `${where} must be a positive integer`);
  }
  return n;
}

function checkTaskRequest(raw: unknown): TaskRequest {
  if (!isPlainObject(raw)) throw new ContractError("schema", "task must be a table");
  const unknown = Object.keys(raw).filter(
    (k) =>
      ![
        "id",
        "requiresToolCall",
        "contextTokens",
        "complexity",
        "budgetUsd",
        "workers",
        "fixedRoute",
      ].includes(k),
  );
  if (unknown.length > 0) {
    throw new ContractError("schema", `task: unknown field '${unknown[0]}'`);
  }
  const id = raw["id"];
  if (typeof id !== "string" || id.length === 0 || id.trim().length === 0) {
    throw new ContractError("schema", "task.id must be a non-empty string");
  }
  if (id.length > ID_MAX) {
    throw new ContractError("schema", `task.id must be at most ${ID_MAX} characters`);
  }
  if (looksLikeSecretValue(id)) {
    throw new ContractError("schema", "task.id must not be a secret-shaped value");
  }
  const requiresToolCall = raw["requiresToolCall"];
  if (typeof requiresToolCall !== "boolean") {
    throw new ContractError("schema", "task.requiresToolCall must be a boolean");
  }
  const contextRaw = raw["contextTokens"];
  const contextTokens =
    contextRaw === null || contextRaw === undefined
      ? null
      : reqPositiveInt(contextRaw, "task.contextTokens", CONTEXT_TOKENS_MAX);
  const complexity = raw["complexity"];
  if (complexity !== "low" && complexity !== "standard" && complexity !== "high") {
    throw new ContractError("schema", "task.complexity must be low|standard|high");
  }
  const budgetRaw = raw["budgetUsd"];
  const budgetUsd =
    budgetRaw === null || budgetRaw === undefined
      ? null
      : reqFinite(budgetRaw, "task.budgetUsd", BUDGET_MAX);
  const workers = reqPositiveInt(raw["workers"] ?? 1, "task.workers", WORKERS_MAX);
  const fixedRaw = raw["fixedRoute"];
  let fixedRoute: string | null = null;
  if (fixedRaw !== null && fixedRaw !== undefined) {
    const parsed = requireStr(fixedRaw, "task.fixedRoute");
    parseRouteId(parsed); // identity validation only; the string is the id
    fixedRoute = parsed;
  }
  return { id, requiresToolCall, contextTokens, complexity, budgetUsd, workers, fixedRoute };
}

function requireStr(value: unknown, where: string): string {
  if (typeof value !== "string") throw new ContractError("schema", `${where} must be a string`);
  return value;
}

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

function checkIsoUtc(value: string, where: string): number {
  const ms = Date.parse(value);
  if (!ISO_UTC.test(value) || !Number.isFinite(ms)) {
    throw new ContractError("schema", `${where} must be an ISO 8601 UTC timestamp`);
  }
  return ms;
}

/** Structural validation of an injected probe report. Only fields this module
 * consumes are enforced; anything malformed throws (fail closed). */
function checkProbeReport(raw: unknown, where: string): ProbeReport {
  if (!isPlainObject(raw)) throw new ContractError("schema", `${where} must be a table`);
  const route = parseRouteId(requireStr(raw["route"], `${where}.route`));
  const model = parseModelId(requireStr(raw["model"], `${where}.model`));
  checkIsoUtc(requireStr(raw["time"], `${where}.time`), `${where}.time`);
  const layersRaw = raw["layers"];
  if (!Array.isArray(layersRaw) || layersRaw.length === 0) {
    throw new ContractError("schema", `${where}.layers must be a non-empty array`);
  }
  const layers: ProbeLayerResult[] = layersRaw.map((item, i) => {
    const w = `${where}.layers[${i}]`;
    if (!isPlainObject(item)) throw new ContractError("schema", `${w} must be a table`);
    const layer = requireStr(item["layer"], `${w}.layer`);
    const status = requireStr(item["status"], `${w}.status`);
    if (!(PROBE_LAYER_STATUSES as readonly string[]).includes(status)) {
      throw new ContractError("schema", `${w}.status must be one of ${PROBE_LAYER_STATUSES.join("|")}`);
    }
    const failure = item["failure"];
    if (failure !== undefined && failure !== null && (typeof failure !== "string" || failure === "")) {
      throw new ContractError("schema", `${w}.failure must be a non-empty string when present`);
    }
    const out: ProbeLayerResult = {
      layer: layer as ProbeLayerResult["layer"],
      status: status as ProbeLayerResult["status"],
      evidence: null,
    };
    if (failure !== undefined && failure !== null) out.failure = failure as ProbeFailureKind;
    return out;
  });
  return {
    contract_version: requireStr(raw["contract_version"], `${where}.contract_version`),
    source: "probe",
    route: `${route.harness}.${route.provider}`,
    model,
    mode: "live",
    transport: "unknown",
    time: requireStr(raw["time"], `${where}.time`),
    duration_ms: 0,
    quota_scope: null,
    layers,
    cached: false,
  };
}

// ---------------------------------------------------------------------------
// Evidence helpers
// ---------------------------------------------------------------------------

/** A catalog attestation may be used when it parses under the contract matrix,
 * carries evidence, and that evidence is fresh (quota.ts `freshAttestation`
 * semantics: catalog facts are configured/official, so verified-live is not
 * required — but staleness still expires them, fail-closed). */
function freshFact<T>(att: Attested<T> | null, now: number, maxAgeMs: number): att is Attested<T> & { evidence: Evidence; value: T } {
  if (!att || att.value === null || att.value === undefined) return false;
  try {
    parseAttested(att, "recommend");
  } catch {
    return false;
  }
  if (!att.evidence) return false;
  return !isStale(att.evidence, now, maxAgeMs);
}

// ---------------------------------------------------------------------------
// Measured route stats (from telemetry records; route via attempt key)
// ---------------------------------------------------------------------------

interface RouteStats {
  /** All decided measured outcomes (success|failure|killed). */
  decided: number;
  /** outcome success AND verification pass — unverified successes never
   * count as success (telemetry semantics). */
  verifiedSuccesses: number;
  successRate: number | null;
  /** True when the stats came from records for THIS task id; false when
   * they fell back to route-wide records (always disclosed). */
  taskMatched: boolean;
  /** Average billed USD cost per decided attempt; null when none. */
  measuredCostUsd: number | null;
  /** Non-USD currencies seen in measured costs (never converted). */
  otherCurrencies: string[];
  /** Average wall time over records that carry one; null when none. */
  avgWallMs: number | null;
  /** Average effective tokens ((prompt - cache_read) + output) over records
   * with usage; null when none. */
  avgEffectiveTokens: number | null;
}

function routeOf(rec: UsageRecord): string {
  return rec.attempt.split("#")[0];
}

function computeRouteStats(records: readonly UsageRecord[], routeId: string, taskId: string): RouteStats {
  const routeRecords = records.filter((rec) => routeOf(rec) === routeId);
  const taskRecords = routeRecords.filter((rec) => rec.task === taskId);
  const use = taskRecords.length > 0 ? taskRecords : routeRecords;
  const taskMatched = taskRecords.length > 0;

  let verifiedSuccesses = 0;
  let billedUsd = 0;
  let billedUsdCount = 0;
  let wallSum = 0;
  let wallCount = 0;
  let tokenSum = 0;
  let tokenCount = 0;
  const otherCurrencies = new Set<string>();

  for (const rec of use) {
    if (rec.outcome === "success" && rec.verification === "pass") verifiedSuccesses++;
    if (rec.cost) {
      if (rec.cost.currency === "USD") {
        if (rec.cost.basis === "billed") {
          billedUsd += rec.cost.amount;
          billedUsdCount++;
        }
        // estimated-basis record costs are already derivations; the catalog
        // price path below is the single estimated source here.
      } else {
        otherCurrencies.add(rec.cost.currency);
      }
    }
    if (rec.wall_time_ms !== null) {
      wallSum += rec.wall_time_ms;
      wallCount++;
    }
    if (rec.usage) {
      tokenSum += Math.max(0, rec.usage.prompt - rec.usage.cache_read) + rec.usage.output;
      tokenCount++;
    }
  }

  const decided = use.length;
  const measuredCostUsd = billedUsdCount > 0 ? billedUsd / billedUsdCount : null;
  const avgEffectiveTokens = tokenCount > 0 ? tokenSum / tokenCount : null;
  const avgWallMs = wallCount > 0 ? wallSum / wallCount : null;

  return {
    decided,
    verifiedSuccesses,
    successRate: decided === 0 ? null : verifiedSuccesses / decided,
    taskMatched,
    measuredCostUsd,
    otherCurrencies: [...otherCurrencies].sort(),
    avgWallMs,
    avgEffectiveTokens,
  };
}

// ---------------------------------------------------------------------------
// Per-route evaluation
// ---------------------------------------------------------------------------

interface Evaluated {
  routeId: string;
  model: string | null;
  qr: QuotaReport;
  stats: RouteStats;
  /** Hard blocker; when set the verdict is `unavailable`. */
  blocking: Reason | null;
  /** Downgrade caps (verdict may be lowered, never raised, by these). */
  caps: Reason[];
  positives: Reason[];
  /** USD cost per task used for the cost component, with its basis. */
  costUsd: number | null;
  costBasis: "measured" | "estimated" | null;
  costEvidence: Evidence | null;
}

const VERDICT_ORDER: Record<Verdict, number> = {
  recommended: 0,
  conditional: 1,
  deprecated: 2,
  unavailable: 3,
};

/** A cap's floor via its impact: negative -> deprecated, neutral ->
 * conditional. Blocking never reaches here (hard gate). */
function capVerdict(cap: Reason): Verdict {
  return cap.impact === "negative" ? "deprecated" : "conditional";
}

function applyCap(current: Verdict, cap: Reason): Verdict {
  return capFloor(current, capVerdict(cap));
}

/** Lower `current` to `floor` when the floor is weaker; never raise. */
function capFloor(current: Verdict, floor: Verdict): Verdict {
  return VERDICT_ORDER[floor] > VERDICT_ORDER[current] ? floor : current;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

const WEIGHTS: Record<TaskRequest["complexity"], { quality: number; cost: number; latency: number }> = {
  low: { quality: 0.4, cost: 0.4, latency: 0.2 },
  standard: { quality: 0.5, cost: 0.3, latency: 0.2 },
  high: { quality: 0.7, cost: 0.2, latency: 0.1 },
};

/** Confidence from the measured sample size behind the quality component. */
function confidenceFor(sampleSize: number): RouteRecommendation["confidence"] {
  if (sampleSize <= 0) return "none";
  if (sampleSize < 5) return "low";
  if (sampleSize < 20) return "medium";
  return "high";
}

/**
 * Rank candidate routes for one task. See the module header for the
 * invariants; every returned verdict carries its evidence.
 */
export function recommend(input: RecommendInput): Recommendation {
  const task = checkTaskRequest(input.task);
  const now = input.now ?? Date.now();
  if (typeof now !== "number" || !Number.isFinite(now) || now < 0) {
    throw new ContractError("schema", "now must be a non-negative finite number");
  }
  const maxAgeMs = input.maxAgeMs ?? 7 * 24 * 60 * 60 * 1000;
  if (!Number.isFinite(maxAgeMs) || maxAgeMs <= 0) {
    throw new ContractError("schema", "maxAgeMs must be a positive number");
  }
  const catalog = input.catalog;
  if (!isPlainObject(catalog) || !isPlainObject(catalog.providers)) {
    throw new ContractError("schema", "catalog must be a loaded Catalog");
  }

  // Records: validated up front — a malformed record throws rather than
  // silently shrinking the measured evidence base.
  const records: UsageRecord[] = (input.records ?? []).map((raw, i) =>
    parseUsageRecord(raw, `recommend.records[${i}]`),
  );

  // Probes: latest per route by report time; malformed reports throw.
  const probeByRoute = new Map<string, { report: ProbeReport; ms: number }>();
  (input.probes ?? []).forEach((raw, i) => {
    const report = checkProbeReport(raw, `recommend.probes[${i}]`);
    const ms = checkIsoUtc(report.time, `recommend.probes[${i}].time`);
    const prev = probeByRoute.get(report.route);
    if (!prev || ms >= prev.ms) probeByRoute.set(report.route, { report, ms });
  });

  // Live quota observations are validated inside quotaReport (fail-closed drop).
  const live = input.live ?? [];

  // Candidates: catalogued routes plus any route with measured/probe
  // evidence; a pinned task evaluates ONLY the pinned route.
  let candidates: string[];
  if (task.fixedRoute !== null) {
    candidates = [task.fixedRoute];
  } else {
    const set = new Set<string>(Object.keys(catalog.routes ?? {}));
    for (const rec of records) set.add(routeOf(rec));
    for (const route of probeByRoute.keys()) set.add(route);
    candidates = [...set].sort();
  }

  const evaluated: Evaluated[] = candidates.map((routeId) =>
    evaluateRoute({ routeId, task, catalog, records, probeByRoute, live, now, maxAgeMs }),
  );

  // Relative cost/latency normalization needs the whole candidate set.
  const costValues = evaluated.map((e) => e.costUsd).filter((v): v is number => v !== null && v > 0);
  const minCost = costValues.length > 0 ? Math.min(...costValues) : null;
  const wallValues = evaluated.map((e) => e.stats.avgWallMs).filter((v): v is number => v !== null && v > 0);
  const minWall = wallValues.length > 0 ? Math.min(...wallValues) : null;

  const weights = WEIGHTS[task.complexity];
  const routes: RouteRecommendation[] = evaluated.map((e) => finalizeRoute(e, { task, minCost, minWall, weights }));

  routes.sort((a, b) => {
    const va = VERDICT_ORDER[a.verdict];
    const vb = VERDICT_ORDER[b.verdict];
    if (va !== vb) return va - vb;
    const sa = a.score ?? -1;
    const sb = b.score ?? -1;
    if (sa !== sb) return sb - sa;
    return a.routeId < b.routeId ? -1 : a.routeId > b.routeId ? 1 : 0;
  });
  routes.forEach((r, i) => (r.rank = i + 1));

  const usable = routes.filter((r) => r.verdict === "recommended" || r.verdict === "conditional");
  for (const r of routes) {
    r.alternatives =
      task.fixedRoute !== null
        ? []
        : usable.filter((other) => other.routeId !== r.routeId && other.rank < r.rank).map((other) => other.routeId);
  }

  return {
    task: {
      id: task.id,
      complexity: task.complexity,
      requiresToolCall: task.requiresToolCall,
      contextTokens: task.contextTokens,
      budgetUsd: task.budgetUsd,
      workers: task.workers,
      fixedRoute: task.fixedRoute,
    },
    generatedAt: new Date(now).toISOString(),
    routes,
    knownLimitations: [...RECOMMEND_KNOWN_LIMITATIONS],
  };
}

function evaluateRoute(args: {
  routeId: string;
  task: TaskRequest;
  catalog: Catalog;
  records: readonly UsageRecord[];
  probeByRoute: Map<string, { report: ProbeReport; ms: number }>;
  live: readonly unknown[];
  now: number;
  maxAgeMs: number;
}): Evaluated {
  const { routeId, task, catalog, records, probeByRoute, live, now, maxAgeMs } = args;
  // Live observations are validated inside quotaReport (fail-closed drop); the
  // cast only bridges the injected `unknown[]` to the declared parameter type.
  const qr = quotaReport(catalog, routeId, { live: live as readonly QuotaUsage[], now, maxAgeMs });

  // Model resolution: latest probe report, else latest measured record.
  const probeEntry = probeByRoute.get(routeId) ?? null;
  let model: string | null = probeEntry ? probeEntry.report.model : null;
  if (model === null) {
    let latest: UsageRecord | null = null;
    for (const rec of records) {
      if (routeOf(rec) !== routeId) continue;
      if (latest === null || rec.started_at > latest.started_at) latest = rec;
    }
    model = latest === null ? null : latest.attempt.split("#")[1];
  }

  const stats = computeRouteStats(records, routeId, task.id);
  const blocking: Reason[] = [];
  const caps: Reason[] = [];
  const positives: Reason[] = [];

  // --- Catalog restriction (observed block; 402/429-shaped evidence lives
  // here too — availability, never quality).
  const routeEntry = catalog.routes[routeId] ?? null;
  const providerKey = routeId.slice(routeId.indexOf(".") + 1);
  const provider = catalog.providers[providerKey] ?? null;
  const restrictionAtt = routeEntry?.restriction ?? provider?.restriction ?? null;
  if (restrictionAtt && restrictionAtt.status === "restricted" && restrictionAtt.note) {
    let ev: Evidence | null = null;
    try {
      ev = parseAttested(restrictionAtt as Attested<null>, `recommend(${routeId}).restriction`).evidence;
    } catch {
      ev = null;
    }
    if (ev && !isStale(ev, now, maxAgeMs)) {
      blocking.push(
        {
          kind: "quota",
          impact: "blocking",
          detail: `observed restriction on this route: ${restrictionAtt.note}`,
          provenance: restrictionAtt.provenance,
          evidence: ev,
        },
      );
    }
  }

  // --- Probe evidence: any failing layer blocks availability (auth,
  // payment, rate-limit, ...). A capacity/auth failure is NEVER a model
  // quality signal. Reports older than the probe TTL are stale evidence:
  // the route state is UNKNOWN now, which downgrades (never blocks forever,
  // never counts as healthy).
  if (probeEntry) {
    const fresh = probeEntry.ms >= now - PROBE_TTL_MS;
    if (!fresh) {
      caps.push({
        kind: "probe",
        impact: "neutral",
        detail: `probe evidence from ${probeEntry.report.time} is outside the ${PROBE_TTL_MS}ms TTL — route state unknown, verify before use`,
        provenance: null,
        evidence: null,
      });
    } else {
      const overall = probeOverall(probeEntry.report);
      if (overall.state === "failed") {
        const layer = probeEntry.report.layers.find((l) => l.status === "fail");
        blocking.push({
          kind: "probe",
          impact: "blocking",
          detail: `probe failed at layer '${overall.layer}' (${overall.failure}) — availability, not model quality`,
          provenance: "measured",
          evidence: layer?.evidence ?? null,
        });
      } else if (overall.state === "stale") {
        caps.push({
          kind: "probe",
          impact: "neutral",
          detail: `probe evidence stale at layer '${overall.layer}' — route state unknown, verify before use`,
          provenance: null,
          evidence: null,
        });
      } else {
        positives.push({
          kind: "probe",
          impact: "positive",
          detail: `probe passed through layer '${overall.state}'`,
          provenance: "measured",
          evidence: probeEntry.report.layers[probeEntry.report.layers.length - 1]?.evidence ?? null,
        });
      }
    }
  }

  // --- Quota state: exhaustion blocks; unknown quota caps at conditional.
  if (qr.restriction) {
      blocking.push({
        kind: "quota",
        impact: "blocking",
        detail: `observed quota restriction: ${qr.restriction.note}`,
        provenance: "measured",
        evidence: qr.restriction.evidence,
      });
  }
  const exhausted = qr.live.find((u) => u.remaining === 0);
  if (exhausted) {
    blocking.push({
      kind: "quota",
      impact: "blocking",
      detail: `quota exhausted (${exhausted.window}${exhausted.metric ? ` ${exhausted.metric}` : ""} window)${
        exhausted.resetAt ? `, resets ${exhausted.resetAt}` : ""
      } — capacity, not model quality`,
      provenance: "measured",
      evidence: exhausted.evidence,
    });
  }
  const quotaKnown = qr.scopeKey !== null || qr.live.length > 0 || qr.documented.length > 0;
  if (!quotaKnown) {
      caps.push({
        kind: "quota",
        impact: "neutral",
        detail: "quota state unknown (no scope, documented limit or live observation) — never treated as available",
        provenance: null,
        evidence: null,
      });
  }

  // --- Capability facts (model-dependent; unknown model => unknown facts).
  const me: ModelCatalogEntry | null = model === null ? null : modelEntry(catalog, routeId, model);
  const toolCall = me?.tool_call ?? null;
  if (task.requiresToolCall) {
    if (freshFact(toolCall, now, maxAgeMs)) {
      if (toolCall.value === true) {
        positives.push({
          kind: "capability",
          impact: "positive",
          detail: `tool-call support verified for model '${model}'`,
          provenance: toolCall.provenance,
          evidence: toolCall.evidence,
        });
      } else {
        blocking.push({
          kind: "capability",
          impact: "blocking",
          detail: `model '${model}' does not support tool calls (required)`,
          provenance: toolCall.provenance,
          evidence: toolCall.evidence,
        });
      }
    } else {
      caps.push({
        kind: "capability",
        impact: "neutral",
        detail: model === null
          ? "no model evidence for this route — tool-call support unverified (required)"
          : `tool-call support for model '${model}' is unknown or stale (required)`,
        provenance: null,
        evidence: null,
      });
    }
  }

  const contextWindow = me?.context_window ?? null;
  if (task.contextTokens !== null) {
    if (freshFact(contextWindow, now, maxAgeMs)) {
      if (contextWindow.value >= task.contextTokens) {
        positives.push({
          kind: "capability",
          impact: "positive",
          detail: `enforced context window ${contextWindow.value} >= required ${task.contextTokens}`,
          provenance: contextWindow.provenance,
          evidence: contextWindow.evidence,
        });
      } else {
        blocking.push({
          kind: "capability",
          impact: "blocking",
          detail: `enforced context window ${contextWindow.value} < required ${task.contextTokens}`,
          provenance: contextWindow.provenance,
          evidence: contextWindow.evidence,
        });
      }
    } else {
      caps.push({
        kind: "capability",
        impact: "neutral",
        detail: "context window unknown or stale — large-context requirement cannot be verified",
        provenance: null,
        evidence: null,
      });
    }
  }

  // --- Concurrency vs requested workers (documented limits only).
  if (qr.concurrency) {
    if (qr.concurrency.value < task.workers) {
      caps.push({
        kind: "concurrency",
        impact: "neutral",
        detail: `documented concurrency ${qr.concurrency.value} < ${task.workers} requested workers`,
        provenance: "official",
        evidence: qr.concurrency.evidence,
      });
    }
  } else if (task.workers > 1) {
    caps.push({
      kind: "concurrency",
      impact: "neutral",
      detail: "documented concurrency unknown — parallel use unverified",
      provenance: null,
      evidence: null,
    });
  }

  // --- Discouraged use (config-declared judgment, provenance estimated).
  const discouraged = me?.discouraged_reason ?? null;
  if (freshFact(discouraged, now, maxAgeMs)) {
    caps.push({
      kind: "capability",
      impact: "neutral",
      detail: `discouraged for this use: ${discouraged.value}`,
      provenance: discouraged.provenance,
      evidence: discouraged.evidence,
    });
  }

  // --- Cost basis (USD only; measured billed cost wins over the catalog
  // estimate; currencies are never converted).
  let costUsd: number | null = stats.measuredCostUsd;
  let costBasis: "measured" | "estimated" | null = costUsd !== null ? "measured" : null;
  let costEvidence: Evidence | null = null;
  const pricing = me?.pricing ?? null;
  if (costUsd === null && pricing && freshFact(pricing.input_per_mtok, now, maxAgeMs) && freshFact(pricing.output_per_mtok, now, maxAgeMs) && stats.avgEffectiveTokens !== null) {
    if (pricing.currency === "USD" || pricing.currency === null) {
      const perMtok = (pricing.input_per_mtok.value + pricing.output_per_mtok.value) as number;
      costUsd = (perMtok * stats.avgEffectiveTokens) / 1_000_000;
      costBasis = "estimated";
      costEvidence = pricing.input_per_mtok.evidence;
    }
  }

  return {
    routeId,
    model,
    qr,
    stats,
    blocking: blocking[0] ?? null,
    caps,
    positives,
    costUsd,
    costBasis,
    costEvidence,
  };
}

function finalizeRoute(
  e: Evaluated,
  ctx: {
    task: TaskRequest;
    minCost: number | null;
    minWall: number | null;
    weights: { quality: number; cost: number; latency: number };
  },
): RouteRecommendation {
  const { task, minCost, minWall, weights } = ctx;
  const reasons: Reason[] = [...e.positives, ...e.caps];
  let verdict: Verdict = "recommended";

  // Hard blockers first.
  if (e.blocking) {
    reasons.unshift(e.blocking);
    verdict = "unavailable";
  }

  // Downgrade caps: a cap may lower the verdict, never raise it.
  for (const cap of e.caps) {
    reasons.push(cap);
    verdict = applyCap(verdict, cap);
  }

  // Budget enforcement (USD only, never converted).
  if (verdict !== "unavailable" && task.budgetUsd !== null) {
    if (e.costBasis === "measured" && e.costUsd !== null) {
      if (e.costUsd > task.budgetUsd) {
        reasons.unshift({
          kind: "budget",
          impact: "blocking",
          detail: `measured cost $${e.costUsd.toFixed(6)}/task exceeds budget $${task.budgetUsd}`,
          provenance: "measured",
          evidence: null,
        });
        verdict = "unavailable";
      }
    } else if (e.costBasis === "estimated" && e.costUsd !== null) {
      if (e.costUsd > task.budgetUsd) {
        reasons.unshift({
          kind: "budget",
          impact: "blocking",
          detail: `estimated cost $${e.costUsd.toFixed(6)}/task (catalog prices) exceeds budget $${task.budgetUsd}`,
          provenance: "estimated",
          evidence: e.costEvidence,
        });
        verdict = "unavailable";
      }
    } else {
      const detail =
        e.stats.otherCurrencies.length > 0
          ? `measured costs are in ${e.stats.otherCurrencies.join(", ")} — never converted to USD, affordability unverifiable`
          : "no USD cost data — affordability against the budget unverifiable";
      reasons.push({ kind: "budget", impact: "neutral", detail, provenance: null, evidence: null });
      verdict = applyCap(verdict, reasons[reasons.length - 1]);
    }
  }

  // Quality component: measured outcomes only; 0 samples never counts as good.
  let score: number | null = null;
  const components: Array<{ weight: number; value: number }> = [];
  if (e.stats.successRate !== null) {
    components.push({ weight: weights.quality, value: e.stats.successRate });
    if (e.stats.successRate < 0.5) {
      reasons.push({
        kind: "quality",
        impact: "negative",
        detail: `measured success rate ${e.stats.verifiedSuccesses}/${e.stats.decided} = ${(e.stats.successRate * 100).toFixed(0)}% is below 50%`,
        provenance: "measured",
        evidence: null,
      });
      verdict = applyCap(verdict, reasons[reasons.length - 1]);
    } else if (e.stats.verifiedSuccesses > 0) {
      reasons.push({
        kind: "quality",
        impact: "positive",
        detail: `measured success rate ${e.stats.verifiedSuccesses}/${e.stats.decided} = ${(e.stats.successRate * 100).toFixed(0)}%`,
        provenance: "measured",
        evidence: null,
      });
    }
  } else {
    reasons.push({
      kind: "quality",
      impact: "neutral",
      detail: "no measured outcomes — quality unknown, never assumed healthy",
      provenance: null,
      evidence: null,
    });
    verdict = applyCap(verdict, reasons[reasons.length - 1]);
  }
  if (!e.stats.taskMatched && e.stats.decided > 0) {
    reasons.push({
      kind: "quality",
      impact: "neutral",
      detail: `no measured outcomes for task '${task.id}' — using ${e.stats.decided} route-wide outcome(s)`,
      provenance: "measured",
      evidence: null,
    });
  }

  // Cost component (relative to cheapest usable candidate).
  if (e.costUsd !== null && e.costBasis !== null) {
    if (minCost !== null && e.costUsd > 0) {
      const value = minCost / e.costUsd;
      components.push({ weight: weights.cost, value });
      if (e.costUsd > 3 * minCost) {
        reasons.push({
          kind: "cost",
          impact: "negative",
          detail: `${e.costBasis} cost $${e.costUsd.toFixed(6)}/task is more than 3x the cheapest candidate ($${minCost.toFixed(6)})`,
          provenance: e.costBasis === "measured" ? "measured" : "estimated",
          evidence: e.costEvidence,
        });
        // Cost is an efficiency concern: cap at conditional (quality failures
        // are what deprecate a route). High-complexity tasks weight quality
        // so heavily that cost alone never caps the verdict.
        if (task.complexity !== "high") {
          verdict = capFloor(verdict, "conditional");
        }
      }
    } else if (e.costUsd === 0) {
      components.push({ weight: weights.cost, value: 1 });
    }
  } else if (task.budgetUsd === null) {
    reasons.push({
      kind: "cost",
      impact: "neutral",
      detail: "no USD cost basis (no billed cost, usable pricing, or measured tokens) — cost unknown",
      provenance: null,
      evidence: null,
    });
  }

  // Latency component (measured wall time only).
  if (e.stats.avgWallMs !== null) {
    if (minWall !== null && e.stats.avgWallMs > 0) {
      components.push({ weight: weights.latency, value: minWall / e.stats.avgWallMs });
    } else if (e.stats.avgWallMs === 0) {
      components.push({ weight: weights.latency, value: 1 });
    }
  }

  if (components.length > 0) {
    const wsum = components.reduce((acc, c) => acc + c.weight, 0);
    score = components.reduce((acc, c) => acc + c.weight * c.value, 0) / wsum;
  }

  // Pinned routes are evaluated honestly; record the pin so the output
  // cannot be read as a free recommendation.
  if (task.fixedRoute === e.routeId) {
    reasons.push({
      kind: "pin",
      impact: "neutral",
      detail: "route explicitly pinned by the task — evaluated as-is, pin never upgrades the verdict",
      provenance: null,
      evidence: null,
    });
  }

  return {
    routeId: e.routeId,
    model: e.model,
    verdict,
    score,
    rank: 0,
    sampleSize: e.stats.decided,
    confidence: confidenceFor(e.stats.decided),
    reasons,
    alternatives: [],
  };
}

/** Machine-readable recommendation (JSON). Passed through contract redaction
 * so a secret-shaped stray value can never land in output. */
export function recommendJson(result: Recommendation): string {
  return redactJson(result);
}
