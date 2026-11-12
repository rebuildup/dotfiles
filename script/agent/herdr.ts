#!/usr/bin/env bun
/**
 * Herdr CLI integration for agent tasks (dotfiles#100, Epic#86 T014).
 *
 * Provides thin command wrappers around Herdr CLI for workspace/pane/agent
 * lifecycle operations used by the task dispatch/collect logic.
 */

import { ContractError, agentStateDir } from "./contract.ts";
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

// ---------------------------------------------------------------------------
// Herdr CLI availability
// ---------------------------------------------------------------------------

const HERDR_CLI = "herdr";

/**
 * Check if Herdr CLI is available and get version.
 */
export async function checkHerdrAvailable(): Promise<{ available: boolean; version?: string; error?: string }> {
  try {
    const proc = await Bun.spawn([HERDR_CLI, "--version"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = await new TextDecoder().decode(await new Response(proc.stdout).arrayBuffer());
    const code = await proc.exited;
    if (code === 0) {
      return { available: true, version: stdout.trim() };
    }
    return { available: false, error: `Herdr CLI exited with code ${code}` };
  } catch (error) {
    return { available: false, error: error instanceof Error ? error.message : String(error) };
  }
}

// ---------------------------------------------------------------------------
// Workspace operations
// ---------------------------------------------------------------------------

export interface HerdrWorkspace {
  id: string;
  label: string;
  rootPath: string;
  tabs: HerdrTab[];
}

export interface HerdrTab {
  id: string;
  label: string;
  panes: HerdrPane[];
}

export interface HerdrPane {
  id: string;
  label: string;
  agentName?: string;
  agentKind?: string;
  status: "idle" | "working" | "blocked" | "done" | "unknown";
  cwd?: string;
}

/**
 * Create a new Herdr workspace for a task.
 */
export async function createWorkspace(
  cwd: string,
  label: string,
  options: { noFocus?: boolean } = {}
): Promise<HerdrWorkspace> {
  const args = ["workspace", "create", "--cwd", cwd, "--label", label];
  if (options.noFocus) args.push("--no-focus");
  args.push("--json");

  const proc = await Bun.spawn([HERDR_CLI, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    cwd,
  });
  
  const stdout = await new TextDecoder().decode(await new Response(proc.stdout).arrayBuffer());
  const stderr = await new TextDecoder().decode(await new Response(proc.stderr).arrayBuffer());
  const code = await proc.exited;
  
  if (code !== 0) {
    throw new ContractError("state", `Herdr workspace create failed: ${stderr}`);
  }
  
  try {
    return JSON.parse(stdout.trim());
  } catch (error) {
    throw new ContractError("schema", `Failed to parse Herdr workspace create output: ${error}`);
  }
}

/**
 * List existing workspaces.
 */
export async function listWorkspaces(): Promise<HerdrWorkspace[]> {
  const proc = await Bun.spawn([HERDR_CLI, "workspace", "list", "--json"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  
  const stdout = await new TextDecoder().decode(await new Response(proc.stdout).arrayBuffer());
  const code = await proc.exited;
  
  if (code !== 0) {
    return [];
  }
  
  try {
    return JSON.parse(stdout.trim());
  } catch {
    return [];
  }
}

/**
 * Get workspace by ID.
 */
export async function getWorkspace(workspaceId: string): Promise<HerdrWorkspace | null> {
  const proc = await Bun.spawn([HERDR_CLI, "workspace", "get", workspaceId, "--json"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  
  const stdout = await new TextDecoder().decode(await new Response(proc.stdout).arrayBuffer());
  const code = await proc.exited;
  
  if (code !== 0) {
    return null;
  }
  
  try {
    return JSON.parse(stdout.trim());
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Pane operations
// ---------------------------------------------------------------------------

export interface CreatePaneOptions {
  workspaceId: string;
  label?: string;
  cwd?: string;
  split?: "horizontal" | "vertical";
  targetPaneId?: string;
}

/**
 * Create a new pane in a workspace.
 */
export async function createPane(options: CreatePaneOptions): Promise<{ paneId: string; tabId: string }> {
  const args = ["pane", "create", "--workspace", options.workspaceId];
  if (options.label) args.push("--label", options.label);
  if (options.cwd) args.push("--cwd", options.cwd);
  if (options.split) args.push("--split", options.split);
  if (options.targetPaneId) args.push("--target", options.targetPaneId);
  args.push("--json");

  const proc = await Bun.spawn([HERDR_CLI, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  
  const stdout = await new TextDecoder().decode(await new Response(proc.stdout).arrayBuffer());
  const stderr = await new TextDecoder().decode(await new Response(proc.stderr).arrayBuffer());
  const code = await proc.exited;
  
  if (code !== 0) {
    throw new ContractError("state", `Herdr pane create failed: ${stderr}`);
  }
  
  try {
    return JSON.parse(stdout.trim());
  } catch (error) {
    throw new ContractError("schema", `Failed to parse Herdr pane create output: ${error}`);
  }
}

/**
 * Get pane status.
 */
export async function getPaneStatus(paneId: string): Promise<{ status: string; agentName?: string; agentKind?: string } | null> {
  const proc = await Bun.spawn([HERDR_CLI, "pane", "get", paneId, "--json"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  
  const stdout = await new TextDecoder().decode(await new Response(proc.stdout).arrayBuffer());
  const code = await proc.exited;
  
  if (code !== 0) {
    return null;
  }
  
  try {
    return JSON.parse(stdout.trim());
  } catch {
    return null;
  }
}

/**
 * Close a pane.
 */
export async function closePane(paneId: string): Promise<void> {
  const proc = await Bun.spawn([HERDR_CLI, "pane", "close", paneId], {
    stdout: "pipe",
    stderr: "pipe",
  });
  
  const code = await proc.exited;
  if (code !== 0) {
    const stderr = await new TextDecoder().decode(await new Response(proc.stderr).arrayBuffer());
    throw new ContractError("state", `Herdr pane close failed: ${stderr}`);
  }
}

// ---------------------------------------------------------------------------
// Agent operations
// ---------------------------------------------------------------------------

export type AgentKind = "claude" | "codex" | "opencode" | "omp" | "dsh" | "vibe";

export interface StartAgentOptions {
  workerName: string;
  kind: AgentKind;
  paneId: string;
  options?: string[];
}

/**
 * Start an agent in a Herdr pane.
 */
export async function startAgent(options: StartAgentOptions): Promise<{ agentName: string }> {
  const args = ["agent", "start", options.workerName, "--kind", options.kind, "--pane", options.paneId];
  if (options.options) args.push(...options.options);
  args.push("--json");

  const proc = await Bun.spawn([HERDR_CLI, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  
  const stdout = await new TextDecoder().decode(await new Response(proc.stdout).arrayBuffer());
  const stderr = await new TextDecoder().decode(await new Response(proc.stderr).arrayBuffer());
  const code = await proc.exited;
  
  if (code !== 0) {
    throw new ContractError("state", `Herdr agent start failed: ${stderr}`);
  }
  
  try {
    return JSON.parse(stdout.trim());
  } catch (error) {
    throw new ContractError("schema", `Failed to parse Herdr agent start output: ${error}`);
  }
}

/**
 * Send a prompt to an agent and optionally wait for response.
 */
export async function promptAgent(
  workerName: string,
  prompt: string,
  options: { wait?: boolean; timeoutMs?: number } = {}
): Promise<{ response?: string; blocked?: boolean; stalled?: boolean }> {
  const args = ["agent", "prompt", workerName, prompt];
  if (options.wait) args.push("--wait");
  if (options.timeoutMs) args.push("--timeout", String(options.timeoutMs));
  args.push("--json");

  const proc = await Bun.spawn([HERDR_CLI, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  
  const stdout = await new TextDecoder().decode(await new Response(proc.stdout).arrayBuffer());
  const stderr = await new TextDecoder().decode(await new Response(proc.stderr).arrayBuffer());
  const code = await proc.exited;
  
  if (code !== 0) {
    // Non-zero exit may indicate blocked/timeout, not necessarily error
    try {
      return JSON.parse(stdout.trim());
    } catch {
      return { blocked: true, response: stderr || "Agent prompt failed" };
    }
  }
  
  try {
    return JSON.parse(stdout.trim());
  } catch {
    return { response: stdout.trim() };
  }
}

/**
 * Read agent output.
 */
export async function readAgent(
  workerName: string,
  options: { source?: "recent" | "recent-unwrapped" | "all"; lines?: number } = {}
): Promise<{ output: string; source: string }> {
  const args = ["agent", "read", workerName];
  if (options.source) args.push("--source", options.source);
  if (options.lines) args.push("--lines", String(options.lines));
  args.push("--json");

  const proc = await Bun.spawn([HERDR_CLI, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  
  const stdout = await new TextDecoder().decode(await new Response(proc.stdout).arrayBuffer());
  const code = await proc.exited;
  
  if (code !== 0) {
    return { output: "", source: options.source || "recent" };
  }
  
  try {
    return JSON.parse(stdout.trim());
  } catch {
    return { output: stdout.trim(), source: options.source || "recent" };
  }
}

/**
 * Wait for agent to reach a ready state.
 */
export async function waitAgent(
  workerName: string,
  timeoutMs: number = 120000
): Promise<{ completed: boolean; reason?: string }> {
  const args = ["agent", "wait", workerName, "--timeout", String(timeoutMs), "--json"];
  
  const proc = await Bun.spawn([HERDR_CLI, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  
  const stdout = await new TextDecoder().decode(await new Response(proc.stdout).arrayBuffer());
  const code = await proc.exited;
  
  if (code !== 0) {
    return { completed: false, reason: "timeout or error" };
  }
  
  try {
    return JSON.parse(stdout.trim());
  } catch {
    return { completed: false, reason: "parse error" };
  }
}

/**
 * Attach to an agent (interactive).
 */
export async function attachAgent(workerName: string): Promise<void> {
  const proc = await Bun.spawn([HERDR_CLI, "agent", "attach", workerName], {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  
  await proc.exited;
}

/**
 * List all agents.
 */
export async function listAgents(): Promise<Array<{ name: string; kind: string; paneId: string; status: string }>> {
  const proc = await Bun.spawn([HERDR_CLI, "agent", "list", "--json"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  
  const stdout = await new TextDecoder().decode(await new Response(proc.stdout).arrayBuffer());
  const code = await proc.exited;
  
  if (code !== 0) {
    return [];
  }
  
  try {
    return JSON.parse(stdout.trim());
  } catch {
    return [];
  }
}

/**
 * Get agent details.
 */
export async function getAgent(workerName: string): Promise<{
  name: string;
  kind: string;
  paneId: string;
  status: string;
  workspaceId?: string;
  cwd?: string;
} | null> {
  const proc = await Bun.spawn([HERDR_CLI, "agent", "get", workerName, "--json"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  
  const stdout = await new TextDecoder().decode(await new Response(proc.stdout).arrayBuffer());
  const code = await proc.exited;
  
  if (code !== 0) {
    return null;
  }
  
  try {
    return JSON.parse(stdout.trim());
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Local state cache for task-Herdr mapping
// ---------------------------------------------------------------------------

const HERDR_TASK_STATE_DIR = join(agentStateDir(), "herdr-tasks");

function ensureHerdrTaskStateDir(): void {
  if (!existsSync(HERDR_TASK_STATE_DIR)) {
    mkdirSync(HERDR_TASK_STATE_DIR, { recursive: true });
  }
}

function herdrTaskStatePath(taskId: string): string {
  return join(HERDR_TASK_STATE_DIR, `${taskId}.json`);
}

export interface HerdrTaskMapping {
  taskId: string;
  workspaceId: string;
  paneId: string;
  workerName: string;
  createdAt: string;
  route: string;
  model: string;
}

export function saveHerdrTaskMapping(mapping: HerdrTaskMapping): void {
  ensureHerdrTaskStateDir();
  writeFileSync(herdrTaskStatePath(mapping.taskId), JSON.stringify(mapping, null, 2));
}

export function loadHerdrTaskMapping(taskId: string): HerdrTaskMapping | null {
  const path = herdrTaskStatePath(taskId);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
}

export function deleteHerdrTaskMapping(taskId: string): void {
  const path = herdrTaskStatePath(taskId);
  if (existsSync(path)) {
    // Don't actually delete - keep for audit trail
    // Could move to archive instead
  }
}
