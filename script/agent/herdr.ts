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
// Safe spawn helper: returns null when herdr is unavailable
// ---------------------------------------------------------------------------

interface HerdrSpawnResult {
  stdout: string;
  stderr: string;
  code: number;
}

async function herdrSpawn(args: string[], cwd?: string): Promise<HerdrSpawnResult | null> {
  try {
    const proc = await Bun.spawn([HERDR_CLI, ...args], {
      stdout: "pipe",
      stderr: "pipe",
      cwd,
    });
    const stdout = await new TextDecoder().decode(await new Response(proc.stdout).arrayBuffer());
    const stderr = await new TextDecoder().decode(await new Response(proc.stderr).arrayBuffer());
    const code = await proc.exited;
    return { stdout, stderr, code };
  } catch (error) {
    // "Executable not found in $PATH" — herdr not installed
    return null;
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
  options: { noFocus?: boolean; env?: Record<string, string> } = {}
): Promise<HerdrWorkspace> {
  const args = ["workspace", "create", "--cwd", cwd, "--label", label];
  if (options.noFocus) args.push("--no-focus");
  // The pane's process inherits the Herdr server's environment, not the
  // caller's, so a route credential has to be passed explicitly.
  for (const [name, value] of Object.entries(options.env ?? {})) {
    args.push("--env", `${name}=${value}`);
  }
  
  const result = await herdrSpawn(args, cwd);
  if (result === null) {
    throw new ContractError("state", "Herdr CLI not available");
  }
  if (result.code !== 0) {
    throw new ContractError("state", `Herdr workspace create failed: ${result.stderr}`);
  }
  try {
    const parsed = JSON.parse(result.stdout.trim());
    const workspace = parsed?.result?.workspace;
    const rootPane = parsed?.result?.root_pane;
    const tab = parsed?.result?.tab;
    
    const panes: HerdrPane[] = rootPane ? [{
      id: rootPane.pane_id,
      label: "root",
      agentName: undefined,
      agentKind: undefined,
      status: rootPane.agent_status as "idle" | "working" | "blocked" | "done" | "unknown",
      cwd: rootPane.cwd,
    }] : [];
    
    const tabs: HerdrTab[] = tab ? [{
      id: tab.tab_id,
      label: tab.label || "1",
      panes,
    }] : [];
    
    return {
      id: workspace?.workspace_id || "",
      label: workspace?.label || label,
      rootPath: cwd,
      tabs,
    };
  } catch (error) {
    throw new ContractError("schema", `Failed to parse Herdr workspace create output: ${error}`);
  }
}

/**
 * List existing workspaces.
 */
export async function listWorkspaces(): Promise<HerdrWorkspace[]> {
  const result = await herdrSpawn(["workspace", "list"]);
  if (result === null || result.code !== 0) return [];
  try {
    const parsed = JSON.parse(result.stdout.trim());
    return parsed?.result?.workspaces ?? [];
  } catch {
    return [];
  }
}

/**
 * Get workspace by ID with full tabs and panes.
 */
export async function getWorkspace(workspaceId: string): Promise<HerdrWorkspace | null> {
  const result = await herdrSpawn(["workspace", "get", workspaceId]);
  if (result === null || result.code !== 0) return null;
  try {
    const parsed = JSON.parse(result.stdout.trim());
    const workspace = parsed?.result?.workspace;
    if (!workspace) return null;
    
    // Fetch panes for this workspace
    const paneResult = await herdrSpawn(["pane", "list", "--workspace", workspaceId]);
    let panes: HerdrPane[] = [];
    if (paneResult && paneResult.code === 0) {
      const paneParsed = JSON.parse(paneResult.stdout.trim());
      // Map pane_id to id for our interface
      panes = (paneParsed?.result?.panes ?? []).map((p: any) => ({
        id: p.pane_id,
        label: "pane",
        agentName: undefined,
        agentKind: undefined,
        status: p.agent_status as "idle" | "working" | "blocked" | "done" | "unknown",
        cwd: p.cwd,
      }));
    }
    
    // Build tabs structure
    const tabs: HerdrTab[] = [{
      id: workspace.active_tab_id || "",
      label: "1",
      panes,
    }];
    return {
      id: workspace.workspace_id,
      label: workspace.label,
      rootPath: "",
      tabs,
    };
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
  /** Environment for the pane's process (e.g. the route credential). */
  env?: Record<string, string>;
}

/**
 * Create a new pane in a workspace.
 *
 * `herdr pane split` answers with a pane_info object
 * (`{pane: {pane_id, tab_id, ...}}`), so the ids are read from there and
 * validated: a missing id would otherwise surface later as an unrelated
 * "no worker name" failure.
 */
export async function createPane(options: CreatePaneOptions): Promise<{ paneId: string; tabId: string }> {
  // First get the root pane of the workspace to split from
  const workspace = await getWorkspace(options.workspaceId);
  if (!workspace || !workspace.tabs.length || !workspace.tabs[0].panes.length) {
    throw new ContractError("state", `Workspace ${options.workspaceId} has no root pane to split`);
  }
  const rootPaneId = options.targetPaneId ?? workspace.tabs[0].panes[0].id;
  
  const args = ["pane", "split", "--pane", rootPaneId, "--direction", options.split || "right"];
  if (options.label) args.push("--label", options.label);
  if (options.cwd) args.push("--cwd", options.cwd);
  // The pane's process inherits the Herdr server's environment, so a route
  // credential has to be passed explicitly.
  for (const [name, value] of Object.entries(options.env ?? {})) {
    args.push("--env", `${name}=${value}`);
  }
  
  const result = await herdrSpawn(args);
  if (result === null) {
    throw new ContractError("state", "Herdr CLI not available");
  }
  if (result.code !== 0) {
    throw new ContractError("state", `Herdr pane split failed: ${result.stderr}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout.trim());
  } catch (error) {
    throw new ContractError("schema", `Failed to parse Herdr pane split output: ${error}`);
  }
  // The CLI answers with an envelope: `{id, result: {pane: {...}}}`. Read the
  // pane info from either the envelope or a bare object, and validate the id:
  // a missing id would otherwise surface later as an unrelated "no worker
  // name" failure.
  const envelope = parsed as { result?: { pane?: unknown }; pane?: unknown } | null;
  const raw = (envelope?.result?.pane ?? envelope?.pane) as
    | { pane_id?: unknown; tab_id?: unknown }
    | undefined;
  const paneId = raw?.pane_id;
  const tabId = raw?.tab_id;
  if (typeof paneId !== "string" || !paneId) {
    throw new ContractError("schema", "Herdr pane split output has no pane id");
  }
  return { paneId, tabId: typeof tabId === "string" ? tabId : "" };
}

/**
 * Get pane status.
 */
export async function getPaneStatus(paneId: string): Promise<{ status: string; agentName?: string; agentKind?: string } | null> {
  const result = await herdrSpawn(["pane", "get", paneId]);
  if (result === null || result.code !== 0) return null;
  try {
    const parsed = JSON.parse(result.stdout.trim());
    return parsed?.result ?? null;
  } catch {
    return null;
  }
}

/**
 * Close a pane.
 */
export async function closePane(paneId: string): Promise<void> {
  const result = await herdrSpawn(["pane", "close", paneId]);
  if (result === null) return; // herdr not available
  if (result.code !== 0) {
    throw new ContractError("state", `Herdr pane close failed: ${result.stderr}`);
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
  
  const result = await herdrSpawn(args);
  if (result === null) {
    throw new ContractError("state", "Herdr CLI not available");
  }
  if (result.code !== 0) {
    throw new ContractError("state", `Herdr agent start failed: ${result.stderr}`);
  }
  try {
    const parsed = JSON.parse(result.stdout.trim());
    // Herdr returns agent info in .agent.name, not .result.agentName
    const agentName = parsed?.agent?.name ?? parsed?.result?.agentName ?? options.workerName;
    return { agentName };
  } catch (error) {
    throw new ContractError("schema", `Failed to parse Herdr agent start output: ${error}`);
  }
}

/**
 * Send a prompt to an agent and optionally wait for response.
 *
 * The failure modes are distinguished, because they classify differently: an
 * agent that refuses the prompt is an authorization failure, while a prompt
 * that never reached a working/blocked state is a transport/timeout failure.
 * Collapsing both into "blocked" misclassifies a stall as an auth failure.
 */
export async function promptAgent(
  workerName: string,
  prompt: string,
  options: { wait?: boolean; timeoutMs?: number } = {}
): Promise<{ response?: string; blocked?: boolean; stalled?: boolean; errorCode?: string }> {
  const args = ["agent", "prompt", workerName, prompt];
  if (options.wait) args.push("--wait");
  if (options.timeoutMs) args.push("--timeout", String(options.timeoutMs));
  
  const result = await herdrSpawn(args);
  if (result === null) {
    return { stalled: true, response: "Herdr CLI not available" };
  }
  if (result.code !== 0) {
    // The CLI reports a structured error: {"error":{"code":"...","message":"..."}}.
    let errorCode: string | undefined;
    let message = result.stderr || "Agent prompt failed";
    try {
      const parsed = JSON.parse(result.stdout.trim()) as {
        error?: { code?: unknown; message?: unknown };
      };
      if (typeof parsed.error?.code === "string") errorCode = parsed.error.code;
      if (typeof parsed.error?.message === "string" && parsed.error.message) {
        message = parsed.error.message;
      }
    } catch {
      // Not a JSON envelope: keep the stderr text.
    }
    // A prompt rejected because the agent is blocked is an authorization
    // refusal; a stalled prompt never reached a working state.
    const blocked = errorCode === "agent_blocked";
    const stalled = !blocked;
    return { blocked, stalled, errorCode, response: message };
  }
  try {
    const parsed = JSON.parse(result.stdout.trim());
    // On success the CLI answers with the agent state, not the answer: the
    // agent's text lives in its terminal output (readAgent).
    return parsed?.result ?? { response: result.stdout.trim() };
  } catch {
    return { response: result.stdout.trim() };
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
  
  const result = await herdrSpawn(args);
  if (result === null || result.code !== 0) {
    return { output: "", source: options.source || "recent" };
  }
  try {
    const parsed = JSON.parse(result.stdout.trim());
    return parsed?.result ?? { output: "", source: options.source || "recent" };
  } catch {
    return { output: result.stdout.trim(), source: options.source || "recent" };
  }
}

/**
 * Wait for agent to reach a ready state.
 */
export async function waitAgent(
  workerName: string,
  timeoutMs: number = 120000
): Promise<{ completed: boolean; reason?: string }> {
  const args = ["agent", "wait", workerName, "--timeout", String(timeoutMs)];
  
  const result = await herdrSpawn(args);
  if (result === null || result.code !== 0) {
    return { completed: false, reason: "timeout or error" };
  }
  try {
    const parsed = JSON.parse(result.stdout.trim());
    const r = parsed?.result;
    if (r && typeof r.completed === "boolean") return r;
    return { completed: r?.status === "done" || r?.status === "idle", reason: r?.status };
  } catch {
    return { completed: false, reason: "parse error" };
  }
}

/**
 * Attach to an agent (interactive).
 */
export async function attachAgent(workerName: string): Promise<void> {
  try {
    const proc = await Bun.spawn([HERDR_CLI, "agent", "attach", workerName], {
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });
    await proc.exited;
  } catch {
    // herdr not available
  }
}

/**
 * List all agents.
 */
export async function listAgents(): Promise<Array<{ name: string; kind: string; paneId: string; status: string }>> {
  const result = await herdrSpawn(["agent", "list"]);
  if (result === null || result.code !== 0) return [];
  try {
    const parsed: unknown = JSON.parse(result.stdout.trim());
    if (!parsed || typeof parsed !== "object") return [];
    const obj = parsed as { result?: { agents?: unknown } };
    const agents = obj.result?.agents;
    if (!Array.isArray(agents)) return [];
    return agents.map((raw: unknown) => {
      if (!raw || typeof raw !== "object") return { name: "", kind: "", paneId: "", status: "unknown" };
      const a = raw as Record<string, unknown>;
      return {
        name: typeof a.name === "string" ? a.name : typeof a.agent === "string" ? a.agent : "",
        kind: typeof a.agent === "string" ? a.agent : "",
        paneId: typeof a.pane_id === "string" ? a.pane_id : "",
        status: typeof a.agent_status === "string" ? a.agent_status : typeof a.status === "string" ? a.status : "unknown",
      };
    });
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
  const result = await herdrSpawn(["agent", "get", workerName]);
  if (result === null || result.code !== 0) return null;
  try {
    const parsed = JSON.parse(result.stdout.trim());
    return parsed?.result ?? null;
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
