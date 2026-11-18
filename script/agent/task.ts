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

import { ContractError, isPlainObject, parseRouteId, formatRouteId, parseTomlTable, requireStr, stringList, type RouteRef } from "./contract.ts";
import { type FallbackCandidate, parseFallbackProfile } from "./fallback.ts";
import {
  executeWithFallback,
  FallbackExhaustedError,
  type ClassifiedError,
  type FailureSignal,
  classifyFailure,
} from "./fallback-exec.ts";
import {
  ompNeedsManagedProfile,
  ompWorkerArgs,
  prepareOmpWorker,
  type Config,
  type OmpWorkerPreparation,
  type Provider,
} from "../agent.ts";
import { agentStateDir } from "./contract.ts";
import {
  createWorkspace,
  createPane,
  startAgent,
  promptAgent,
  readAgent,
  waitAgent,
  closePane,
  saveHerdrTaskMapping,
  type HerdrTaskMapping,
} from "./herdr.ts";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
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

export interface CollectResult {
  taskId: string;
  attempt: TaskAttempt;
  success: boolean;
  result?: unknown;
  error?: ClassifiedError;
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

function taskStatePath(taskId: string): string {
  return join(TASK_STATE_DIR, `${taskId}.json`);
}

export function saveTaskState(taskId: string, state: {
  descriptor: TaskDescriptor;
  history: TaskAttempt[];
  currentAttempt: TaskAttempt | null;
}): void {
  ensureTaskStateDir();
  writeFileSync(taskStatePath(taskId), JSON.stringify(state, null, 2));
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
  if (typeof raw["category"] !== "string" || typeof raw["observedAt"] !== "string"
      || typeof raw["reason"] !== "string" || typeof raw["exhausted"] !== "boolean") {
    throw new ContractError("schema", `${where}: error classification fields invalid`);
  }
  const quotaScopeKey = raw["quotaScopeKey"] ?? null;
  if (typeof quotaScopeKey !== "string" && quotaScopeKey !== null) {
    throw new ContractError("schema", `${where}: quotaScopeKey must be a string or null`);
  }
  return {
    category: raw["category"] as ClassifiedError["category"],
    observedAt: raw["observedAt"] as string,
    resetAt: reqNullableStr(raw, "resetAt", where),
    retryAfterMs: reqNullableNum(raw, "retryAfterMs", where),
    exhausted: raw["exhausted"] as boolean,
    reason: raw["reason"] as string,
    quotaScopeKey,
  };
}

/** Persisted FallbackCandidate: enum members are re-validated at exec time. */
function parseStoredCandidate(raw: unknown, where: string): FallbackCandidate {
  if (!isPlainObject(raw)) throw new ContractError("schema", `${where}: fallbackCandidate must be an object`);
  for (const key of ["route", "model", "billing", "credential", "scope"] as const) {
    if (typeof raw[key] !== "string") {
      throw new ContractError("schema", `${where}: fallbackCandidate.${key} must be a string`);
    }
  }
  const note = optNullableStr(raw, "note");
  const expiresAt = optNullableStr(raw, "expiresAt");
  const maxSpend = optNullableNum(raw, "maxSpend");
  return {
    route: raw["route"] as string,
    model: raw["model"] as string,
    billing: raw["billing"] as FallbackCandidate["billing"],
    credential: raw["credential"] as FallbackCandidate["credential"],
    scope: raw["scope"] as FallbackCandidate["scope"],
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
  if (typeof status !== "string" || !ATTEMPT_STATUSES.includes(status as TaskAttempt["status"])) {
    throw new ContractError("schema", `${where}: invalid attempt status`);
  }
  for (const key of ["attemptNumber", "generation"] as const) {
    const v = raw[key];
    if (typeof v !== "number" || !Number.isFinite(v)) {
      throw new ContractError("schema", `${where}: ${key} must be a finite number`);
    }
  }
  const error = raw["error"];
  const candidate = raw["fallbackCandidate"];
  return {
    id: requireStr(raw, "id", where),
    taskId: requireStr(raw, "taskId", where),
    route: parseStoredRoute(raw["route"], where),
    model: requireStr(raw, "model", where),
    attemptNumber: raw["attemptNumber"] as number,
    startedAt: requireStr(raw, "startedAt", where),
    status: status as TaskAttempt["status"],
    generation: raw["generation"] as number,
    ...(optStr(raw, "profileId") !== undefined ? { profileId: optStr(raw, "profileId")! } : {}),
    ...(optStr(raw, "herdrPaneId") !== undefined ? { herdrPaneId: optStr(raw, "herdrPaneId")! } : {}),
    ...(optStr(raw, "herdrWorkspaceId") !== undefined ? { herdrWorkspaceId: optStr(raw, "herdrWorkspaceId")! } : {}),
    ...(optStr(raw, "herdrWorkerName") !== undefined ? { herdrWorkerName: optStr(raw, "herdrWorkerName")! } : {}),
    ...(optStr(raw, "credentialScope") !== undefined ? { credentialScope: optStr(raw, "credentialScope")! } : {}),
    ...(candidate != null ? { fallbackCandidate: parseStoredCandidate(candidate, `${where}.fallbackCandidate`) } : {}),
    ...(error != null ? { error: parseStoredError(error, `${where}.error`) } : {}),
    ...(raw["result"] !== undefined ? { result: raw["result"] } : {}),
  };
}

function parseStoredDescriptor(raw: unknown, where: string): TaskDescriptor {
  if (!isPlainObject(raw)) throw new ContractError("schema", `${where}: descriptor must be an object`);
  const cls = raw["class"];
  if (cls !== undefined && (typeof cls !== "string" || !TASK_CLASSES.includes(cls as TaskClass))) {
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
  return {
    id: requireStr(raw, "id", where),
    route: requireStr(raw, "route", where),
    model: requireStr(raw, "model", where),
    prompt: requireStr(raw, "prompt", where),
    ...(profileId !== undefined ? { profileId } : {}),
    ...(cls !== undefined ? { class: cls as TaskClass } : {}),
    ...(maxAttempts !== undefined ? { maxAttempts } : {}),
    ...(acceptanceCriteria !== undefined ? { acceptanceCriteria: stringList(acceptanceCriteria, where, "acceptanceCriteria") } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
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
  const workerEnv = routeWorkerEnv(provider);
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

  // Save initial state
  saveTaskState(descriptor.id, {
    descriptor,
    history: [attempt],
    currentAttempt: attempt,
  });

  return { taskId: descriptor.id, attempt };
}

/**
 * Raw failure evidence for a prompt that did not complete, in the shape
 * `executeWithFallback` and `classifyFailure` consume. Null means the prompt
 * produced a response.
 */
function promptFailureSignal(promptResult: { blocked?: boolean; stalled?: boolean; errorCode?: string }): FailureSignal | null {
  if (promptResult.blocked) {
    return { httpStatus: 403, exitCode: 403, failureKind: "forbidden", retryAfterMs: null, resetAt: null, usage: [], errorKind: "agent-blocked" };
  }
  if (promptResult.stalled) {
    // The prompt never reached a working state: a transport/timeout failure,
    // not an authorization one. The exact cause is preserved in errorKind so
    // the classified reason stays distinguishable.
    return {
      httpStatus: 504,
      exitCode: 124,
      failureKind: "timeout",
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
  const state = loadTaskState(parent.taskId);
  if (!state) return;
  const served = record.result as { workerName?: string; paneId?: string; output?: string } | null;
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
  prompt: string
): Promise<{ success: boolean; error?: ClassifiedError; result?: unknown; workerName?: string; paneId?: string }> {
  if (!attempt.herdrWorkerName || !attempt.herdrPaneId) {
    throw new ContractError("state", "No Herdr worker name or pane in attempt");
  }

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
          const promptResult = await promptAgent(attempt.herdrWorkerName!, prompt, { wait: true, timeoutMs: 300000 });
          const signal = promptFailureSignal(promptResult);
          if (signal) return { success: false, error: signal };
          const output = await readWorkerOutput(attempt.herdrWorkerName!);
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

        const workerName = `worker-${attempt.taskId.slice(0, 8)}-${routeRef.harness}-${randomUUID().slice(0, 8)}`;
        const candidatePrepared = preparedProviders.get(routeRef.provider)
          ?? prepareOmpWorker(candidateProvider);
        preparedProviders.set(routeRef.provider, candidatePrepared);
        await verifyOmpManagedCredential(candidateProvider);
        const options = buildAgentStartOptions(candidateProvider, model, candidatePrepared);
        const candidateAttempt = await startCandidateWorker(attempt, workerName, options, {
          ...routeWorkerEnv(candidateProvider),
          OMP_SKIP_SETUP: "1",
        });

        let outcome: { success: boolean; error?: FailureSignal; result?: unknown } | undefined;
        try {
          const promptResult = await promptAgent(candidateAttempt.workerName, prompt, { wait: true, timeoutMs: 300000 });
          const signal = promptFailureSignal(promptResult);
          if (signal) {
            outcome = { success: false, error: signal };
          } else {
            // The output must be read before the pane is closed — and on
            // success the pane stays OPEN until collectTaskAttempt has read
            // the serving worker (closing it here made collect read a dead
            // pane).
            const output = await readWorkerOutput(candidateAttempt.workerName);
            outcome = {
              success: true,
              result: {
                output,
                workerName: candidateAttempt.workerName,
                paneId: candidateAttempt.paneId,
              },
            };
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
      const served = result.result as { output?: string; workerName?: string; paneId?: string };
      return {
        success: true,
        result: { output: served?.output },
        workerName: served?.workerName,
        paneId: served?.paneId,
      };
    } else {
      // No fallback profile - single route execution
      const promptResult = await promptAgent(attempt.herdrWorkerName!, prompt, { wait: true, timeoutMs: 300000 });
      const signal = promptFailureSignal(promptResult);
      if (signal) return { success: false, error: classifyFailure(signal, new Date().toISOString()) };
      const output = await readWorkerOutput(attempt.herdrWorkerName!);
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
  const state = loadTaskState(taskId);
  if (!state) return null;

  const finished: TaskAttempt = {
    ...attempt,
    status: outcome.status,
    error: outcome.error,
    result: outcome.result,
  };

  // Replace the attempt in place when it is already recorded (the dispatched
  // attempt is saved up front); otherwise append it.
  const index = state.history.findIndex(a => a.id === attempt.id);
  if (index >= 0) {
    state.history[index] = finished;
  } else {
    state.history.push(finished);
  }
  state.currentAttempt = finished;
  saveTaskState(taskId, state);

  return finished;
}

// ---------------------------------------------------------------------------
// High-level task orchestration
// ---------------------------------------------------------------------------

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
  // Dispatch the task
  const { attempt } = await dispatchTask(config, descriptor);
  
  // Wait for agent to be ready
  await waitAgent(attempt.herdrWorkerName!, 30000);
  
  // Start the attempt
  const startResult = await startTaskAttempt(config, attempt, descriptor.prompt);
  
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
  const collected = await collectTaskAttempt({ ...attempt, herdrWorkerName: serving });
  recordAttemptOutcome(descriptor.id, attempt, {
    status: collected.success ? "completed" : "failed",
    error: collected.error,
    result: collected.result,
  });
  // A fallback candidate ran on its own pane: close it only AFTER collect
  // has read the serving worker. The primary's root pane is never closed
  // here (paneId is set only for candidate workers).
  if (startResult.paneId) {
    try {
      await closePane(startResult.paneId);
    } catch {
      // Cleanup must not mask the task outcome.
    }
  }
  return collected;
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