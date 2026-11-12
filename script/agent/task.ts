#!/usr/bin/env bun
/**
 * Herdr dispatch / observe / collect for agent tasks (dotfiles#100, Epic#86 T014).
 *
 * Thin adapter that connects the agent launcher to Herdr for task dispatch,
 * observation, and result collection. Does NOT implement cross-harness migration
 * or autonomous fallback — those belong to #101 and #139.
 */

import { ContractError, parseRouteId, formatRouteId, type RouteRef } from "./contract.ts";
import { loadConfig, type Config, type Route } from "../agent.ts";
import { executeWithFallback, type FallbackCandidate, type FallbackExecutionState } from "./fallback-exec.ts";
import { type ClassifiedError, classifyFailure } from "./fallback-exec.ts";
import { agentStateDir } from "./contract.ts";
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TaskClass = "simple" | "cross-boundary" | "capacity-constrained";

export interface TaskDescriptor {
  id: string;
  class: TaskClass;
  route: string;           // primary route (e.g., "omp.mistral")
  model: string;
  profileId?: string;      // opt-in fallback profile ID
  prompt: string;
  acceptanceCriteria: string[];
  dependencies: string[];  // Issue numbers this task depends on
  metadata: Record<string, unknown>;
}

export interface TaskAttempt {
  id: string;                    // UUID
  taskId: string;
  route: RouteRef;
  model: string;
  profileId?: string;
  attemptNumber: number;
  fallbackCandidate?: FallbackCandidate;
  startedAt: string;
  endedAt?: string;
  status: "running" | "completed" | "failed" | "fenced" | "fallback" | "blocked";
  result?: any;
  error?: ClassifiedError;
  herdrPaneId?: string;
  herdrWorkspaceId?: string;
  checkpointRef?: string;
  generation: number;
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
  result?: any;
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
    const { parseFallbackProfile } = await import("./fallback.ts");
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

  // Create Herdr pane for the task
  const { paneId, workspaceId } = await createHerdrPaneForTask(descriptor.id, descriptor.route);

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
 * Create a Herdr pane for the task. Returns pane ID and workspace ID.
 */
async function createHerdrPaneForTask(taskId: string, route: string): Promise<{ paneId: string; workspaceId: string }> {
  // In a real implementation, this would call Herdr CLI to create a workspace/pane
  // For now, we generate deterministic IDs based on the task
  const workspaceId = `ws-${route.replace(".", "-")}-${taskId.slice(0, 8)}`;
  const paneId = `pane-${taskId.slice(0, 8)}`;
  
  // TODO: Actually call `herdr workspace create` and `herdr pane split` here
  // For now, we simulate the IDs
  
  return { paneId, workspaceId };
}

/**
 * Start the actual agent process in the Herdr pane.
 * This is called after dispatch to actually launch the harness.
 */
export async function startTaskAttempt(
  config: Config,
  attempt: TaskAttempt,
  prompt: string
): Promise<{ success: boolean; error?: ClassifiedError; result?: any }> {
  // Build the agent command for the route
  const route = config.routes[`${attempt.route.harness}.${attempt.route.provider}`];
  if (!route) {
    throw new ContractError("state", `Route not found for attempt`);
  }

  // In a real implementation, this would use `herdr agent prompt` to send the prompt
  // and `herdr agent wait` to wait for completion
  // For now, we simulate by calling the fallback execution logic
  
  try {
    // Use the fallback execution logic if a profile is available
    if (attempt.profileId) {
      const result = await executeWithFallback(config, attempt.profileId, async (routeRef, model, candidate) => {
        // In a real implementation, this would launch the actual harness via Herdr
        // and return the result
        return { success: true, result: { message: "Simulated execution" } };
      });
      return { success: true, result: result.result };
    } else {
      // No fallback profile - single route execution
      // In a real implementation, this would launch via Herdr
      return { success: true, result: { message: "Simulated single-route execution" } };
    }
  } catch (error) {
    const signal: any = { message: error instanceof Error ? error.message : String(error) };
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
  // In a real implementation, this would call `herdr agent read` or `herdr agent wait`
  // For now, we simulate
  return { status: "running", output: "Simulated output" };
}

/**
 * Collect the result of a completed task attempt.
 */
export async function collectTaskAttempt(
  attempt: TaskAttempt,
  timeoutMs: number = 300000
): Promise<CollectResult> {
  // In a real implementation, this would:
  // 1. Wait for the attempt to complete (herdr agent wait)
  // 2. Read the output (herdr agent read)
  // 3. Validate the result against acceptance criteria
  // 4. Return the collected result
  
  // For now, simulate
  await new Promise(resolve => setTimeout(resolve, 100));
  
  return {
    taskId: attempt.taskId,
    attempt,
    success: true,
    result: { message: "Simulated collection" },
  };
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
  const history = state.history;
  const attemptNumber = failedAttempt.attemptNumber + 1;
  if (attemptNumber > 5) return null; // Max 5 attempts total

  // Check circuit breaker
  const recentFailures = history.filter(a => a.status === "failed").slice(-3);
  if (recentFailures.length >= 3) {
    return null; // Circuit breaker open
  }

  // Try next fallback candidate via executeWithFallback logic
  // For now, we just create a new attempt with incremented number
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
  history.push(nextAttempt);
  saveTaskState(taskId, {
    descriptor: state.descriptor,
    history,
    currentAttempt: nextAttempt,
  });

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
