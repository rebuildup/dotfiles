#!/usr/bin/env bun
/**
 * Herdr dispatch / observe / collect for agent tasks (dotfiles#100, Epic#86 T014).
 *
 * Real Herdr integration replaces the previous simulation paths.
 * Task state is persisted to ~/.local/share/agent/tasks/<taskId>.json.
 */

import { ContractError, parseRouteId, formatRouteId, type RouteRef } from "./contract.ts";
import {
  FallbackProfile,
  FallbackCandidate,
  FallbackResolution,
  ResolvedCandidate,
  RejectedCandidate,
  FallbackRejectionReason,
  parseFallbackProfile,
  resolveFallbackProfile,
  buildFallbackCatalog,
  mergeAttestations,
  seedAttestationsFromCatalog,
} from "./fallback.ts";
import {
  executeWithFallback,
  type ClassifiedError,
  type FailureSignal,
  classifyFailure,
  type LimitCategory,
} from "./fallback-exec.ts";
import { loadConfig, type Config, type Route, type Provider, type Harness } from "../agent.ts";
import { effectiveQuotaKey, loadCatalog, type Catalog } from "./catalog.ts";
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

export function loadTaskState(taskId: string): {
  descriptor: TaskDescriptor;
  history: TaskAttempt[];
  currentAttempt: TaskAttempt | null;
} | null {
  const path = taskStatePath(taskId);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
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
  const allowedModels = route.models ?? provider.models ?? [];
  if (!allowedModels.includes(descriptor.model)) {
    throw new ContractError("identity", `Model not allowed for route ${descriptor.route}: ${descriptor.model}`);
  }

  // Resolve fallback profile if specified
  let profileId = descriptor.profileId;
  if (profileId) {
    const tomlText = readFileSync(config.path, "utf-8");
    const parsedToml = Bun.TOML.parse(tomlText) as Record<string, unknown>;
    const profile = parseFallbackProfile(parsedToml, profileId);
    if (!profile) {
      throw new ContractError("identity", `Fallback profile not found: ${profileId}`);
    }
    // Verify primary route matches
    if (profile.primaryRoute !== descriptor.route) {
      throw new ContractError("identity", `Profile primary route (${profile.primaryRoute}) does not match task route (${descriptor.route})`);
    }
  }

  // Create Herdr workspace for the task
  const workspace = await createWorkspace(process.cwd(), `task-${descriptor.id.slice(0, 8)}`, { noFocus: true });
  const workspaceId = workspace.id;

  // Get the root pane (first pane of first tab) to start the agent
  const rootPaneId = workspace.tabs[0].panes[0].id;
  
  // Wait for the pane to be ready (shell prompt available)
  await new Promise(r => setTimeout(r, 2000));
  
  // Start the agent in the root pane
  const harness = config.harnesses[route.harness];
  const agentKind = harness.adapter === "omp" ? "omp" :
                    harness.adapter === "anthropic" ? "claude" :
                    harness.adapter === "opencode" ? "opencode" :
                    harness.adapter === "passthrough" ? "dsh" : "omp";
  
  const workerName = `worker-${descriptor.id.slice(0, 8)}-${route.harness}-${randomUUID().slice(0, 8)}`;
  const startResult = await startAgent({ workerName, kind: agentKind, paneId: rootPaneId });

  // Split pane for output (right side)
  const pane = await createPane({ workspaceId, cwd: process.cwd(), split: "right", noFocus: true });
  const paneId = pane.pane.pane_id;

  // Map the agent to the task
  const mapping: HerdrTaskMapping = {
    taskId: descriptor.id,
    workspaceId,
    paneId,
    workerName: startResult.agentName,
    createdAt: new Date().toISOString(),
    route: descriptor.route,
    model: descriptor.model,
  };
  saveHerdrTaskMapping(mapping);

  const attemptId = randomUUID();
  const routeRef = parseRouteId(descriptor.route);

  const attempt: TaskAttempt = {
    id: attemptId,
    taskId: descriptor.id,
    route: routeRef,
    model: descriptor.model,
    profileId,
    attemptNumber: 1,
    startedAt: new Date().toISOString(),
    status: "running",
    herdrPaneId: paneId,
    herdrWorkspaceId: workspaceId,
    herdrWorkerName: startResult.agentName,
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
 * Start the actual agent process in the Herdr pane.
 * This is called after dispatch to actually launch the harness.
 */
export async function startTaskAttempt(
  config: Config,
  attempt: TaskAttempt,
  prompt: string
): Promise<{ success: boolean; error?: ClassifiedError; result?: unknown }> {
  if (!attempt.herdrWorkerName) {
    throw new ContractError("state", "No Herdr worker name in attempt");
  }

  try {
    // Use the fallback execution logic if a profile is available
    if (attempt.profileId) {
      const result = await executeWithFallback(config, attempt.profileId, async (routeRef, model, candidate) => {
        // Build the agent command for the route
        const routeKey = formatRouteId(routeRef);
        const route = config.routes[routeKey];
        if (!route) {
          throw new ContractError("state", `Route not found for fallback candidate: ${routeKey}`);
        }

        // Send the prompt with the resolved model via Herdr
        // Note: the model is pinned by the launcher's environment setup
        const promptResult = await promptAgent(attempt.herdrWorkerName!, prompt, { wait: true, timeoutMs: 300000 });
        
        if (promptResult.blocked) {
          return { success: false, error: { category: "unknown", observedAt: new Date().toISOString(), resetAt: null, retryAfterMs: null, exhausted: false, reason: promptResult.response || "Agent blocked", quotaScopeKey: null } };
        }
        if (promptResult.stalled) {
          return { success: false, error: { category: "network", observedAt: new Date().toISOString(), resetAt: null, retryAfterMs: 30000, exhausted: false, reason: "Agent prompt stalled", quotaScopeKey: null } };
        }

        return { success: true, result: promptResult.response };
      });
      return { success: true, result: result.result };
    } else {
      // No fallback profile - single route execution
      const promptResult = await promptAgent(attempt.herdrWorkerName!, prompt, { wait: true, timeoutMs: 300000 });
      
      if (promptResult.blocked) {
        return { success: false, error: { category: "unknown", observedAt: new Date().toISOString(), resetAt: null, retryAfterMs: null, exhausted: false, reason: promptResult.response || "Agent blocked", quotaScopeKey: null } };
      }
      if (promptResult.stalled) {
        return { success: false, error: { category: "network", observedAt: new Date().toISOString(), resetAt: null, retryAfterMs: 30000, exhausted: false, reason: "Agent prompt stalled", quotaScopeKey: null } };
      }

      return { success: true, result: promptResult.response };
    }
  } catch (error) {
    const signal: { message: string } = { message: error instanceof Error ? error.message : String(error) };
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
    const signal: { message: string } = { message: error instanceof Error ? error.message : String(error) };
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
 * Handle fallback for a failed attempt.
 * Returns the next attempt if fallback is possible, null if exhausted.
 */
export async function handleFallback(
  config: Config,
  taskId: string,
  failedAttempt: TaskAttempt,
  error: ClassifiedError
): Promise<TaskAttempt | null> {
  const state = loadTaskState(taskId);
  if (!state) return null;

  // Check if we have a fallback profile
  if (!failedAttempt.profileId) return null;

  // Check if we've exhausted retries
  const maxAttempts = state.descriptor.maxAttempts ?? 5;
  const attemptNumber = failedAttempt.attemptNumber + 1;
  if (attemptNumber > maxAttempts) return null;

  // Check circuit breaker
  const recentFailures = state.history.filter(a => a.status === "failed").slice(-3);
  if (recentFailures.length >= 3) {
    return null; // Circuit breaker open
  }

  // Try next fallback candidate via executeWithFallback logic
  // For now, we just create a new attempt with incremented number
  // The actual candidate switching happens inside executeWithFallback
  const nextAttempt: TaskAttempt = {
    ...failedAttempt,
    id: randomUUID(),
    attemptNumber,
    startedAt: new Date().toISOString(),
    status: "fallback",
    fallbackCandidate: undefined, // Would be resolved from executeWithFallback
    generation: failedAttempt.generation + 1,
  };

  // Update state
  state.history.push(nextAttempt);
  state.currentAttempt = nextAttempt;
  saveTaskState(taskId, state);

  return nextAttempt;
}

// ---------------------------------------------------------------------------
// High-level task orchestration
// ---------------------------------------------------------------------------

/**
 * Run a task to completion with automatic fallback handling.
 */
export async function runTaskToCompletion(
  config: Config,
  descriptor: TaskDescriptor
): Promise<CollectResult> {
  // Dispatch the task
  const { attempt } = await dispatchTask(config, descriptor);
  
  // Start the attempt
  const startResult = await startTaskAttempt(config, attempt, descriptor.prompt);
  
  if (startResult.success) {
    // Collect the result
    return await collectTaskAttempt(attempt);
  } else {
    // Handle fallback
    const nextAttempt = await handleFallback(config, descriptor.id, attempt, startResult.error!);
    if (!nextAttempt) {
      // No fallback available - collect the failure
      return {
        taskId: descriptor.id,
        attempt,
        success: false,
        error: startResult.error,
      };
    }
    
    // Recursively try the next attempt
    return await runTaskToCompletion(config, {
      ...descriptor,
      // The next attempt will use the fallback candidate from the profile
    });
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