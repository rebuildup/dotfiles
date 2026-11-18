#!/usr/bin/env bun
/**
 * Herdr dispatch / observe / collect for agent tasks (dotfiles#100, Epic #86 T014).
 *
 * Uses Herdr agent start with model flags for model selection,
 * Herdr agent prompt for execution. Task state persisted to
 * ~/.local/share/agent/tasks/<taskId>.json.
 *
 * A Herdr worker is started by the Herdr server and inherits ITS
 * environment, so the route's credential is passed explicitly (see
 * routeWorkerEnv). The dispatcher therefore runs under script/with-secrets so
 * the credential is present in its own environment.
 *
 * Execution contract: [ADR-0019](../../docs/adr/ADR-0019.md).
 */

import { ContractError, isOneOf, isPlainObject, parseRouteId, formatRouteId, formatAttemptKey, parseTomlTable, requireStr, stringList, type RouteRef } from "./contract.ts";
import { type FallbackCandidate, parseFallbackProfile, validateBilling, validateCredential, validateScope } from "./fallback.ts";
import {
  executeWithFallback,
  FallbackExhaustedError,
  type ClassifiedError,
  type FailureSignal,
  classifyFailure,
  LIMIT_CATEGORIES,
} from "./fallback-exec.ts";
import {
  ompNeedsManagedProfile,
  ompWorkerArgs,
  prepareOmpWorker,
  type OmpWorkerPreparation,
} from "./omp.ts";
import { type Config, type Provider } from "./config.ts";
import { agentStateDir } from "./contract.ts";
import {
  createWorkspace,
  createPane,
  startAgent,
  promptAgent,
  readAgent,
  waitAgent,
  getAgent,
  closePane,
  saveHerdrTaskMapping,
  type HerdrTaskMapping,
} from "./herdr.ts";
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import {
  withFileLock,
  FsAttemptStore,
  initAttempt,
  acquireLease,
  releaseLease,
  type Lease,
} from "./attempts.ts";
import {
  FsJournalStore,
  journalPreEffect,
  journalPostEffect,
  pendingSideEffects,
} from "./checkpoint.ts";
import { extractProviderFailureEvidence, providerTurnObserved } from "./evidence.ts";
import { randomUUID } from "node:crypto";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TaskClass = "simple" | "cross-boundary" | "capacity-constrained";

export interface TaskDescriptor {
  id: string;
  route: string; // "harness.provider"
  model: string;
  prompt: string;
  profileId?: string; // fallback profile ID
  class?: TaskClass;
  maxAttempts?: number;
  acceptanceCriteria?: string[];
  timeoutMs?: number;
  /** Explicit operator acknowledgement that fallback may run with side
   *  effects outside observable scope (no --accept, non-git cwd). */
  allowUnobservedEffects?: boolean;
}

export interface TaskAttempt {
  id: string;
  taskId: string;
  route: RouteRef;
  model: string;
  profileId?: string;
  attemptNumber: number;
  startedAt: string;
  status: "running" | "completed" | "failed" | "blocked" | "fallback";
  herdrPaneId?: string;
  herdrWorkspaceId?: string;
  herdrWorkerName?: string;
  generation: number;
  fallbackCandidate?: FallbackCandidate;
  /** Credential scope used (env name or infisical:<secret>), never a value. */
  credentialScope?: string;
  error?: ClassifiedError;
  result?: unknown;
}

export interface TaskDispatchResult {
  taskId: string;
  attempt: TaskAttempt;
}

export interface TaskStatus {
  taskId: string;
  currentAttempt: TaskAttempt | null;
  history: TaskAttempt[];
  overallStatus: "pending" | "running" | "completed" | "failed" | "blocked" | "awaiting-fallback";
}

export interface AcceptanceCheck {
  command: string;
  exitCode: number | null;
  timedOut: boolean;
}

export interface AcceptanceReport {
  /** true only when EVERY declared criterion exited 0. */
  verified: boolean;
  checks: AcceptanceCheck[];
}

export interface CollectResult {
  taskId: string;
  attempt: TaskAttempt;
  success: boolean;
  result?: unknown;
  error?: ClassifiedError;
  /**
   * Acceptance-criteria verification, kept DISTINCT from worker success
   * (ADR-0017 §5: agent output is not proof of task completion). Present
   * only when the descriptor declared `acceptanceCriteria`.
   */
  acceptance?: AcceptanceReport;
}

// ---------------------------------------------------------------------------
// State persistence
// ---------------------------------------------------------------------------

const TASK_STATE_DIR = join(agentStateDir(), "tasks");

function ensureTaskStateDir(): void {
  if (!existsSync(TASK_STATE_DIR)) {
    mkdirSync(TASK_STATE_DIR, { recursive: true });
  }
}

const TASK_ID_SAFE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

// ---------------------------------------------------------------------------
// Fencing + side-effect journal (issues #99/#173)
// ---------------------------------------------------------------------------
//
// Every task maps to ONE attempts.ts attemptKey (route#model#machine#taskId)
// and ONE checkpoint.ts journal. Dispatch initializes the record; execution
// and resume hold an exclusive generation lease across the whole run, and
// every externally-visible operation (worker prompt, candidate dispatch) is
// journaled pre/post. A `pre` without `post` is UNKNOWN: resume refuses to
// replay until it is reconciled — never assumed "did not happen".

const taskAttemptStore = new FsAttemptStore();
const taskJournalStore = new FsJournalStore();

/**
 * The fencing/journal identity of a task is its DISPATCH identity
 * (descriptor route+model+taskId) — never the serving attempt's route,
 * which changes when a fallback candidate serves. Deriving the key from
 * the recorded attempt would orphan the lease and journal history after
 * every successful fallback.
 */
function taskAttemptKey(descriptor: { route: string; model: string; id: string }): string {
  return formatAttemptKey({
    route: descriptor.route,
    model: descriptor.model,
    machine: "",
    attempt: descriptor.id,
  });
}

function assertNoPendingEffects(attemptKey: string, taskId: string): void {
  const pending = pendingSideEffects(taskJournalStore, attemptKey);
  if (pending.length > 0) {
    throw new ContractError(
      "state",
      `task '${taskId}' has ${pending.length} unreconciled side effect(s) ` +
        `(${pending.map((e) => `${e.effectId}:${e.kind}`).join(", ")}); ` +
        "a pre-without-post effect is UNKNOWN — reconcile externally before replay",
    );
  }
}

let effectSeq = 0;
/** Unique, journal-parseable effect id: repeated prompts on one worker
 *  are distinct effects; a crash between pre and post still blocks replay. */
function uniqueEffectId(kind: string, target: string): string {
  const id = `${kind}-${target}-${(effectSeq++).toString(36)}-${Date.now().toString(36)}`;
  return id.slice(0, 64).replace(/[^A-Za-z0-9._-]/g, "-");
}

type EffectVerdict = "succeeded" | "failed" | "unknown";

/** Run `fn` between journal pre/post entries under the caller's lease.
 *  `verdict` classifies a NORMAL return: "unknown" leaves the pre pending
 *  (Herdr returned but cannot prove the effect landed — e.g. a wait
 *  timeout), "failed" records a structured rejection. Exceptions never
 *  post: mid-flight outcome is UNKNOWN by definition. */
async function journaledEffect<T>(
  lease: Lease | undefined,
  effectId: string,
  kind: string,
  target: string,
  fn: () => Promise<T>,
  verdict?: (result: T) => EffectVerdict,
): Promise<T> {
  if (!lease) return fn();
  const now = Date.now();
  journalPreEffect(taskAttemptStore, taskJournalStore, lease, { effectId, kind, target }, now);
  try {
    const result = await fn();
    const v = verdict ? verdict(result) : "succeeded";
    if (v === "succeeded") {
      journalPostEffect(taskAttemptStore, taskJournalStore, lease, { effectId, outcome: "succeeded", ref: null }, Date.now());
    } else if (v === "failed") {
      journalPostEffect(taskAttemptStore, taskJournalStore, lease, { effectId, outcome: "failed", ref: null }, Date.now());
    }
    // "unknown": no post — the pre stays pending and blocks replay until
    // reconcileTaskEffects resolves it against observed evidence.
    return result;
  } catch (error) {
    // An exception mid-operation means the effect's outcome is UNKNOWN —
    // the worker may or may not have received/acted on it. Do NOT post:
    // the pre-without-post entry stays pending and blocks replay until
    // externally reconciled. Asserting "failed" here would launder an
    // uncertain effect into a known one.
    throw error;
  }
}

/** promptAgent's structured result decides the journal verdict for a
 *  prompt-send: a structured rejection (agent_blocked / errorCode) is a
 *  KNOWN failure; a stall or missing CLI means the prompt may or may not
 *  have landed — UNKNOWN, never recorded as sent. */
function promptSendVerdict(r: { blocked?: boolean; stalled?: boolean; errorCode?: string }): EffectVerdict {
  if (r.blocked === true || r.errorCode !== undefined) return "failed";
  if (r.stalled === true) return "unknown";
  return "succeeded";
}

/** Acquire the exclusive execution lease for a task attempt. */
function acquireTaskLease(
  descriptor: { route: string; model: string; id: string },
  owner: string,
): Lease {
  const attemptKey = taskAttemptKey(descriptor);
  return acquireLease(taskAttemptStore, attemptKey, owner, {
    now: Date.now(),
    leaseMs: 6 * 60 * 60 * 1000,
  });
}

function taskStatePath(taskId: string): string {
  if (!TASK_ID_SAFE.test(taskId)) {
    throw new ContractError("schema", `unsafe task id for state path: '${taskId}'`);
  }
  return join(TASK_STATE_DIR, `${taskId}.json`);
}

export function saveTaskState(taskId: string, state: {
  descriptor: TaskDescriptor;
  history: TaskAttempt[];
  currentAttempt: TaskAttempt | null;
}): void {
  ensureTaskStateDir();
  // Atomic publish: a crash mid-write must never leave a truncated state
  // file that loadTaskState would reject (or worse, misparses).
  const path = taskStatePath(taskId);
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, path);
}

const ATTEMPT_STATUSES: readonly TaskAttempt["status"][] = [
  "running", "completed", "failed", "blocked", "fallback",
];
const TASK_CLASSES: readonly TaskClass[] = ["simple", "cross-boundary", "capacity-constrained"];

function optStr(raw: Record<string, unknown>, key: string): string | undefined {
  const v = raw[key];
  if (v === undefined) return undefined;
  if (typeof v !== "string") throw new ContractError("schema", `task state: ${key} must be a string`);
  return v;
}

function optNum(raw: Record<string, unknown>, key: string): number | undefined {
  const v = raw[key];
  if (v === undefined) return undefined;
  if (typeof v !== "number" || !Number.isFinite(v)) {
    throw new ContractError("schema", `task state: ${key} must be a finite number`);
  }
  return v;
}

function optNullableStr(raw: Record<string, unknown>, key: string): string | null | undefined {
  const v = raw[key];
  if (v === undefined) return undefined;
  if (v !== null && typeof v !== "string") {
    throw new ContractError("schema", `task state: ${key} must be a string or null`);
  }
  return v;
}

function optNullableNum(raw: Record<string, unknown>, key: string): number | null | undefined {
  const v = raw[key];
  if (v === undefined) return undefined;
  if (v !== null && (typeof v !== "number" || !Number.isFinite(v))) {
    throw new ContractError("schema", `task state: ${key} must be a finite number or null`);
  }
  return v;
}

function reqNullableStr(raw: Record<string, unknown>, key: string, where: string): string | null {
  const v = raw[key];
  if (v !== null && typeof v !== "string") {
    throw new ContractError("schema", `${where}: ${key} must be a string or null`);
  }
  return v;
}

function reqNullableNum(raw: Record<string, unknown>, key: string, where: string): number | null {
  const v = raw[key];
  if (v !== null && (typeof v !== "number" || !Number.isFinite(v))) {
    throw new ContractError("schema", `${where}: ${key} must be a finite number or null`);
  }
  return v;
}

/** Persisted ClassifiedError: LimitClassification fields plus quotaScopeKey. */
function parseStoredError(raw: unknown, where: string): ClassifiedError {
  if (!isPlainObject(raw)) throw new ContractError("schema", `${where}: error must be an object`);
  const category = raw["category"];
  const observedAt = raw["observedAt"];
  const reason = raw["reason"];
  const exhausted = raw["exhausted"];
  if (!isOneOf(category, LIMIT_CATEGORIES) || typeof observedAt !== "string"
      || typeof reason !== "string" || typeof exhausted !== "boolean") {
    throw new ContractError("schema", `${where}: error classification fields invalid`);
  }
  const quotaScopeKey = raw["quotaScopeKey"] ?? null;
  if (typeof quotaScopeKey !== "string" && quotaScopeKey !== null) {
    throw new ContractError("schema", `${where}: quotaScopeKey must be a string or null`);
  }
  return {
    category,
    observedAt,
    resetAt: reqNullableStr(raw, "resetAt", where),
    retryAfterMs: reqNullableNum(raw, "retryAfterMs", where),
    exhausted,
    reason,
    quotaScopeKey,
  };
}

/** Persisted FallbackCandidate: enum members are re-validated at exec time. */
function parseStoredCandidate(raw: unknown, where: string): FallbackCandidate {
  if (!isPlainObject(raw)) throw new ContractError("schema", `${where}: fallbackCandidate must be an object`);
  const str = (key: string): string => {
    const v = raw[key];
    if (typeof v !== "string") {
      throw new ContractError("schema", `${where}: fallbackCandidate.${key} must be a string`);
    }
    return v;
  };
  const note = optNullableStr(raw, "note");
  const expiresAt = optNullableStr(raw, "expiresAt");
  const maxSpend = optNullableNum(raw, "maxSpend");
  return {
    route: str("route"),
    model: str("model"),
    billing: validateBilling(str("billing"), `${where}.fallbackCandidate.billing`),
    credential: validateCredential(str("credential"), `${where}.fallbackCandidate.credential`),
    scope: validateScope(str("scope"), `${where}.fallbackCandidate.scope`),
    ...(maxSpend !== undefined ? { maxSpend } : {}),
    ...(expiresAt !== undefined ? { expiresAt } : {}),
    ...(note !== undefined ? { note } : {}),
  };
}

function parseStoredRoute(raw: unknown, where: string): RouteRef {
  if (!isPlainObject(raw)) throw new ContractError("schema", `${where}: route must be an object`);
  const harness = raw["harness"];
  const provider = raw["provider"];
  if (typeof harness !== "string" || typeof provider !== "string") {
    throw new ContractError("schema", `${where}: route.harness/provider must be strings`);
  }
  return { harness, provider };
}

/** Validate one persisted attempt; optional complex payloads are shape-checked. */
function parseStoredAttempt(raw: unknown, where: string): TaskAttempt {
  if (!isPlainObject(raw)) throw new ContractError("schema", `${where}: attempt must be an object`);
  const status = raw["status"];
  if (!isOneOf(status, ATTEMPT_STATUSES)) {
    throw new ContractError("schema", `${where}: invalid attempt status`);
  }
  const finiteNum = (key: string): number => {
    const v = raw[key];
    if (typeof v !== "number" || !Number.isFinite(v)) {
      throw new ContractError("schema", `${where}: ${key} must be a finite number`);
    }
    return v;
  };
  const error = raw["error"];
  const candidate = raw["fallbackCandidate"];
  const profileId = optStr(raw, "profileId");
  const herdrPaneId = optStr(raw, "herdrPaneId");
  const herdrWorkspaceId = optStr(raw, "herdrWorkspaceId");
  const herdrWorkerName = optStr(raw, "herdrWorkerName");
  const credentialScope = optStr(raw, "credentialScope");
  return {
    id: requireStr(raw, "id", where),
    taskId: requireStr(raw, "taskId", where),
    route: parseStoredRoute(raw["route"], where),
    model: requireStr(raw, "model", where),
    attemptNumber: finiteNum("attemptNumber"),
    startedAt: requireStr(raw, "startedAt", where),
    status,
    generation: finiteNum("generation"),
    ...(profileId !== undefined ? { profileId } : {}),
    ...(herdrPaneId !== undefined ? { herdrPaneId } : {}),
    ...(herdrWorkspaceId !== undefined ? { herdrWorkspaceId } : {}),
    ...(herdrWorkerName !== undefined ? { herdrWorkerName } : {}),
    ...(credentialScope !== undefined ? { credentialScope } : {}),
    ...(candidate != null ? { fallbackCandidate: parseStoredCandidate(candidate, `${where}.fallbackCandidate`) } : {}),
    ...(error != null ? { error: parseStoredError(error, `${where}.error`) } : {}),
    ...(raw["result"] !== undefined ? { result: raw["result"] } : {}),
  };
}

function parseStoredDescriptor(raw: unknown, where: string): TaskDescriptor {
  if (!isPlainObject(raw)) throw new ContractError("schema", `${where}: descriptor must be an object`);
  const cls = raw["class"];
  if (cls !== undefined && !isOneOf(cls, TASK_CLASSES)) {
    throw new ContractError("schema", `${where}: invalid task class`);
  }
  const maxAttempts = raw["maxAttempts"];
  if (maxAttempts !== undefined && (typeof maxAttempts !== "number" || !Number.isFinite(maxAttempts))) {
    throw new ContractError("schema", `${where}: maxAttempts must be a number`);
  }
  const timeoutMs = raw["timeoutMs"];
  if (timeoutMs !== undefined && (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs))) {
    throw new ContractError("schema", `${where}: timeoutMs must be a number`);
  }
  const acceptanceCriteria = raw["acceptanceCriteria"];
  if (acceptanceCriteria !== undefined && !Array.isArray(acceptanceCriteria)) {
    throw new ContractError("schema", `${where}: acceptanceCriteria must be an array`);
  }
  const profileId = optStr(raw, "profileId");
  const allowUnobservedEffects = raw["allowUnobservedEffects"];
  if (allowUnobservedEffects !== undefined && typeof allowUnobservedEffects !== "boolean") {
    throw new ContractError("schema", `${where}: allowUnobservedEffects must be a boolean`);
  }
  return {
    id: requireStr(raw, "id", where),
    route: requireStr(raw, "route", where),
    model: requireStr(raw, "model", where),
    prompt: requireStr(raw, "prompt", where),
    ...(profileId !== undefined ? { profileId } : {}),
    ...(cls !== undefined ? { class: cls } : {}),
    ...(maxAttempts !== undefined ? { maxAttempts } : {}),
    ...(acceptanceCriteria !== undefined ? { acceptanceCriteria: stringList(acceptanceCriteria, where, "acceptanceCriteria") } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    ...(allowUnobservedEffects === true ? { allowUnobservedEffects: true } : {}),
  };
}

export function loadTaskState(taskId: string): {
  descriptor: TaskDescriptor;
  history: TaskAttempt[];
  currentAttempt: TaskAttempt | null;
} | null {
  const path = taskStatePath(taskId);
  if (!existsSync(path)) return null;
  try {
    const raw: unknown = JSON.parse(readFileSync(path, "utf-8"));
    if (!isPlainObject(raw)) return null;
    const where = `task state ${taskId}`;
    const historyRaw = raw["history"];
    if (!Array.isArray(historyRaw)) throw new ContractError("schema", `${where}: history must be an array`);
    const currentRaw = raw["currentAttempt"];
    return {
      descriptor: parseStoredDescriptor(raw["descriptor"], `${where}.descriptor`),
      history: historyRaw.map((a, i) => parseStoredAttempt(a, `${where}.history[${i}]`)),
      currentAttempt: currentRaw === null || currentRaw === undefined
        ? null
        : parseStoredAttempt(currentRaw, `${where}.currentAttempt`),
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Agent start options
// ---------------------------------------------------------------------------

function harnessToAgentKind(adapter: string): "claude" | "codex" | "opencode" | "omp" | "dsh" | "vibe" {
  switch (adapter) {
    case "anthropic": return "claude";
    case "opencode": return "opencode";
    case "omp": return "omp";
    case "passthrough": return "dsh";
    default: return "omp";
  }
}

/**
 * OMP agent arguments for a route's provider and model.
 *
 * The provider id OMP knows is the provider's `omp_id`, not the launcher
 * route key: `openrouter-free` and `openrouter` share the native OMP id
 * `openrouter`. Deriving it from config keeps the worker on the route's
 * declared provider instead of a hand-maintained list that silently drifts
 * (a missing entry starts the worker on OMP's default provider, i.e. a
 * different account than the route authorized).
 */
export function buildAgentStartOptions(
  provider: Provider,
  model: string,
  prepared?: OmpWorkerPreparation,
): string[] {
  // The worker argv is built by the same function the interactive plan path
  // uses, so a Herdr worker gets the destructive guard, tool-surface overlay,
  // model-role pins and --profile exactly like a launcher-started OMP. The
  // side-effecting checks (models.yml integrity, credential-source guard,
  // ambient OMP_* rejection) run in prepareOmpWorker before this is called.
  if (provider.anonymous && !provider.omp_custom) {
    // Defense in depth: prepareOmpWorker rejects this too, but a caller that
    // skips preparation must still fail closed — a native OMP provider has
    // no credential-free contract.
    throw new ContractError(
      "state",
      `provider '${provider.key}' is anonymous; OMP has no credential-free route contract unless omp_custom = true`,
    );
  }
  if (ompNeedsManagedProfile(provider) && !prepared?.profile) {
    throw new ContractError(
      "state",
      `provider '${provider.key}' uses a managed OMP profile; buildAgentStartOptions requires prepareOmpWorker(provider) first`,
    );
  }
  const fallback: OmpWorkerPreparation = prepared ?? { profile: null, managed: null };
  return ["--", ...ompWorkerArgs(provider, model, fallback)];
}

// ---------------------------------------------------------------------------
// Task dispatch
// ---------------------------------------------------------------------------

/**
 * Dispatch a new task to Herdr. Creates the task state, resolves the route,
 * and returns the initial attempt.
 */
export async function dispatchTask(
  config: Config,
  descriptor: TaskDescriptor
): Promise<TaskDispatchResult> {
  // Validate route
  const route = config.routes[descriptor.route];
  if (!route) {
    throw new ContractError("identity", `Route not configured: ${descriptor.route}`);
  }

  // Validate model
  const provider = config.providers[route.provider];
  if (!provider) {
    throw new ContractError("identity", `Provider not configured: ${route.provider}`);
  }
  const allowedModels = route.models ?? provider.models ?? [];
  if (!allowedModels.includes(descriptor.model)) {
    throw new ContractError("identity", `Model not allowed for route ${descriptor.route}: ${descriptor.model}`);
  }

  // Resolve fallback profile if specified
  let profileId = descriptor.profileId;
  if (profileId) {
    const tomlText = readFileSync(config.path, "utf-8");
    const parsedToml = parseTomlTable(tomlText, config.path);
    const profile = parseFallbackProfile(parsedToml, profileId);
    if (!profile) {
      throw new ContractError("identity", `Fallback profile not found: ${profileId}`);
    }
    // Verify primary route matches
    if (profile.primaryRoute !== descriptor.route) {
      throw new ContractError("identity", `Profile primary route (${profile.primaryRoute}) does not match task route (${descriptor.route})`);
    }
  }

  // The worker is started with OMP's --provider/--model flags, so the route's
  // adapter must be omp. Starting an OMP worker for another adapter would
  // run a different harness against the route's account. This check precedes
  // the OMP-specific preparation below.
  const harnessKey = route.harness;
  const harness = config.harnesses[harnessKey];
  const agentKind = harnessToAgentKind(harness.adapter);
  if (agentKind !== "omp") {
    throw new ContractError(
      "state",
      `task dispatch drives the omp adapter only; route '${descriptor.route}' uses adapter '${harness.adapter}'`,
    );
  }

  // Credential presence is checked before any launcher-side guard so a
  // missing credential reports itself, not a downstream guard error.
  const workerEnv = taskWorkerEnv(provider);
  // Side-effecting launch checks shared with the interactive path: managed
  // models.yml integrity, credential-source guard, implicit-switch guard.
  // A Herdr worker cannot re-run them inside __exec, so they run here,
  // immediately before the worker is started.
  const prepared = prepareOmpWorker(provider);
  await verifyOmpManagedCredential(provider);

  // Create Herdr workspace for the task
  const workspace = await createWorkspace(process.cwd(), `task-${descriptor.id.slice(0, 8)}`, {
    noFocus: true,
    env: { ...workerEnv, OMP_SKIP_SETUP: "1" },
  });
  const workspaceId = workspace.id;

  // Get the root pane (first pane of first tab) to start the agent
  const rootPaneId = workspace.tabs[0].panes[0].id;
  
  // Wait for the pane to be ready (shell prompt available)
  await new Promise(r => setTimeout(r, 2000));
  
  // Build worker name
  const workerName = `worker-${descriptor.id.slice(0, 8)}-${route.harness}-${randomUUID().slice(0, 8)}`;
  const agentOptions = buildAgentStartOptions(provider, descriptor.model, prepared);
  
  // Start the agent in the root pane with model/provider flags via Herdr
  const startResult = await startAgent({ 
    workerName, 
    kind: agentKind,  // OMP handles all model/provider flags via --provider/--model
    paneId: rootPaneId,
    options: agentOptions
  });
  const workerNameFinal = startResult.agentName;

  // Split pane for output (right side)
  const pane = await createPane({ workspaceId, cwd: process.cwd(), split: "right", noFocus: true });
  const paneId = pane.paneId;

  // Map the agent to the task
  const mapping: HerdrTaskMapping = {
    taskId: descriptor.id,
    workspaceId,
    paneId,
    workerName: workerNameFinal,
    createdAt: new Date().toISOString(),
    route: descriptor.route,
    model: descriptor.model,
  };
  saveHerdrTaskMapping(mapping);

  const routeRef = parseRouteId(descriptor.route);

  const attempt: TaskAttempt = {
    id: randomUUID(),
    taskId: descriptor.id,
    route: routeRef,
    model: descriptor.model,
    profileId,
    attemptNumber: 1,
    startedAt: new Date().toISOString(),
    status: "running",
    herdrPaneId: rootPaneId,
    herdrWorkspaceId: workspaceId,
    herdrWorkerName: workerNameFinal,
    generation: 1,
  };

  // Save initial state under the same per-task lock as outcome writes, so a
  // racing resume/status cannot interleave a read-modify-write.
  withTaskLock(descriptor.id, () => {
    saveTaskState(descriptor.id, {
      descriptor,
      history: [attempt],
      currentAttempt: attempt,
    });
  });

  return { taskId: descriptor.id, attempt };
}

/**
 * Raw failure evidence for a prompt that did not complete, in the shape
 * `executeWithFallback` and `classifyFailure` consume. Null means the prompt
 * produced a response.
 */
function promptFailureSignal(promptResult: { blocked?: boolean; stalled?: boolean; errorCode?: string }): FailureSignal | null {
  // Herdr lifecycle state is NOT provider evidence: a blocked or stalled
  // worker says nothing about the provider's HTTP response, so no status,
  // exit code or failure kind may be fabricated. The signal carries only
  // the lifecycle marker in errorKind and classifies as `unknown`, which
  // fails closed — fallback never advances on a guessed 401/402/403/429.
  if (promptResult.blocked) {
    return { httpStatus: null, exitCode: null, failureKind: null, retryAfterMs: null, resetAt: null, usage: [], errorKind: "agent-blocked" };
  }
  if (promptResult.stalled) {
    return {
      httpStatus: null,
      exitCode: null,
      failureKind: null,
      retryAfterMs: null,
      resetAt: null,
      usage: [],
      errorKind: promptResult.errorCode ? `agent-${promptResult.errorCode}` : "agent-stalled",
    };
  }
  return null;
}

/**
 * The environment a route's worker needs to authenticate.
 *
 * The launcher resolves a provider's credential from Infisical and injects it
 * into the harness process. A Herdr worker is a separate process started by
 * the Herdr server, so it inherits the SERVER's environment, not the
 * dispatcher's: without the credential the worker starts, accepts the prompt
 * and then fails with "No API key found for <provider>".
 *
 * The value is read from this process's environment, which the caller
 * populates by running under script/with-secrets. A credentialed provider
 * whose credential is absent is a hard failure: starting the worker anyway
 * would burn a prompt on a guaranteed auth failure.
 */
export function routeWorkerEnv(provider: Provider): Record<string, string> {
  if (provider.anonymous) return {};
  // Managed-profile providers (omp_custom, or native require_infisical)
  // resolve the credential inside OMP itself: models.yml
  // `apiKey: "!infisical-key.sh <secret>"` makes OMP fetch the value from
  // Infisical at request time. Passing the value through
  // `herdr --env NAME=VALUE` would expose it in process argv and the Herdr
  // server — the secret never needs to leave Infisical. Ambient-credential
  // routes (require_infisical = false, no omp_custom) keep the env path.
  if (provider.secret && (provider.omp_custom || provider.require_infisical)) return {};
  const envName = provider.env ?? provider.secret;
  if (!envName) {
    throw new ContractError("identity", `Provider '${provider.key}' declares no credential env name`);
  }
  const value = process.env[envName];
  if (!value) {
    throw new ContractError(
      "state",
      `credential '${envName}' for provider '${provider.key}' is not in the environment; ` +
        "run the dispatcher under script/with-secrets so the credential is injected",
    );
  }
  return { [envName]: value };
}

/**
 * Credential handoff policy for the Herdr task path (`agent task run` and
 * fallback candidates). Herdr 0.9.5 offers only `--env NAME=VALUE`, which
 * places the secret in process argv and server state; there is no
 * secret-safe channel (pane run/send-text are argv channels too). Until
 * Herdr grows one, the task path is fail-closed for ambient-credential
 * providers: managed-profile providers resolve the secret inside OMP via
 * `apiKey: "!infisical-key.sh <NAME>"` and anonymous providers need
 * nothing, so both return {}. The interactive launcher is unaffected —
 * ambient credentials remain valid there.
 */
function taskWorkerEnv(provider: Provider): Record<string, string> {
  if (provider.anonymous) return {};
  if (provider.secret && (provider.omp_custom || provider.require_infisical)) return {};
  throw new ContractError(
    "policy",
    `provider '${provider.key}' uses an ambient credential that would transit ` +
      "Herdr --env argv; agent task run supports managed-profile (Infisical-" +
      "resolved) and anonymous providers only. Use the interactive launcher " +
      "for this route.",
  );
}

/**
 * Verify an omp_custom provider's Infisical credential resolves BEFORE a
 * worker is spawned. The apiKey `!command` makes OMP fetch the secret
 * itself, so the dispatcher never holds the value — but a missing
 * Infisical session or absent secret would otherwise surface as an opaque
 * provider 401 inside the worker. The resolved value is captured by the
 * child process only to check non-emptiness; it is never stored, logged,
 * or passed on.
 */
async function verifyOmpManagedCredential(provider: Provider): Promise<void> {
  if (!provider.secret || !(provider.omp_custom || provider.require_infisical)) return;
  const helper = join(import.meta.dir, "infisical-key.sh");
  const result = Bun.spawnSync({
    cmd: ["bash", helper, provider.secret],
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0 || result.stdout.length === 0) {
    throw new ContractError(
      "state",
      `Infisical credential '${provider.secret}' for managed-profile provider ` +
        `'${provider.key}' did not resolve; the worker's apiKey command ` +
        "needs a working Infisical session for the dispatching user",
    );
  }
}

/**
 * Start a worker for a fallback candidate in its own pane.
 *
 * The candidate's provider and model are pinned at start time (they cannot be
 * changed on a running worker), so each candidate needs a fresh worker. The
 * pane is created inside the attempt's workspace and closed afterwards.
 */
async function startCandidateWorker(
  attempt: TaskAttempt,
  workerName: string,
  options: string[],
  env: Record<string, string>,
): Promise<{ workerName: string; paneId: string }> {
  const workspaceId = attempt.herdrWorkspaceId;
  if (!workspaceId) {
    throw new ContractError("state", "No Herdr workspace in attempt");
  }
  const pane = await createPane({
    workspaceId,
    cwd: process.cwd(),
    split: "right",
    noFocus: true,
    env,
  });
  // The pane must be at an interactive shell prompt before an agent can start.
  await new Promise(r => setTimeout(r, 2000));
  const startResult = await startAgent({
    workerName,
    kind: "omp",
    paneId: pane.paneId,
    options,
  });
  return { workerName: startResult.agentName, paneId: pane.paneId };
}

/** Close a candidate's pane so a failed candidate leaves no worker behind. */
async function closeCandidateWorker(candidate: { workerName: string; paneId: string }): Promise<void> {
  try {
    await closePane(candidate.paneId);
  } catch {
    // A pane that is already gone needs no cleanup; never let cleanup mask
    // the failure that caused the candidate to be abandoned.
  }
}

/**
 * The output a worker produced.
 *
 * `herdr agent prompt` reports the agent's STATE, not its answer: the text
 * lives in the agent's terminal output, which is a screen dump containing the
 * prompt, the agent's reply and the surrounding UI. It is returned raw, under
 * an explicit name, so no caller mistakes it for a parsed answer.
 */
async function readWorkerOutput(workerName: string): Promise<string | undefined> {
  try {
    const read = await readAgent(workerName, { source: "recent", lines: 200 });
    return read.output?.trim() || undefined;
  } catch {
    return undefined;
  }
}

/** The credential scope an attempt ran under — the env NAME or the
 * Infisical secret name, never a value. Recorded for audit/resume. */
function credentialScopeFor(config: Config, providerKey: string): string {
  const provider = config.providers[providerKey];
  if (!provider) return "unknown";
  if (provider.anonymous) return "none";
  if (provider.omp_custom && provider.secret) return `infisical:${provider.secret}`;
  return provider.env ?? provider.secret ?? "unknown";
}

/**
 * Persist one fallback-attempt outcome into the task history. Called by
 * executeWithFallback's onAttempt hook for EVERY attempt (primary and each
 * candidate), so the durable record shows which route/model/credential
 * scope ran, how it failed (classified), and which worker served it —
 * enough to resume or audit without Herdr state.
 */
/** Read the worker identity/output fields out of an unknown executor result. */
function servedWorker(result: unknown): { output?: string; workerName?: string; paneId?: string } | null {
  if (!isPlainObject(result)) return null;
  const pick = (key: string): string | undefined => {
    const v = result[key];
    return typeof v === "string" ? v : undefined;
  };
  return { output: pick("output"), workerName: pick("workerName"), paneId: pick("paneId") };
}

function recordCandidateAttempt(
  parent: TaskAttempt,
  record: {
    route: RouteRef;
    model: string;
    candidate: FallbackCandidate | null;
    success: boolean;
    error: FailureSignal | null;
    classified: ClassifiedError | null;
    result: unknown;
  },
  credentialScope: string,
): void {
  withTaskLock(parent.taskId, () => {
  const state = loadTaskState(parent.taskId);
  if (!state) return;
  const served = servedWorker(record.result);
  const attempt: TaskAttempt = {
    id: randomUUID(),
    taskId: parent.taskId,
    route: record.route,
    model: record.model,
    profileId: parent.profileId,
    attemptNumber: state.history.length + 1,
    startedAt: new Date().toISOString(),
    status: record.success ? "completed" : "failed",
    herdrWorkerName: served?.workerName,
    herdrPaneId: served?.paneId,
    herdrWorkspaceId: parent.herdrWorkspaceId,
    generation: parent.generation,
    fallbackCandidate: record.candidate ?? undefined,
    error: record.classified ?? undefined,
    credentialScope,
    result: record.success ? { output: served?.output } : undefined,
  };
  state.history.push(attempt);
    saveTaskState(parent.taskId, state);
  });
}

/**
 * Send a prompt to the agent and handle retries/fallback.
 *
 * Returns the worker that served the request: the primary's own worker, or
 * the fallback candidate's worker. Collection must read from that worker, or
 * a candidate's answer would be collected from the primary's terminal.
 */
export async function startTaskAttempt(
  config: Config,
  attempt: TaskAttempt,
  prompt: string,
  opts?: { timeoutMs?: number; evidenceSinceMs?: number; lease?: Lease; attemptKey?: string }
): Promise<{ success: boolean; error?: ClassifiedError; result?: unknown; workerName?: string; paneId?: string }> {
  // --timeout propagates to every prompt wait in this attempt (primary and
  // each fallback candidate); the default matches the previous fixed bound.
  const promptTimeoutMs = opts?.timeoutMs ?? 300000;
  if (!attempt.herdrWorkerName || !attempt.herdrPaneId) {
    throw new ContractError("state", "No Herdr worker name or pane in attempt");
  }

  // Provider evidence window: session events count only at/after this
  // execution began, so a stale failure from an earlier run can never be
  // attributed to this attempt.
  const evidenceSinceMs = opts?.evidenceSinceMs ?? Date.now();
  const cwd = process.cwd();
  /**
   * Upgrade a lifecycle-derived failure signal with REAL provider evidence
   * (OMP session errorStatus) when the worker's session recorded an actual
   * HTTP failure. Returns the lifecycle signal unchanged when no evidence
   * exists — unknown stays unknown, never a guessed status.
   */
  const withProviderEvidence = async (
    signal: FailureSignal,
    provider: Provider,
  ): Promise<FailureSignal> => {
    const evidence = extractProviderFailureEvidence({ provider, cwd, sinceMs: evidenceSinceMs, prompt });
    return evidence ?? signal;
  };
  /**
   * Herdr can report a prompt as delivered while the provider's LAST turn
   * outcome was an error (the agent surfaces it as text, not a lifecycle
   * failure). Scan the session for a qualifying final error outcome even on
   * the "success" path: a real provider failure must classify and may
   * advance fallback, never be mistaken for task success.
   */
  const lateProviderError = (provider: Provider): FailureSignal | null =>
    extractProviderFailureEvidence({ provider, cwd, sinceMs: evidenceSinceMs, prompt });
  const primaryProvider = config.providers[attempt.route.provider];

  try {
    // Use the fallback execution logic if a profile is available
    if (attempt.profileId) {
      // prepareOmpWorker runs filesystem/credential-source guards; cache per
      // provider so a retry on the same candidate does not re-scan.
      const preparedProviders = new Map<string, OmpWorkerPreparation>();
      const result = await executeWithFallback(config, attempt.profileId, async (routeRef, model, candidate) => {
        // The primary attempt runs on the worker already started for this
        // route. A CANDIDATE is a different route/model on the same harness,
        // so it needs its own worker: the current one is pinned to the
        // primary's provider and model, and re-prompting it would silently
        // run the primary again instead of the candidate the profile
        // authorized.
        if (candidate === null) {
          const promptResult = await journaledEffect(opts?.lease, uniqueEffectId("prompt", attempt.herdrWorkerName!), "prompt-send", attempt.herdrWorkerName!, () =>
            promptAgent(attempt.herdrWorkerName!, prompt, { wait: true, timeoutMs: promptTimeoutMs }), promptSendVerdict);
          const signal = promptFailureSignal(promptResult);
          if (signal) {
            const enriched = primaryProvider
              ? await withProviderEvidence(signal, primaryProvider)
              : signal;
            return { success: false, error: enriched };
          }
          const output = await readWorkerOutput(attempt.herdrWorkerName!);
          const late = primaryProvider ? lateProviderError(primaryProvider) : null;
          if (late) return { success: false, error: late };
          return { success: true, result: { output, workerName: attempt.herdrWorkerName! } };
        }

        const candidateRoute = formatRouteId(routeRef);
        const candidateProvider = config.providers[routeRef.provider];
        if (!candidateProvider) {
          throw new ContractError("identity", `Provider not configured: ${routeRef.provider}`);
        }
        const candidateHarness = config.harnesses[routeRef.harness];
        if (!candidateHarness) {
          throw new ContractError("identity", `Harness not configured: ${routeRef.harness}`);
        }
        if (harnessToAgentKind(candidateHarness.adapter) !== "omp") {
          throw new ContractError(
            "state",
            `fallback candidate '${candidateRoute}' uses adapter '${candidateHarness.adapter}'; only the omp adapter is supported`,
          );
        }

        // Gate EVERY candidate dispatch: an unreconciled effect from a
        // prior candidate (or an interrupted run) must block the next
        // external operation — never assume it did not happen.
        if (opts?.attemptKey) assertNoPendingEffects(opts.attemptKey, attempt.taskId);
        const workerName = `worker-${attempt.taskId.slice(0, 8)}-${routeRef.harness}-${randomUUID().slice(0, 8)}`;
        const candidatePrepared = preparedProviders.get(routeRef.provider)
          ?? prepareOmpWorker(candidateProvider);
        preparedProviders.set(routeRef.provider, candidatePrepared);
        await verifyOmpManagedCredential(candidateProvider);
        const options = buildAgentStartOptions(candidateProvider, model, candidatePrepared);
        const candidateAttempt = await journaledEffect(
          opts?.lease,
          uniqueEffectId("dispatch", workerName),
          "worker-start",
          workerName,
          () => startCandidateWorker(attempt, workerName, options, {
            ...taskWorkerEnv(candidateProvider),
            OMP_SKIP_SETUP: "1",
          }),
        );

        // Re-check immediately before the candidate prompt: the worker-start
        // post may have raced a crash-window effect.
        if (opts?.attemptKey) assertNoPendingEffects(opts.attemptKey, attempt.taskId);
        let outcome: { success: boolean; error?: FailureSignal; result?: unknown } | undefined;
        try {
          const promptResult = await journaledEffect(opts?.lease, uniqueEffectId("prompt", candidateAttempt.workerName), "prompt-send", candidateAttempt.workerName, () =>
            promptAgent(candidateAttempt.workerName, prompt, { wait: true, timeoutMs: promptTimeoutMs }), promptSendVerdict);
          const signal = promptFailureSignal(promptResult);
          if (signal) {
            outcome = {
              success: false,
              error: await withProviderEvidence(signal, candidateProvider),
            };
          } else {
            // The output must be read before the pane is closed — and on
            // success the pane stays OPEN until collectTaskAttempt has read
            // the serving worker (closing it here made collect read a dead
            // pane).
            const output = await readWorkerOutput(candidateAttempt.workerName);
            const late = lateProviderError(candidateProvider);
            if (late) {
              outcome = { success: false, error: late };
            } else {
              outcome = {
                success: true,
                result: {
                  output,
                  workerName: candidateAttempt.workerName,
                  paneId: candidateAttempt.paneId,
                },
              };
            }
          }
        } finally {
          // Close the pane only when the candidate did NOT serve the task:
          // a successful candidate's worker must stay alive until
          // collectTaskAttempt reads it.
          if (!outcome || !outcome.success) {
            await closeCandidateWorker(candidateAttempt);
          }
        }
        return outcome ?? { success: false };
      }, {
        // The model the task was dispatched with, not the route default:
        // the primary worker is already pinned to it.
        primaryModel: attempt.model,
        onAttempt: (record) => recordCandidateAttempt(attempt, record, credentialScopeFor(config, record.route.provider)),
      });
      const served = servedWorker(result.result);
      return {
        success: true,
        result: { output: served?.output },
        workerName: served?.workerName,
        paneId: served?.paneId,
      };
    } else {
      // No fallback profile - single route execution
      const promptResult = await journaledEffect(opts?.lease, uniqueEffectId("prompt", attempt.herdrWorkerName!), "prompt-send", attempt.herdrWorkerName!, () =>
        promptAgent(attempt.herdrWorkerName!, prompt, { wait: true, timeoutMs: promptTimeoutMs }), promptSendVerdict);
      const signal = promptFailureSignal(promptResult);
      if (signal) {
        const enriched = primaryProvider
          ? await withProviderEvidence(signal, primaryProvider)
          : signal;
        return { success: false, error: classifyFailure(enriched, new Date().toISOString()) };
      }
      const output = await readWorkerOutput(attempt.herdrWorkerName!);
      const late = primaryProvider ? lateProviderError(primaryProvider) : null;
      if (late) {
        return { success: false, error: classifyFailure(late, new Date().toISOString()) };
      }
      return { success: true, result: { output }, workerName: attempt.herdrWorkerName };
    }
  } catch (error) {
    // Every candidate was exhausted: the executor already classified the
    // failure, so keep that verdict instead of re-deriving "unknown" from a
    // blank signal.
    if (error instanceof FallbackExhaustedError && error.lastError) {
      return { success: false, error: error.lastError };
    }
    // Any other error carries no structured evidence: fail closed as unknown.
    const signal: FailureSignal = {
      httpStatus: null,
      failureKind: null,
      exitCode: null,
      retryAfterMs: null,
      resetAt: null,
      usage: [],
      errorKind: "exception"
    };
    const classified = classifyFailure(signal, new Date().toISOString());
    return { success: false, error: classified };
  }
}

/**
 * Observe the current status of a task attempt.
 */
export async function observeTaskAttempt(attempt: TaskAttempt): Promise<{
  status: "running" | "completed" | "failed" | "blocked";
  output?: string;
}> {
  if (!attempt.herdrWorkerName) {
    return { status: "failed", output: "No Herdr worker name" };
  }

  const waitResult = await waitAgent(attempt.herdrWorkerName, 5000);
  if (waitResult.completed) {
    const readResult = await readAgent(attempt.herdrWorkerName, { source: "recent", lines: 100 });
    return { status: "completed", output: readResult.output };
  }
  return { status: "running", output: "Agent still working" };
}

/**
 * Collect the result of a completed task attempt.
 */
export async function collectTaskAttempt(
  attempt: TaskAttempt,
  timeoutMs: number = 300000
): Promise<CollectResult> {
  if (!attempt.herdrWorkerName) {
    return {
      taskId: attempt.taskId,
      attempt,
      success: false,
      error: { category: "unknown", observedAt: new Date().toISOString(), resetAt: null, retryAfterMs: null, exhausted: false, reason: "No Herdr worker name", quotaScopeKey: null },
    };
  }

  try {
    // Wait for the attempt to complete
    const waitResult = await waitAgent(attempt.herdrWorkerName, timeoutMs);
    
    // Read the output
    const readResult = await readAgent(attempt.herdrWorkerName, { source: "recent", lines: 200 });
    
    return {
      taskId: attempt.taskId,
      attempt,
      success: waitResult.completed,
      result: { output: readResult.output, completed: waitResult.completed, reason: waitResult.reason },
    };
  } catch (error) {
    const signal: FailureSignal = { 
      httpStatus: null, 
      failureKind: null, 
      exitCode: null, 
      retryAfterMs: null, 
      resetAt: null, 
      usage: [], 
      errorKind: "exception" 
    };
    const classified = classifyFailure(signal, new Date().toISOString());
    return {
      taskId: attempt.taskId,
      attempt,
      success: false,
      error: classified,
    };
  }
}

/**
 * Record the outcome of a finished attempt in the task state.
 *
 * The attempt history is the durable record of what was tried and how it
 * failed: the classified reason travels with it, so a resumed task can tell a
 * quota exhaustion from an auth failure without re-deriving it.
 */
export function recordAttemptOutcome(
  taskId: string,
  attempt: TaskAttempt,
  outcome: { status: "completed" | "failed" | "blocked"; error?: ClassifiedError; result?: unknown },
): TaskAttempt | null {
  // Load-modify-save runs under the per-task file lock so a concurrent
  // status read + outcome write (or two racing resumes) cannot lose an
  // update; the atomic rename inside saveTaskState covers crash mid-write.
  return withTaskLock(taskId, () => {
    const state = loadTaskState(taskId);
    if (!state) return null;

    const finished: TaskAttempt = {
      ...attempt,
      status: outcome.status,
      error: outcome.error,
      result: outcome.result,
    };

    // Replace the attempt in place when it is already recorded (the dispatched
    // attempt is saved up front); otherwise append it. A stale writer (an
    // older generation object) must never overwrite a newer recorded state.
    const index = state.history.findIndex(a => a.id === attempt.id);
    if (index >= 0) {
      if (state.history[index].generation > finished.generation) {
        throw new ContractError(
          "evidence",
          `task '${taskId}': attempt generation moved to ${state.history[index].generation}; ` +
            `refusing stale outcome write from generation ${finished.generation}`,
        );
      }
      state.history[index] = finished;
    } else {
      state.history.push(finished);
    }
    state.currentAttempt = finished;
    saveTaskState(taskId, state);

    return finished;
  });
}

/** Serialize mutations of one task's state file (read-modify-write CAS). */
function withTaskLock<T>(taskId: string, fn: () => T): T {
  taskStatePath(taskId); // validates the id before it reaches a path
  return withFileLock(join(TASK_STATE_DIR, `${taskId}.lock`), fn);
}

// ---------------------------------------------------------------------------
// High-level task orchestration
// ---------------------------------------------------------------------------

export interface WorkspaceBaseline {
  headSha: string | null;
  dirtyCount: number;
  unpushedCount: number | null;
}

function gitOut(args: string[]): string | null {
  const r = spawnSync("git", args, { cwd: process.cwd(), encoding: "utf8", timeout: 10000 });
  if (r.status !== 0) return null;
  return r.stdout.trim();
}

/**
 * Observable workspace state for side-effect reconciliation: HEAD, dirty
 * entry count, and unpushed commit count. Worker-internal effects (commits,
 * pushes, file writes) cannot be journaled by the router — this baseline is
 * the external observation the next run/resume compares against. Anything
 * unobservable stays null and is reported as such, never assumed safe.
 */
/** True while the task workspace has an in-progress git operation
 *  (merge, rebase, cherry-pick, revert, sequencer). Resuming into such a
 *  state would interleave the continue-prompt with half-finished
 *  external state — fail closed until the operator resolves it. */
export function gitOperationInProgress(): boolean {
  for (const ref of ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD"]) {
    const p = gitOut(["rev-parse", "-q", "--git-path", ref]);
    if (p !== null && existsSync(p)) return true;
  }
  for (const dir of ["rebase-merge", "rebase-apply", "sequencer"]) {
    const p = gitOut(["rev-parse", "-q", "--git-path", dir]);
    if (p !== null && existsSync(p)) return true;
  }
  return false;
}

export function captureWorkspaceBaseline(): WorkspaceBaseline | null {
  const head = gitOut(["rev-parse", "HEAD"]);
  if (head === null) return null; // not a git worktree — nothing observable
  const status = gitOut(["status", "--porcelain"]);
  const unpushed = gitOut(["rev-list", "--count", "@{u}..HEAD"]);
  return {
    headSha: head,
    dirtyCount: status === null ? -1 : status.split("\n").filter((l) => l.trim() !== "").length,
    unpushedCount: unpushed === null ? null : Number(unpushed),
  };
}

function workspaceDrift(
  before: WorkspaceBaseline | null | undefined,
  after: WorkspaceBaseline | null,
): { before: WorkspaceBaseline | null; after: WorkspaceBaseline | null; changed: boolean | null } | null {
  if (!before || !after) return null;
  return {
    before,
    after,
    changed:
      before.headSha !== after.headSha ||
      before.dirtyCount !== after.dirtyCount ||
      before.unpushedCount !== after.unpushedCount,
  };
}

/**
 * Execute each declared acceptance criterion as a shell command in the
 * task's working directory and report per-check exit status. Criteria are
 * user-supplied at dispatch (`--accept`), so this is the same trust level
 * as the operator running them; output is not persisted (only exit
 * status), keeping secrets out of durable state. `verified` is true only
 * when every check exits 0 — worker success alone never implies it.
 */
export async function verifyAcceptanceCriteria(
  criteria: string[],
  cwd: string,
  timeoutMs: number,
): Promise<AcceptanceReport> {
  const shell = process.platform === "win32" ? "cmd" : "sh";
  const shellArgs = process.platform === "win32" ? ["/c"] : ["-c"];
  const checks: AcceptanceCheck[] = [];
  for (const command of criteria) {
    const proc = Bun.spawn([shell, ...shellArgs, command], {
      cwd,
      stdout: "ignore",
      stderr: "ignore",
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill();
    }, timeoutMs);
    const exitCode = await proc.exited.finally(() => clearTimeout(timer));
    checks.push({ command, exitCode: timedOut ? null : exitCode, timedOut });
  }
  return { verified: checks.every((c) => c.exitCode === 0 && !c.timedOut), checks };
}

/**
 * Run a task to completion with automatic fallback handling.
 *
 * The fallback profile's candidates are executed inside `startTaskAttempt`
 * (each on its own worker, on its own route/model), so a failure there has
 * already exhausted every authorized candidate. Re-dispatching the primary
 * route would run the same exhausted provider again instead of the candidate
 * the profile authorized.
 */
export async function runTaskToCompletion(
  config: Config,
  descriptor: TaskDescriptor
): Promise<CollectResult> {
  // Auto-fallback re-prompts workers whose external side effects cannot be
  // fully audited. Restrict it to scopes where continuation is verifiable:
  // declared acceptance criteria, a git-observable workspace (drift is
  // recorded), or an explicit operator acknowledgement. Otherwise fail
  // closed BEFORE any worker is created.
  if (descriptor.profileId) {
    const verifiable =
      (descriptor.acceptanceCriteria?.length ?? 0) > 0 ||
      captureWorkspaceBaseline() !== null ||
      descriptor.allowUnobservedEffects === true;
    if (!verifiable) {
      throw new ContractError(
        "policy",
        "fallback profile requires a verifiable scope: pass --accept criteria, " +
          "run inside a git worktree (workspace drift is recorded), or pass " +
          "--allow-unobserved-effects to acknowledge unaudited side effects",
      );
    }
  }
  // Dispatch the task
  const { attempt } = await dispatchTask(config, descriptor);
  
  // Wait for agent to be ready
  await waitAgent(attempt.herdrWorkerName!, 30000);

  // Exclusive execution lease: fences any concurrent resume/dispatch on the
  // same task and anchors journal pre/post entries for this run.
  const lease = acquireTaskLease(descriptor, `task-${process.pid}`);
  const baselineBefore = captureWorkspaceBaseline();
  try {
  // Unreconciled effects from a previous run block replay — never assume
  // an interrupted operation did not happen.
  assertNoPendingEffects(taskAttemptKey(descriptor), descriptor.id);

  // Start the attempt
  const startResult = await startTaskAttempt(config, attempt, descriptor.prompt, {
    timeoutMs: descriptor.timeoutMs,
    lease,
    attemptKey: taskAttemptKey(descriptor),
  });
  
  if (!startResult.success) {
    // Every authorized candidate failed. The classified reason travels with
    // the result, so the caller sees the real category (auth, quota, ...).
    recordAttemptOutcome(descriptor.id, attempt, { status: "failed", error: startResult.error });
    return {
      taskId: descriptor.id,
      attempt,
      success: false,
      error: startResult.error,
    };
  }

  // Collect from the worker that served the request: a fallback candidate
  // runs on its own worker, and reading the primary's terminal would
  // return the wrong output.
  const serving = startResult.workerName ?? attempt.herdrWorkerName!;
  const collected = await collectTaskAttempt(
    { ...attempt, herdrWorkerName: serving },
    descriptor.timeoutMs,
  );
  // Acceptance criteria are verified against the workspace AFTER collect,
  // independently of worker success: a completed worker with failing
  // criteria is NOT a completed task.
  const acceptance = collected.success && descriptor.acceptanceCriteria?.length
    ? await verifyAcceptanceCriteria(
        descriptor.acceptanceCriteria,
        process.cwd(),
        Math.min(descriptor.timeoutMs ?? 120000, 120000),
      )
    : undefined;
  // Durable status must agree with the CLI verdict: worker success alone is
  // NOT task completion when declared acceptance criteria failed. The
  // acceptance report is persisted inside the attempt result so `task
  // status`, history and any later resume all see the same outcome.
  const accepted = acceptance === undefined || acceptance.verified;
  const taskSucceeded = collected.success && accepted;
  const storedResult = {
    ...(isPlainObject(collected.result) ? collected.result : { value: collected.result }),
    ...(acceptance ? { acceptance } : {}),
    workspaceBaseline: captureWorkspaceBaseline(),
    ...(workspaceDrift(baselineBefore, captureWorkspaceBaseline())
      ? { workspaceDrift: workspaceDrift(baselineBefore, captureWorkspaceBaseline()) }
      : {}),
  };
  const outcomeError: ClassifiedError | undefined = !collected.success
    ? collected.error
    : !accepted
      ? {
          category: "unknown",
          observedAt: new Date().toISOString(),
          resetAt: null,
          retryAfterMs: null,
          exhausted: false,
          reason: "worker completed but acceptance criteria were not verified",
          quotaScopeKey: null,
        }
      : undefined;
  // Record against the SERVING worker AND its route/model: after a fallback
  // the candidate's worker — not the primary's — produced the result, and
  // resume/status/evidence must reference the provider that actually served.
  const persisted = loadTaskState(descriptor.id);
  const servingRecord = persisted?.history.find(
    (a) => a.id !== attempt.id && a.herdrWorkerName === serving,
  );
  const recordedAttempt: TaskAttempt = servingRecord
    ? {
        ...attempt,
        herdrWorkerName: serving,
        herdrPaneId: servingRecord.herdrPaneId ?? attempt.herdrPaneId,
        route: servingRecord.route,
        model: servingRecord.model,
        ...(servingRecord.fallbackCandidate ? { fallbackCandidate: servingRecord.fallbackCandidate } : {}),
      }
    : { ...attempt, herdrWorkerName: serving };
  recordAttemptOutcome(descriptor.id, recordedAttempt, {
    status: taskSucceeded ? "completed" : "failed",
    error: outcomeError,
    result: storedResult,
  });
  // A fallback candidate ran on its own pane: close it only AFTER collect
  // has read the serving worker. The primary's root pane is never closed
  // here (paneId is set only for candidate workers).
  // The serving candidate's pane stays OPEN after collect, exactly like the
  // primary's: `agent task resume` targets the recorded worker, and closing
  // it here would make every fallback-served task unresumable. Pane cleanup
  // is the same lifecycle as the primary worker's (operator/Herdr GC).
  return { ...collected, ...(acceptance ? { acceptance } : {}) };
  } finally {
    try {
      releaseLease(taskAttemptStore, lease, Date.now());
    } catch {
      // Lease release failure must not mask the task outcome; expiry fences.
    }
  }
}

/**
 * Resume an interrupted task by re-prompting its EXISTING worker.
 *
 * Conservative by design: resume re-prompts the SAME worker recorded on
 * the attempt — it never re-enters dispatch or candidate selection, so no
 * duplicate worker, prompt replay, or side-effect re-execution can occur.
 * This holds for single-route and fallback-profile tasks alike: after a
 * candidate served, the recorded worker IS the candidate's. The worker
 * keeps its own session context, so a "continue" prompt resumes in place
 * rather than replaying the original instruction. Acceptance criteria are
 * re-verified and durable status follows the same worker-success AND
 * acceptance-verified rule as dispatch.
 */
/**
 * Reconcile pending (pre-without-post) journal effects for a task.
 *
 * A "prompt-send" UNKNOWN resolves to succeeded ONLY on positive proof:
 * exactly one provider session observed the prompt turn at/after the
 * pre timestamp. Zero or ambiguous matches stay pending — absence of
 * evidence is not evidence of absence. A "worker-start" resolves when
 * the worker still exists in Herdr. Everything else stays pending and
 * keeps blocking replay. The reconcile itself holds the execution lease
 * so it cannot interleave with a live run/resume.
 */
export async function reconcileTaskEffects(
  config: Config,
  taskId: string,
): Promise<{ resolved: string[]; pending: string[] }> {
  const state = loadTaskState(taskId);
  if (!state) {
    throw new ContractError("identity", `no task state for '${taskId}'`);
  }
  const attemptKey = taskAttemptKey(state.descriptor);
  const pending = pendingSideEffects(taskJournalStore, attemptKey);
  if (pending.length === 0) return { resolved: [], pending: [] };
  const lease = acquireTaskLease(state.descriptor, `reconcile-${process.pid}`);
  const resolved: string[] = [];
  const stillPending: string[] = [];
  try {
    for (const effect of pending) {
      let outcome: "succeeded" | "failed" | null = null;
      if (effect.kind === "prompt-send") {
        const sinceMs = Date.parse(effect.declaredAt);
        const verdicts = Object.values(config.providers).map((provider) =>
          providerTurnObserved({
            provider,
            cwd: process.cwd(),
            sinceMs: Number.isFinite(sinceMs) ? sinceMs : 0,
            prompt: state.descriptor.prompt,
          }));
        const ones = verdicts.filter((v) => v === "one").length;
        const manies = verdicts.filter((v) => v === "many").length;
        if (ones === 1 && manies === 0) outcome = "succeeded";
      } else if (effect.kind === "worker-start") {
        const agent = await getAgent(effect.target).catch(() => null);
        if (agent !== null) outcome = "succeeded";
      }
      if (outcome !== null) {
        journalPostEffect(taskAttemptStore, taskJournalStore, lease, {
          effectId: effect.effectId, outcome, ref: null,
        }, Date.now());
        resolved.push(effect.effectId);
      } else {
        stillPending.push(effect.effectId);
      }
    }
  } finally {
    try { releaseLease(taskAttemptStore, lease, Date.now()); } catch { /* expiry fences */ }
  }
  return { resolved, pending: stillPending };
}

export async function resumeTaskAttempt(
  config: Config,
  taskId: string,
  prompt: string,
  opts?: { timeoutMs?: number },
): Promise<CollectResult> {
  const state = loadTaskState(taskId);
  if (!state) {
    throw new ContractError("identity", `no task state for '${taskId}'`);
  }
  const attempt = state.currentAttempt;
  if (!attempt) {
    throw new ContractError("state", `task '${taskId}' has no current attempt`);
  }
  if (attempt.status === "completed") {
    throw new ContractError("state", `task '${taskId}' already completed`);
  }
  if (!attempt.herdrWorkerName) {
    throw new ContractError("state", `task '${taskId}' attempt has no worker to resume`);
  }
  // Safety gate: the worker must EXIST in Herdr, not merely fail to report
  // "completed" — waitAgent's timeout path is indistinguishable from a live
  // worker, so probe the agent record itself. A dead/gone worker fails
  // closed: resuming into nothing would silently drop the task.
  const agent = await getAgent(attempt.herdrWorkerName).catch(() => null);
  if (agent === null) {
    throw new ContractError(
      "state",
      `task '${taskId}' worker '${attempt.herdrWorkerName}' is not present in Herdr; ` +
        "re-dispatch with agent task run",
    );
  }
  // Resume NEVER re-enters startTaskAttempt/executeWithFallback: that path
  // would re-dispatch the primary or spin up duplicate candidate workers —
  // exactly the double-side-effect case fencing exists to prevent. The
  // existing worker keeps its own session (provider/model/tool context),
  // so a continue prompt resumes in place for single-route AND
  // fallback-profile tasks under the same contract.
  const evidenceSinceMs = Date.now();
  const promptTimeoutMs = opts?.timeoutMs ?? 300000;
  // Resume is a new generation of the same attempt: fencing then refuses
  // any outcome write still holding the pre-resume generation.
  const resumed = { ...attempt, generation: attempt.generation + 1 };

  // Exclusive lease BEFORE the prompt leaves this process: two concurrent
  // resumes must not both reach the worker. The attempts.ts generation
  // advance fences any stale lease holder; pending journal effects block
  // replay until externally reconciled.
  const attemptKey = taskAttemptKey(state.descriptor);
  assertNoPendingEffects(attemptKey, taskId);
  // Workspace must not be mid-git-operation: a continue prompt into an
  // unresolved merge/rebase would race half-finished external state.
  if (gitOperationInProgress()) {
    throw new ContractError(
      "state",
      `task '${taskId}' workspace has a git operation in progress ` +
        "(merge/rebase/cherry-pick/revert); resolve it externally before resume",
    );
  }
  const lease = acquireTaskLease(state.descriptor, `resume-${process.pid}`);
  // The lease covers the WHOLE resume — prompt, evidence scan, collect,
  // acceptance verification and the durable outcome write — so a concurrent
  // resume or stale writer is fenced until the new state is committed.
  let promptResult;
  try {
    promptResult = await journaledEffect(lease, uniqueEffectId("prompt", resumed.herdrWorkerName!), "prompt-send", resumed.herdrWorkerName!, () =>
      promptAgent(resumed.herdrWorkerName!, prompt, { wait: true, timeoutMs: promptTimeoutMs }), promptSendVerdict);
  const signal = promptFailureSignal(promptResult);
  if (signal) {
    // Same evidence contract as dispatch: real provider errorStatus from
    // the worker's OMP session, else the lifecycle signal stays unknown.
    const provider = config.providers[resumed.route.provider];
    const enriched = provider
      ? (extractProviderFailureEvidence({ provider, cwd: process.cwd(), sinceMs: evidenceSinceMs, prompt }) ?? signal)
      : signal;
    const error = classifyFailure(enriched, new Date().toISOString());
    recordAttemptOutcome(taskId, resumed, { status: "failed", error });
    return { taskId, attempt: resumed, success: false, error };
  }
  // Same late-error contract as dispatch: Herdr "delivered" is not proof the
  // provider's last turn succeeded — a qualifying final error outcome in
  // the session fails the resume, it does not pass silently.
  const resumeProvider = config.providers[resumed.route.provider];
  const late = resumeProvider
    ? extractProviderFailureEvidence({ provider: resumeProvider, cwd: process.cwd(), sinceMs: evidenceSinceMs, prompt })
    : null;
  if (late) {
    const error = classifyFailure(late, new Date().toISOString());
    recordAttemptOutcome(taskId, resumed, { status: "failed", error });
    return { taskId, attempt: resumed, success: false, error };
  }
  const output = await readWorkerOutput(resumed.herdrWorkerName!);
  const collected = await collectTaskAttempt(
    { ...resumed, result: { output } },
    opts?.timeoutMs,
  );
  // Acceptance criteria re-verified on resume, same rule as dispatch:
  // worker success without verified criteria is not task completion.
  const persisted = loadTaskState(taskId);
  const criteria = persisted?.descriptor.acceptanceCriteria ?? [];
  const prevResult = isPlainObject(persisted?.currentAttempt?.result)
    ? persisted.currentAttempt.result
    : null;
  const prevBaseline = isPlainObject(prevResult) && isPlainObject(prevResult["workspaceBaseline"])
    ? (prevResult["workspaceBaseline"] as unknown as WorkspaceBaseline)
    : null;
  const baselineBefore = captureWorkspaceBaseline();
  const acceptance = collected.success && criteria.length
    ? await verifyAcceptanceCriteria(criteria, process.cwd(), Math.min(opts?.timeoutMs ?? 120000, 120000))
    : undefined;
  const accepted = acceptance === undefined || acceptance.verified;
  const taskSucceeded = collected.success && accepted;
  const drift = workspaceDrift(prevBaseline ?? baselineBefore, captureWorkspaceBaseline());
  const storedResult = {
    ...(isPlainObject(collected.result) ? collected.result : { value: collected.result }),
    ...(acceptance ? { acceptance } : {}),
    workspaceBaseline: captureWorkspaceBaseline(),
    ...(drift ? { workspaceDrift: drift } : {}),
  };
  recordAttemptOutcome(taskId, resumed, {
    status: taskSucceeded ? "completed" : "failed",
    error: !collected.success
      ? collected.error
      : !accepted
        ? {
            category: "unknown",
            observedAt: new Date().toISOString(),
            resetAt: null,
            retryAfterMs: null,
            exhausted: false,
            reason: "worker completed but acceptance criteria were not verified",
            quotaScopeKey: null,
          }
        : undefined,
    result: storedResult,
  });
  return { ...collected, attempt: resumed, ...(acceptance ? { acceptance } : {}) };
  } finally {
    try { releaseLease(taskAttemptStore, lease, Date.now()); } catch { /* expiry fences */ }
  }
}

/**
 * Get current task status.
 */
export function getTaskStatus(taskId: string): TaskStatus | null {
  const state = loadTaskState(taskId);
  if (!state) return null;
  
  return {
    taskId,
    currentAttempt: state.currentAttempt,
    history: state.history,
    overallStatus: state.currentAttempt?.status === "completed" ? "completed" :
                   state.currentAttempt?.status === "failed" ? "failed" :
                   state.currentAttempt?.status === "blocked" ? "blocked" :
                   state.currentAttempt?.status === "fallback" ? "awaiting-fallback" :
                   state.currentAttempt ? "running" : "pending",
  };
}