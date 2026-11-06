/**
 * SHA-pinned quality gate for agent workers (Epic #86, T016 / issue #102).
 *
 * Pure functions only: every input is injected, nothing here launches a
 * process, touches the network, or reads the filesystem. Durable attempt
 * state stays in `attempts.ts`; this module only DECIDES.
 *
 * Design rule (same as `preflight.ts`): the ENTIRE input — current SHA,
 * required gates, validation records, local environment — is validated with
 * a strict schema FIRST. Any malformed field throws `ContractError` and
 * never produces a decision. A decision that is produced fails closed:
 *
 *   - a validation record is bound to the exact SHA it validated and is
 *     never reused for another SHA (old-SHA green is not current-SHA green);
 *   - `skipped` / `neutral` / missing / stale evidence never counts as pass;
 *   - a Worker self-report or a Herdr `done` marker is never validation
 *     success (the record source enum has no such value and never will);
 *   - a WSL/Linux host can never satisfy a native-OS gate, and a record
 *     that contradicts itself (WSL + windows) or the attested local
 *     environment is rejected, not reinterpreted;
 *   - only gates REQUIRED for the change surface and task class are
 *     demanded — low-risk mechanical work is never over-verified.
 */

import {
  ContractError,
  DEFAULT_MAX_EVIDENCE_AGE_MS,
  isPlainObject,
  isStale,
  looksLikeSecretValue,
  optionalStr,
  parseEnvelope,
  requireBool,
} from "./contract.ts";
import {
  requireEpochMs,
  requireImmutableRef,
  requireIsoTime,
} from "./attempts.ts";
import type { TaskClass } from "./preflight.ts";
import { OS_VALUES, type MachineOS } from "./machines.ts";

// ---------------------------------------------------------------------------
// Gate catalog
// ---------------------------------------------------------------------------

/** Kind of quality gate, mirroring the project-init quality profile matrix. */
export type GateKind = "unit" | "smoke" | "integration" | "e2e" | "platform" | "native";

const GATE_KINDS: readonly GateKind[] = [
  "unit",
  "smoke",
  "integration",
  "e2e",
  "platform",
  "native",
];

/**
 * One rule of the project-specific gate matrix. `triggers` are repo-relative
 * path prefixes; a gate is required for a change surface when any changed
 * path starts with one of them. `triggers: null` means always required.
 * `native: true` means only a bare-metal (non-WSL) host of `os` satisfies
 * the gate — a WSL result can never stand in for a native one.
 */
export interface GateRule {
  kind: GateKind;
  /** Stable gate name; the join key between rules and validation records. */
  name: string;
  /** OS the check must run on; null = OS-agnostic. */
  os: MachineOS | null;
  native: boolean;
  triggers: readonly string[] | null;
}

/** A resolved requirement: which named gate must be green for which host. */
export interface RequiredGate {
  kind: GateKind;
  name: string;
  os: MachineOS | null;
  native: boolean;
}

const GATE_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

function parseGateName(value: unknown, where: string): string {
  if (typeof value !== "string" || !GATE_NAME_RE.test(value) || looksLikeSecretValue(value)) {
    throw new ContractError("schema", `${where}: must be a non-secret slug gate name`);
  }
  return value;
}

/** Path-prefix triggers are repo-relative and can never escape the repo. */
function parseTrigger(value: unknown, where: string): string {
  if (
    typeof value !== "string" ||
    value.trim() === "" ||
    value.startsWith("/") ||
    value.includes("..") ||
    value.includes("\\")
  ) {
    throw new ContractError("schema", `${where}: must be a repo-relative path prefix`);
  }
  return value;
}

/** Validate one gate rule from untrusted data (catalog file, caller). */
export function parseGateRule(raw: unknown, where: string): GateRule {
  if (!isPlainObject(raw)) {
    throw new ContractError("schema", `${where}: object expected`);
  }
  const kind = raw["kind"];
  if (!GATE_KINDS.includes(kind as GateKind)) {
    throw new ContractError("schema", `${where}: unknown gate kind '${kind}'`);
  }
  const name = parseGateName(raw["name"], `${where}.name`);
  const os = raw["os"];
  if (os !== null && !OS_VALUES.includes(os as MachineOS)) {
    throw new ContractError("schema", `${where}.os: must be null or a MachineOS value`);
  }
  const native = requireBool(raw, "native", where);
  const triggers = raw["triggers"];
  if (triggers !== null) {
    if (!Array.isArray(triggers)) {
      throw new ContractError("schema", `${where}.triggers: must be null or an array`);
    }
    for (const trigger of triggers) parseTrigger(trigger, `${where}.triggers`);
  }
  return {
    kind: kind as GateKind,
    name,
    os: (os as MachineOS | null) ?? null,
    native,
    triggers: (triggers as string[] | null) ?? null,
  };
}

/**
 * Task classes that never demand more than unit-level proof. Localized work
 * additionally gets smoke coverage; only cross-boundary / judgement-heavy
 * work justifies the full triggered matrix.
 */
const LOW_RISK_KINDS: Record<TaskClass, readonly GateKind[]> = {
  mechanical: ["unit"],
  localized: ["unit", "smoke"],
  "cross-boundary": GATE_KINDS,
  "judgment-heavy": GATE_KINDS,
};

const TASK_CLASSES: readonly TaskClass[] = [
  "mechanical",
  "localized",
  "cross-boundary",
  "judgment-heavy",
];

/**
 * Resolve the required gate matrix from the candidate SHA's change surface.
 * Throws on malformed rules, malformed paths, an unknown task class, or two
 * rules sharing a name (ambiguous join key). Only REQUIRED gates are
 * returned: a low-risk task class is never over-verified, and untriggered
 * optional gates are dropped.
 */
export function resolveRequiredGates(
  rules: readonly unknown[],
  paths: readonly string[],
  taskClass: TaskClass,
): RequiredGate[] {
  if (!TASK_CLASSES.includes(taskClass)) {
    throw new ContractError("schema", `resolveRequiredGates: unknown taskClass '${taskClass}'`);
  }
  if (!Array.isArray(rules)) {
    throw new ContractError("schema", "resolveRequiredGates: rules must be an array");
  }
  if (!Array.isArray(paths) || paths.length === 0) {
    throw new ContractError(
      "schema",
      "resolveRequiredGates: paths must be a non-empty array (an unknown change surface fails closed)",
    );
  }
  for (const path of paths) parseTrigger(path, "resolveRequiredGates.paths");

  const allowedKinds = LOW_RISK_KINDS[taskClass];
  const required = new Map<string, RequiredGate>();
  for (const raw of rules) {
    const rule = parseGateRule(raw, "resolveRequiredGates.rules[]");
    if (required.has(rule.name)) {
      throw new ContractError(
        "identity",
        `resolveRequiredGates: duplicate gate name '${rule.name}'`,
      );
    }
    if (!allowedKinds.includes(rule.kind)) continue; // not needed for this task class
    if (rule.triggers !== null && !rule.triggers.some((t) => paths.some((p) => p.startsWith(t)))) {
      continue; // change surface does not touch this gate
    }
    required.set(rule.name, { kind: rule.kind, name: rule.name, os: rule.os, native: rule.native });
  }
  return [...required.values()];
}

// ---------------------------------------------------------------------------
// Validation records
// ---------------------------------------------------------------------------

/**
 * Where a validation run happened. `wsl` is part of the identity: WSL is
 * linux and never windows, so `{ os: "windows", wsl: true }` is a
 * contradiction rejected at parse time — a WSL result can never be
 * misreported as a windows-native one.
 */
export interface ExecutionEnvironment {
  os: MachineOS;
  wsl: boolean;
}

export const VALIDATION_RECORD_FIELDS = [
  "name",
  "sha",
  "status",
  "source",
  "environment",
  "at",
  "note",
] as const;

/**
 * Outcome of one gate run. There is deliberately no "success"-shaped alias:
 * `skipped` and `neutral` are recorded as what they are and never roll up
 * into a pass.
 */
export type ValidationStatus = "pass" | "fail" | "skipped" | "neutral";

const VALIDATION_STATUSES: readonly ValidationStatus[] = ["pass", "fail", "skipped", "neutral"];

/**
 * Who produced the record. ONLY a real gate execution qualifies: a CI run or
 * an observed local run. A Worker self-report, a Herdr `done` marker, or any
 * other claim is not validation and has no value here — unknown sources fail
 * closed at parse time.
 */
export type ValidationSource = "ci" | "local-run";

const VALIDATION_SOURCES: readonly ValidationSource[] = ["ci", "local-run"];

export interface ValidationRecord {
  name: string;
  /** Immutable SHA the gate ran against; records are never reused across SHAs. */
  sha: string;
  status: ValidationStatus;
  source: ValidationSource;
  environment: ExecutionEnvironment;
  /** ISO 8601 UTC timestamp of the run. */
  at: string;
  note: string | null;
}

/** Parse the environment block of a validation record. */
export function parseEnvironment(raw: unknown, where: string): ExecutionEnvironment {
  if (!isPlainObject(raw)) {
    throw new ContractError("schema", `${where}: object expected`);
  }
  const keys = Object.keys(raw);
  if (keys.length !== 2 || !("os" in raw) || !("wsl" in raw)) {
    throw new ContractError("schema", `${where}: must have exactly 'os' and 'wsl'`);
  }
  const os = raw["os"];
  if (!OS_VALUES.includes(os as MachineOS)) {
    throw new ContractError("schema", `${where}.os: must be a MachineOS value`);
  }
  const wsl = requireBool(raw, "wsl", where);
  if (wsl && os !== "linux") {
    throw new ContractError(
      "schema",
      `${where}: WSL is linux; os='${os}' with wsl=true is a hostile misreport`,
    );
  }
  return { os: os as MachineOS, wsl };
}

/** Parse a validation record from untrusted data. Unknown/missing fields throw. */
export function parseValidationRecord(raw: unknown, where: string): ValidationRecord {
  const { payload } = parseEnvelope(raw, VALIDATION_RECORD_FIELDS, where);
  for (const field of VALIDATION_RECORD_FIELDS) {
    if (!(field in payload)) {
      throw new ContractError("schema", `${where}: missing field '${field}'`);
    }
  }
  const name = parseGateName(payload["name"], `${where}.name`);
  const sha = requireImmutableRef(payload["sha"], `${where}.sha`);
  const status = payload["status"];
  if (!VALIDATION_STATUSES.includes(status as ValidationStatus)) {
    throw new ContractError(
      "schema",
      `${where}.status: unknown status '${status}' (skipped/neutral never pass)`,
    );
  }
  const source = payload["source"];
  if (!VALIDATION_SOURCES.includes(source as ValidationSource)) {
    throw new ContractError(
      "schema",
      `${where}.source: '${source}' is not a validation source (self-reports and herdr markers are never validation)`,
    );
  }
  const environment = parseEnvironment(payload["environment"], `${where}.environment`);
  const at = requireIsoTime(payload["at"], `${where}.at`);
  const note = optionalStr(payload, "note", where);
  if (note !== null && looksLikeSecretValue(note)) {
    throw new ContractError("schema", `${where}.note: secret-shaped values are refused`);
  }
  return {
    name,
    sha,
    status: status as ValidationStatus,
    source: source as ValidationSource,
    environment,
    at,
    note,
  };
}

// ---------------------------------------------------------------------------
// Gate evaluation
// ---------------------------------------------------------------------------

export interface QualityGateInput {
  /** The candidate SHA every record must be pinned to. */
  currentSha: string;
  /** Reference time (ms epoch) for staleness checks. */
  now: number;
  /** Maximum evidence age; defaults to the contract default (7 days). */
  maxEvidenceAgeMs?: number;
  /** Attested environment of the host evaluating the gate. */
  localEnvironment: ExecutionEnvironment;
  /** True when the working tree changed after the candidate SHA was recorded. */
  sourceMutated: boolean;
  required: readonly RequiredGate[];
  /** Untrusted validation records (parsed strictly before any decision). */
  records: readonly unknown[];
}

export interface GateFailure {
  name: string;
  reason: string;
}

export interface QualityDecision {
  passed: boolean;
  sha: string;
  /** Names of required gates satisfied for the current SHA. */
  satisfied: string[];
  failures: GateFailure[];
}

/**
 * Staleness for a bare ISO timestamp (shared with `review.ts`): delegates to
 * `contract.isStale` — future-dated evidence is invalid, never fresh — by
 * wrapping the timestamp in an `Evidence` whose `source: "config"` marks it
 * as record metadata, not a measurement claim.
 */
export function isRecordStale(at: string, now: number, maxAgeMs: number): boolean {
  return isStale({ at, source: "config" }, now, maxAgeMs);
}

/** True when the record's environment genuinely satisfies the gate's host requirement. */
function satisfiesHost(gate: RequiredGate, env: ExecutionEnvironment): boolean {
  if (gate.os !== null && env.os !== gate.os) return false;
  if (gate.native && env.wsl) return false; // WSL never satisfies a native gate
  return true;
}

/**
 * Evaluate the required gates for the current candidate SHA. Throws
 * `ContractError` on malformed input (including any malformed record —
 * hostile evidence never produces a decision). The returned decision fails
 * closed: every required gate needs a fresh, passing, correctly-sourced
 * record pinned to EXACTLY `currentSha` on a host that genuinely satisfies
 * the gate's OS requirement. Records for other SHAs are never reused;
 * records for non-required gates are ignored (no over-verification).
 */
export function evaluateQualityGate(input: unknown): QualityDecision {
  if (!isPlainObject(input)) {
    throw new ContractError("schema", "evaluateQualityGate: input must be an object");
  }
  const currentSha = requireImmutableRef(input["currentSha"], "evaluateQualityGate.currentSha");
  const now = requireEpochMs(input["now"], "evaluateQualityGate.now");
  const maxAgeMs =
    input["maxEvidenceAgeMs"] === undefined
      ? DEFAULT_MAX_EVIDENCE_AGE_MS
      : requireEpochMs(input["maxEvidenceAgeMs"], "evaluateQualityGate.maxEvidenceAgeMs");
  if (maxAgeMs <= 0) {
    throw new ContractError("schema", "evaluateQualityGate.maxEvidenceAgeMs must be positive");
  }
  const localEnvironment = parseEnvironment(
    input["localEnvironment"],
    "evaluateQualityGate.localEnvironment",
  );
  const sourceMutated = requireBool(input, "sourceMutated", "evaluateQualityGate");
  if (!Array.isArray(input["required"])) {
    throw new ContractError("schema", "evaluateQualityGate.required must be an array");
  }
  if (!Array.isArray(input["records"])) {
    throw new ContractError("schema", "evaluateQualityGate.records must be an array");
  }
  const required: RequiredGate[] = input["required"] as RequiredGate[];
  const seen = new Set<string>();
  for (const gate of required) {
    if (
      !isPlainObject(gate) ||
      !GATE_KINDS.includes(gate["kind"] as GateKind) ||
      typeof gate["name"] !== "string" ||
      typeof gate["native"] !== "boolean" ||
      (gate["os"] !== null && !OS_VALUES.includes(gate["os"] as MachineOS))
    ) {
      throw new ContractError("schema", "evaluateQualityGate.required[]: malformed gate");
    }
    parseGateName(gate["name"], "evaluateQualityGate.required[].name");
    if (seen.has(gate["name"])) {
      throw new ContractError(
        "identity",
        `evaluateQualityGate: duplicate required gate '${gate["name"]}'`,
      );
    }
    seen.add(gate["name"]);
  }
  const records = (input["records"] as unknown[]).map((raw, i) =>
    parseValidationRecord(raw, `evaluateQualityGate.records[${i}]`),
  );

  const satisfied: string[] = [];
  const failures: GateFailure[] = [];

  if (sourceMutated) {
    // The candidate is no longer the state any record was produced against:
    // nothing can be green, no matter what the records say.
    for (const gate of required) {
      failures.push({
        name: gate.name,
        reason: "source mutated after the candidate SHA; all validation is void",
      });
    }
    return { passed: false, sha: currentSha, satisfied, failures };
  }

  for (const gate of required) {
    const named = records.filter((r) => r.name === gate.name);
    if (named.length === 0) {
      failures.push({ name: gate.name, reason: "missing: no validation record for this gate" });
      continue;
    }
    // SHA pinning: a record for another SHA is evidence about another
    // candidate and is never reused here.
    const current = named.filter((r) => r.sha === currentSha);
    if (current.length === 0) {
      failures.push({
        name: gate.name,
        reason: "stale: no validation record pinned to the current SHA",
      });
      continue;
    }
    // A failing eligible run is a real failure; a pass can never be
    // cherry-picked around it.
    const eligible = current.filter((r) => satisfiesHost(gate, r.environment));
    if (eligible.some((r) => r.status === "fail")) {
      failures.push({ name: gate.name, reason: "gate failed on the current SHA" });
      continue;
    }
    const passing = eligible.find(
      (r) =>
        r.status === "pass" &&
        !isRecordStale(r.at, now, maxAgeMs) &&
        // A claimed local run must actually have run on THIS host (same OS
        // and same WSL-ness); anything else is a misreported environment
        // (e.g. a WSL run labelled as windows native).
        (r.source === "ci" ||
          (r.environment.os === localEnvironment.os && r.environment.wsl === localEnvironment.wsl)),
    );
    if (passing) {
      satisfied.push(gate.name);
    } else {
      const skipped = eligible.find((r) => r.status !== "pass");
      failures.push({
        name: gate.name,
        reason: skipped
          ? `not passed: record status is '${skipped.status}'`
          : "no passing record for the current SHA on a verified environment",
      });
    }
  }

  return {
    passed: failures.length === 0,
    sha: currentSha,
    satisfied,
    failures,
  };
}
