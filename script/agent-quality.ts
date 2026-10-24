import { readFile } from "node:fs/promises";

export const QUALITY_EVALUATION_VERSION = "agent-e2e-v8";
export type FailureKind = "capability" | "api" | "quota" | "auth" | "launcher";
export interface Trial {
  id: string;
  evaluated_at: string;
  success: boolean;
  integrity_passed: boolean;
  observed_model: string | null;
  tool_calls: number;
  tool_failures: number;
  duration_ms: number;
  failure_kind: FailureKind | null;
  failure_reason: string | null;
}
export interface Benchmark {
  name: string;
  version: string;
  conditions: string;
  source_url: string;
  updated_at: string;
  metric: string;
  value: number;
}
export interface Evaluation {
  model_id: string;
  provider: "openrouter";
  harness: string;
  harness_version: string;
  evaluated_at: string;
  evaluation_version: string;
  fixture_digest: string;
  conditions: EvaluationConditions;
  benchmarks: Benchmark[];
  trials: Trial[];
}
export interface EvaluationConditions {
  max_requests_per_trial: number;
  timeout_seconds: number;
  generation_profile: string;
}
export interface BaselineReference {
  model_id: string;
  harness: string;
  evaluated_at: string;
}
export interface Calibration {
  calibrated_at: string;
  rationale: string;
  baselines: BaselineReference[];
}
export interface EvidenceStore {
  schema_version: 1;
  evaluation_version: string;
  fixture_digest: string;
  calibration: Calibration | null;
  evaluations: Evaluation[];
}
export interface QualityPolicy {
  evaluationVersion?: string;
  fixtureDigest?: string;
  harnessVersion?: string;
  maxAgeDays?: number;
  minCapabilityTrials?: number;
}
export interface QualityMetrics {
  capability_trials: number;
  successes: number;
  completion_rate: number;
  completion_lower_bound: number;
  tool_calls: number;
  tool_failures: number;
  tool_reliability: number;
  /** Mean duration of all capability trials, including unsuccessful attempts. */
  duration_ms: number;
  infrastructure_failures: number;
}
export interface QualityAssessment {
  model_id: string;
  harness: string;
  status: "qualified" | "unverified" | "rejected";
  reasons: string[];
  metrics: QualityMetrics | null;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function nonempty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
function timestamp(value: unknown): value is string {
  return (
    nonempty(value) &&
    /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(value) &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString().slice(0, 19) === value.slice(0, 19)
  );
}
function natural(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function validTrial(value: unknown): value is Trial {
  if (
    !record(value) ||
    !nonempty(value.id) ||
    !timestamp(value.evaluated_at) ||
    typeof value.success !== "boolean" ||
    typeof value.integrity_passed !== "boolean" ||
    !(value.observed_model === null || nonempty(value.observed_model)) ||
    !natural(value.tool_calls) ||
    !natural(value.tool_failures) ||
    value.tool_failures > value.tool_calls ||
    typeof value.duration_ms !== "number" ||
    !Number.isFinite(value.duration_ms) ||
    value.duration_ms < 0
  )
    return false;
  if (value.success)
    return value.failure_kind === null && value.failure_reason === null;
  return (
    ["capability", "api", "quota", "auth", "launcher"].includes(
      value.failure_kind as string,
    ) && nonempty(value.failure_reason)
  );
}
function validBenchmark(value: unknown): value is Benchmark {
  if (
    !record(value) ||
    !["name", "version", "conditions", "metric"].every((k) =>
      nonempty(value[k]),
    ) ||
    !timestamp(value.updated_at) ||
    typeof value.value !== "number" ||
    !Number.isFinite(value.value) ||
    !nonempty(value.source_url)
  )
    return false;
  try {
    return new URL(value.source_url).protocol === "https:";
  } catch {
    return false;
  }
}
function validEvaluation(value: unknown): value is Evaluation {
  return (
    record(value) &&
    value.provider === "openrouter" &&
    [
      "model_id",
      "harness",
      "harness_version",
      "evaluation_version",
      "fixture_digest",
    ].every((k) => nonempty(value[k])) &&
    timestamp(value.evaluated_at) &&
    record(value.conditions) &&
    natural(value.conditions.max_requests_per_trial) &&
    value.conditions.max_requests_per_trial > 0 &&
    natural(value.conditions.timeout_seconds) &&
    value.conditions.timeout_seconds > 0 &&
    nonempty(value.conditions.generation_profile) &&
    Array.isArray(value.benchmarks) &&
    value.benchmarks.every(validBenchmark) &&
    Array.isArray(value.trials) &&
    value.trials.every(validTrial) &&
    new Set(value.trials.map((t) => t.id)).size === value.trials.length
  );
}
function validStore(value: unknown): value is EvidenceStore {
  if (
    !record(value) ||
    value.schema_version !== 1 ||
    !nonempty(value.evaluation_version) ||
    !nonempty(value.fixture_digest) ||
    !Array.isArray(value.evaluations) ||
    !value.evaluations.every(validEvaluation)
  )
    return false;
  if (value.calibration === null) return true;
  const calibration = value.calibration;
  return (
    record(calibration) &&
    timestamp(calibration.calibrated_at) &&
    nonempty(calibration.rationale) &&
    Array.isArray(calibration.baselines) &&
    calibration.baselines.length > 0 &&
    calibration.baselines.every(
      (ref) =>
        record(ref) &&
        nonempty(ref.model_id) &&
        nonempty(ref.harness) &&
        timestamp(ref.evaluated_at),
    ) &&
    new Set(calibration.baselines.map((ref) => ref.harness)).size ===
      calibration.baselines.length
  );
}

/** Invalid/missing files are errors: callers must show the error, never bypass admission. */
export async function loadQualityStore(path: string): Promise<EvidenceStore> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw new Error(`Quality evidence is missing or unreadable: ${path}`);
  }
  if (!validStore(value))
    throw new Error(`Quality evidence has an invalid schema: ${path}`);
  return value;
}

// Wilson 95% lower bound penalizes small samples; three repeats are a policy floor,
// not a claim of statistical confidence that an agent is generally reliable.
function completionLowerBound(successes: number, total: number): number {
  if (!total) return 0;
  const z = 1.96,
    p = successes / total,
    z2 = z * z;
  return (
    (p +
      z2 / (2 * total) -
      z * Math.sqrt((p * (1 - p) + z2 / (4 * total)) / total)) /
    (1 + z2 / total)
  );
}
function metricsFor(trials: Trial[]): QualityMetrics {
  const capability = trials.filter(
    (t) => t.failure_kind === null || t.failure_kind === "capability",
  );
  const successes = capability.filter((t) => t.success).length;
  const tools = capability.reduce((sum, t) => sum + t.tool_calls, 0);
  const failures = capability.reduce((sum, t) => sum + t.tool_failures, 0);
  return {
    capability_trials: capability.length,
    successes,
    completion_rate: capability.length ? successes / capability.length : 0,
    completion_lower_bound: completionLowerBound(successes, capability.length),
    tool_calls: tools,
    tool_failures: failures,
    tool_reliability: tools ? (tools - failures) / tools : 0,
    duration_ms: capability.length
      ? capability.reduce((sum, t) => sum + t.duration_ms, 0) /
        capability.length
      : 0,
    infrastructure_failures: trials.length - capability.length,
  };
}

/** Benchmarks are attributed context only; unlike metrics are never added to task scores. */
export function assessQuality(
  store: EvidenceStore,
  modelId: string,
  harness: string,
  now: Date,
  policy: QualityPolicy = {},
): QualityAssessment {
  const result: QualityAssessment = {
    model_id: modelId,
    harness,
    status: "unverified",
    reasons: [],
    metrics: null,
  };
  const stop = (
    reason: string,
    status: QualityAssessment["status"] = "unverified",
  ) => {
    result.status = status;
    result.reasons.push(reason);
    return result;
  };
  if (!validStore(store)) return stop("Invalid quality evidence schema");
  if (!Number.isFinite(now.getTime())) return stop("Invalid current time");
  if (
    (policy.maxAgeDays !== undefined &&
      (!Number.isFinite(policy.maxAgeDays) || policy.maxAgeDays <= 0)) ||
    (policy.minCapabilityTrials !== undefined &&
      (!Number.isSafeInteger(policy.minCapabilityTrials) ||
        policy.minCapabilityTrials < 1))
  )
    return stop("Invalid quality policy");
  const maxAge = Math.min(policy.maxAgeDays ?? 14, 14) * 86400000;
  const minimum = Math.max(policy.minCapabilityTrials ?? 3, 3);
  const version = policy.evaluationVersion ?? QUALITY_EVALUATION_VERSION;
  const current = (at: string) =>
    Date.parse(at) <= now.getTime() && now.getTime() - Date.parse(at) <= maxAge;
  if (store.evaluation_version !== version)
    return stop("Evaluation version is incompatible");
  if (policy.fixtureDigest && store.fixture_digest !== policy.fixtureDigest)
    return stop("Fixture digest is incompatible");
  const matching = store.evaluations.filter(
    (e) => e.model_id === modelId && e.harness === harness,
  );
  if (!matching.length) return stop("No evaluation for this model and harness");
  const compatible = (e: Evaluation) =>
    e.evaluation_version === version &&
    e.fixture_digest === store.fixture_digest &&
    (!policy.harnessVersion || e.harness_version === policy.harnessVersion);
  // Prior artifacts remain audit history, not evidence about the current suite or
  // harness. Keep every compatible batch so current failures cannot be omitted.
  const currentArtifact = matching.filter(compatible);
  if (!currentArtifact.length)
    return stop(
      "Model evaluation version, fixture, or harness version is incompatible",
    );
  if (currentArtifact.some((e) => Date.parse(e.evaluated_at) > now.getTime()))
    return stop("Model evaluation is future-dated");
  const fresh = currentArtifact.filter((e) => current(e.evaluated_at));
  if (!fresh.length) return stop("Model evaluation is stale");
  if (new Set(fresh.map((e) => e.harness_version)).size !== 1)
    return stop("Evidence mixes harness versions");
  const validateTrials = (evaluations: Evaluation[]) =>
    evaluations.every((e) =>
      e.trials.every(
        (t) =>
          current(t.evaluated_at) &&
          Date.parse(t.evaluated_at) <= Date.parse(e.evaluated_at) &&
          ((t.failure_kind !== null && t.failure_kind !== "capability") ||
            t.observed_model === e.model_id) &&
          (!t.success || (t.integrity_passed && t.tool_calls > 0)),
      ),
    );
  if (!validateTrials(fresh))
    return stop(
      "Trial timestamp, observed model, integrity, or tool trace is unverified",
    );
  const trials = fresh.flatMap((e) => e.trials);
  if (new Set(trials.map((t) => t.id)).size !== trials.length)
    return stop("Duplicate trial identities across evaluations");
  result.metrics = metricsFor(trials);
  if (result.metrics.capability_trials < minimum)
    return stop(
      `Insufficient capability trials (${result.metrics.capability_trials}/${minimum}); infrastructure failures=${result.metrics.infrastructure_failures}`,
    );
  if (!store.calibration || !current(store.calibration.calibrated_at))
    return stop("Missing, stale, or future-dated calibration");
  const reference = store.calibration.baselines.find(
    (ref) => ref.harness === harness,
  );
  if (!reference) return stop("No measured baseline for this harness");
  const baselines = store.evaluations.filter(
    (e) =>
      e.model_id === reference.model_id &&
      e.harness === harness &&
      e.evaluated_at === reference.evaluated_at &&
      compatible(e) &&
      e.harness_version === fresh[0].harness_version,
  );
  if (baselines.length !== 1)
    return stop("Baseline reference does not identify one actual evaluation");
  const baseline = baselines[0];
  if (
    !compatible(baseline) ||
    baseline.harness_version !== fresh[0].harness_version ||
    !current(baseline.evaluated_at) ||
    !validateTrials([baseline])
  )
    return stop("Baseline evidence is stale or incompatible");
  const sameConditions = (evaluation: Evaluation) =>
    evaluation.conditions.max_requests_per_trial ===
      baseline.conditions.max_requests_per_trial &&
    evaluation.conditions.timeout_seconds ===
      baseline.conditions.timeout_seconds &&
    evaluation.conditions.generation_profile ===
      baseline.conditions.generation_profile;
  if (fresh.some((e) => !sameConditions(e)))
    return stop(
      "Candidate evaluation conditions differ from the measured baseline conditions",
    );
  // A selected clean batch must not hide other recent failures of the baseline.
  const baselineHistory = store.evaluations.filter(
    (e) =>
      e.model_id === reference.model_id &&
      e.harness === harness &&
      compatible(e),
  );
  if (baselineHistory.some((e) => Date.parse(e.evaluated_at) > now.getTime()))
    return stop("Baseline evidence is future-dated");
  const freshBaselines = baselineHistory.filter((e) => current(e.evaluated_at));
  if (freshBaselines.some((e) => !sameConditions(e)))
    return stop(
      "Fresh baseline evaluation conditions conflict with the referenced baseline conditions",
    );
  if (
    freshBaselines.some(
      (e) => !compatible(e) || e.harness_version !== baseline.harness_version,
    ) ||
    !validateTrials(freshBaselines)
  )
    return stop("Baseline trial evidence is incompatible or unverified");
  const baselineTrials = freshBaselines.flatMap((e) => e.trials);
  if (new Set(baselineTrials.map((t) => t.id)).size !== baselineTrials.length)
    return stop("Duplicate baseline trial identities");
  const baselineMetrics = metricsFor(baselineTrials);
  // Every capability attempt must pass grading. Tool reliability is measured
  // and compared with the candidate; require at least one successful call so
  // a baseline made entirely of tool failures cannot set a zero floor.
  if (
    baselineMetrics.capability_trials < minimum ||
    baselineMetrics.successes !== baselineMetrics.capability_trials ||
    !baselineMetrics.tool_calls ||
    baselineMetrics.tool_reliability <= 0
  )
    return stop(
      "Baseline must repeatedly pass every development acceptance check with reliable tools",
    );
  const thresholds = `baseline ${reference.model_id} (${harness}): completion>=${baselineMetrics.completion_rate.toFixed(3)}, Wilson>=${baselineMetrics.completion_lower_bound.toFixed(3)}, tool reliability>=${baselineMetrics.tool_reliability.toFixed(3)}`;
  const actual = result.metrics;
  if (
    actual.completion_rate < baselineMetrics.completion_rate ||
    actual.completion_lower_bound + Number.EPSILON <
      baselineMetrics.completion_lower_bound ||
    actual.tool_reliability < baselineMetrics.tool_reliability
  )
    return stop(`Below measured ${thresholds}`, "rejected");
  return stop(
    `Meets measured ${thresholds}; ${store.calibration.rationale}`,
    "qualified",
  );
}

/** Rank completion, tools, then elapsed time; speed never compensates for capability. */
export function rankQualified(
  assessments: QualityAssessment[],
): QualityAssessment[] {
  return assessments
    .filter((a) => a.status === "qualified" && a.metrics !== null)
    .sort((a, b) => {
      const left = a.metrics!,
        right = b.metrics!;
      return (
        right.completion_lower_bound - left.completion_lower_bound ||
        right.tool_reliability - left.tool_reliability ||
        left.duration_ms - right.duration_ms ||
        a.model_id.localeCompare(b.model_id)
      );
    });
}
