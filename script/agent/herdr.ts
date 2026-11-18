#!/usr/bin/env bun
/**
 * Herdr CLI integration for agent tasks (dotfiles#100, Epic#86 T014).
 *
 * Provides thin command wrappers around Herdr CLI for workspace/pane/agent
 * lifecycle operations used by the task dispatch/collect logic.
 */

import { ContractError, agentStateDir, isPlainObject } from "./contract.ts";
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
// CLI JSON boundary helpers: every `herdr ... --json`-style reply is parsed
// into `unknown` and validated field-by-field before use.
// ---------------------------------------------------------------------------

const PANE_STATUSES = ["idle", "working", "blocked", "done", "unknown"] as const;

function herdrPaneStatus(value: unknown): HerdrPane["status"] {
  return typeof value === "string" && (PANE_STATUSES as readonly string[]).includes(value)
    ? (value as HerdrPane["status"])
    : "unknown";
}

function herdrStr(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** The envelope's `result` member when it is an object, else null. */
function herdrResultOf(parsed: unknown): Record<string, unknown> | null {
  if (!isPlainObject(parsed)) return null;
  const result = parsed["result"];
  return isPlainObject(result) ? result : null;
}

function parseHerdrJson(text: string, what: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new ContractError("schema", `Failed to parse Herdr ${what} output: ${error}`);
  }
}

function parseHerdrJsonOrNull(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Validate one `pane list` entry shape shared by getWorkspace callers. */
function herdrPaneFromListEntry(raw: unknown): HerdrPane {
  if (!isPlainObject(raw) || typeof raw["pane_id"] !== "string" || raw["pane_id"] === "") {
    throw new ContractError("schema", "Herdr pane list: pane entry has no pane_id");
  }
  return {
    id: raw["pane_id"],
    label: "pane",
    status: herdrPaneStatus(raw["agent_status"]),
    cwd: herdrStr(raw["cwd"]),
  };
}

function herdrPanesFromList(parsed: unknown): HerdrPane[] {
  const env = herdrResultOf(parsed);
  const rawPanes = env?.["panes"];
  if (rawPanes === undefined || rawPanes === null) return [];
  if (!Array.isArray(rawPanes)) {
    throw new ContractError("schema", "Herdr pane list: 'panes' must be an array");
  }
  return rawPanes.map(herdrPaneFromListEntry);
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
  const parsed = parseHerdrJson(result.stdout.trim(), "workspace create");
  const env = herdrResultOf(parsed);
  const workspace = env?.["workspace"];
  const rootPane = env?.["root_pane"];
  const tab = env?.["tab"];

  const panes: HerdrPane[] =
    isPlainObject(rootPane) && typeof rootPane["pane_id"] === "string" && rootPane["pane_id"] !== ""
      ? [{
          id: rootPane["pane_id"],
          label: "root",
          status: herdrPaneStatus(rootPane["agent_status"]),
          cwd: herdrStr(rootPane["cwd"]),
        }]
      : [];

  const tabs: HerdrTab[] =
    isPlainObject(tab) && typeof tab["tab_id"] === "string" && tab["tab_id"] !== ""
      ? [{ id: tab["tab_id"], label: herdrStr(tab["label"]) ?? "1", panes }]
      : [];

  return {
    id: isPlainObject(workspace) ? herdrStr(workspace["workspace_id"]) ?? "" : "",
    label: isPlainObject(workspace) ? herdrStr(workspace["label"]) ?? label : label,
    rootPath: cwd,
    tabs,
  };
}

/**
 * List existing workspaces.
 */
export async function listWorkspaces(): Promise<HerdrWorkspace[]> {
  const result = await herdrSpawn(["workspace", "list"]);
  if (result === null || result.code !== 0) return [];
  const parsed = parseHerdrJsonOrNull(result.stdout.trim());
  const env = herdrResultOf(parsed);
  const raw = env?.["workspaces"];
  if (!Array.isArray(raw)) return [];
  const out: HerdrWorkspace[] = [];
  for (const entry of raw) {
    if (!isPlainObject(entry)) continue;
    const id = herdrStr(entry["workspace_id"]) ?? herdrStr(entry["id"]);
    if (!id) continue;
    out.push({
      id,
      label: herdrStr(entry["label"]) ?? "",
      rootPath: herdrStr(entry["root_path"]) ?? herdrStr(entry["cwd"]) ?? "",
      tabs: [],
    });
  }
  return out;
}

/**
 * Get workspace by ID with full tabs and panes.
 */
export async function getWorkspace(workspaceId: string): Promise<HerdrWorkspace | null> {
  const result = await herdrSpawn(["workspace", "get", workspaceId]);
  if (result === null || result.code !== 0) return null;
  const parsed = parseHerdrJsonOrNull(result.stdout.trim());
  const workspace = herdrResultOf(parsed)?.["workspace"];
  if (!isPlainObject(workspace)) return null;
  const id = herdrStr(workspace["workspace_id"]) ?? herdrStr(workspace["id"]);
  if (!id) return null;

  // Fetch panes for this workspace
  let panes: HerdrPane[] = [];
  const paneResult = await herdrSpawn(["pane", "list", "--workspace", workspaceId]);
  if (paneResult && paneResult.code === 0) {
    try {
      panes = herdrPanesFromList(parseHerdrJsonOrNull(paneResult.stdout.trim()));
    } catch {
      panes = [];
    }
  }

  // Build tabs structure
  const tabs: HerdrTab[] = [{
    id: herdrStr(workspace["active_tab_id"]) ?? "",
    label: "1",
    panes,
  }];
  return {
    id,
    label: herdrStr(workspace["label"]) ?? "",
    rootPath: "",
    tabs,
  };
}

// ---------------------------------------------------------------------------
// Pane operations
// ---------------------------------------------------------------------------

export interface CreatePaneOptions {
  workspaceId: string;
  label?: string;
  cwd?: string;
  /** `herdr pane split --direction` accepts exactly these values. */
  split?: "right" | "down";
  targetPaneId?: string;
  /** Environment for the pane's process (e.g. the route credential). */
  env?: Record<string, string>;
  /** Pass `--no-focus` so the new pane does not steal focus. */
  noFocus?: boolean;
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
  if (options.noFocus) args.push("--no-focus");
  
  const result = await herdrSpawn(args);
  if (result === null) {
    throw new ContractError("state", "Herdr CLI not available");
  }
  if (result.code !== 0) {
    throw new ContractError("state", `Herdr pane split failed: ${result.stderr}`);
  }
  const parsed = parseHerdrJson(result.stdout.trim(), "pane split");
  // The CLI answers with an envelope: `{id, result: {pane: {...}}}`. Read the
  // pane info from either the envelope or a bare object, and validate the id:
  // a missing id would otherwise surface later as an unrelated "no worker
  // name" failure.
  const env = herdrResultOf(parsed);
  const resultPane = env?.["pane"];
  const bare = isPlainObject(parsed) ? parsed["pane"] : undefined;
  const raw = isPlainObject(resultPane) ? resultPane : isPlainObject(bare) ? bare : null;
  const paneId = raw?.["pane_id"];
  const tabId = raw?.["tab_id"];
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
  const parsed = parseHerdrJsonOrNull(result.stdout.trim());
  const env = herdrResultOf(parsed);
  if (!env) return null;
  // Real 0.9.5 shape: result.pane.{agent_status, ...}; tolerate a flat result.
  const pane = isPlainObject(env["pane"]) ? env["pane"] : env;
  const agentName = herdrStr(pane["agent_name"]) ?? herdrStr(pane["agentName"]) ?? herdrStr(pane["name"]);
  const agentKind = herdrStr(pane["agent_kind"]) ?? herdrStr(pane["agentKind"]) ?? herdrStr(pane["agent"]);
  return {
    status: herdrStr(pane["agent_status"]) ?? herdrStr(pane["status"]) ?? "unknown",
    ...(agentName !== undefined ? { agentName } : {}),
    ...(agentKind !== undefined ? { agentKind } : {}),
  };
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
  const parsed = parseHerdrJson(result.stdout.trim(), "agent start");
  // Herdr returns agent info in .agent.name, not .result.agentName
  const agent = isPlainObject(parsed) ? parsed["agent"] : null;
  const env = herdrResultOf(parsed);
  const agentName =
    (isPlainObject(agent) ? herdrStr(agent["name"]) : undefined) ??
    (env ? herdrStr(env["agentName"]) ?? herdrStr(env["agent_name"]) : undefined) ??
    options.workerName;
  return { agentName };
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
    const parsed = parseHerdrJsonOrNull(result.stdout.trim());
    const errorObj = isPlainObject(parsed) ? parsed["error"] : null;
    if (isPlainObject(errorObj)) {
      errorCode = herdrStr(errorObj["code"]);
      const errorMessage = herdrStr(errorObj["message"]);
      if (errorMessage) message = errorMessage;
    }
    // Not a JSON envelope: keep the stderr text.
    // A prompt rejected because the agent is blocked is an authorization
    // refusal; a stalled prompt never reached a working state.
    const blocked = errorCode === "agent_blocked";
    const stalled = !blocked;
    return { blocked, stalled, errorCode, response: message };
  }
  // On success the CLI answers with the agent state, not the answer: the
  // agent's text lives in its terminal output (readAgent).
  const env = herdrResultOf(parseHerdrJsonOrNull(result.stdout.trim()));
  if (!env) return { response: result.stdout.trim() };
  const out: { response?: string; blocked?: boolean; stalled?: boolean; errorCode?: string } = {};
  const response = herdrStr(env["response"]) ?? herdrStr(env["output"]);
  if (response !== undefined) out.response = response;
  if (typeof env["blocked"] === "boolean") out.blocked = env["blocked"];
  if (typeof env["stalled"] === "boolean") out.stalled = env["stalled"];
  const errorCode = herdrStr(env["error_code"]) ?? herdrStr(env["errorCode"]);
  if (errorCode !== undefined) out.errorCode = errorCode;
  return out;
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
  const env = herdrResultOf(parseHerdrJsonOrNull(result.stdout.trim()));
  if (!env) return { output: result.stdout.trim(), source: options.source || "recent" };
  return {
    output: herdrStr(env["output"]) ?? "",
    source: herdrStr(env["source"]) ?? options.source ?? "recent",
  };
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
  const env = herdrResultOf(parseHerdrJsonOrNull(result.stdout.trim()));
  if (!env) return { completed: false, reason: "parse error" };
  if (typeof env["completed"] === "boolean") {
    const reason = herdrStr(env["reason"]);
    return { completed: env["completed"], ...(reason !== undefined ? { reason } : {}) };
  }
  const status = herdrStr(env["status"]);
  return { completed: status === "done" || status === "idle", ...(status !== undefined ? { reason: status } : {}) };
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
  const env = herdrResultOf(parseHerdrJsonOrNull(result.stdout.trim()));
  if (!env) return null;
  // Real shape mirrors `agent list` entries, usually nested under result.agent.
  const agent = isPlainObject(env["agent"]) ? env["agent"] : env;
  const name = herdrStr(agent["name"]) ?? herdrStr(agent["worker_name"]) ?? herdrStr(agent["workerName"])
    ?? herdrStr(agent["agent_name"]) ?? herdrStr(agent["agentName"]) ?? herdrStr(agent["agent"]);
  if (!name) return null;
  const kind = herdrStr(agent["kind"]) ?? herdrStr(agent["agent_kind"]) ?? herdrStr(agent["agentKind"]) ?? herdrStr(agent["agent"]) ?? "";
  const paneId = herdrStr(agent["pane_id"]) ?? herdrStr(agent["paneId"]) ?? "";
  const status = herdrStr(agent["status"]) ?? herdrStr(agent["agent_status"]) ?? "unknown";
  const workspaceId = herdrStr(agent["workspace_id"]) ?? herdrStr(agent["workspaceId"]);
  const cwd = herdrStr(agent["cwd"]);
  return {
    name, kind, paneId, status,
    ...(workspaceId !== undefined ? { workspaceId } : {}),
    ...(cwd !== undefined ? { cwd } : {}),
  };
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
    const raw: unknown = JSON.parse(readFileSync(path, "utf-8"));
    if (!isPlainObject(raw)) return null;
    for (const key of ["taskId", "workspaceId", "paneId", "workerName", "createdAt", "route", "model"] as const) {
      if (typeof raw[key] !== "string") return null;
    }
    return raw as unknown as HerdrTaskMapping;
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
