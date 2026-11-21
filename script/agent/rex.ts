#!/usr/bin/env bun
/**
 * Rex CLI integration for agent tasks (dotfiles#195, ADR-0021).
 *
 * Thin, validated wrappers around the `rex` CLI. Rex's model is
 * server -> session -> window -> block; there is no agent registry, so a
 * "worker" is a labeled block running the route's harness command and its
 * identity lives in the caller's attempt records.
 *
 * State observation is evidence-tiered (ADR-0021 §4): OSC 7501
 * `program_status` records first, then `process` liveness / `last_exit`,
 * then `capture` screen text. An absent or unknown state is never treated
 * as success.
 *
 * Credential rule (ADR-0021 §5): only non-secret environment may be passed,
 * as an `env NAME=VALUE` argv prefix. `rex run` has no `--env`; a secret
 * must never appear in argv, server state, logs, or task state files.
 */

import { ContractError, agentStateDir, isPlainObject } from "./contract.ts";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

// REX_CLI override exists for fault-injection tests and exotic installs;
// production use leaves it unset and resolves `rex` from PATH. Read per
// spawn so tests can swap the binary between cases.
function rexBin(): string {
  return process.env.REX_CLI?.trim() || "rex";
}

// ---------------------------------------------------------------------------
// CLI availability
// ---------------------------------------------------------------------------

export async function checkRexAvailable(): Promise<{ available: boolean; version?: string; error?: string }> {
  try {
    const proc = await Bun.spawn([rexBin(), "version"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = await new TextDecoder().decode(await new Response(proc.stdout).arrayBuffer());
    const code = await proc.exited;
    if (code === 0) {
      const firstLine = stdout.trim().split("\n")[0] ?? "";
      return { available: true, version: firstLine };
    }
    return { available: false, error: `Rex CLI exited with code ${code}` };
  } catch (error) {
    return { available: false, error: error instanceof Error ? error.message : String(error) };
  }
}

// ---------------------------------------------------------------------------
// Spawn + JSON boundary helpers
// ---------------------------------------------------------------------------

interface RexSpawnResult {
  stdout: string;
  stderr: string;
  code: number;
}

async function rexSpawn(args: string[], opts: { cwd?: string; timeoutMs?: number } = {}): Promise<RexSpawnResult | null> {
  try {
    const proc = await Bun.spawn([rexBin(), ...args], {
      stdout: "pipe",
      stderr: "pipe",
      cwd: opts.cwd,
    });
    const stdout = await new TextDecoder().decode(await new Response(proc.stdout).arrayBuffer());
    const stderr = await new TextDecoder().decode(await new Response(proc.stderr).arrayBuffer());
    const code = await proc.exited;
    return { stdout, stderr, code };
  } catch {
    // "Executable not found in $PATH" — rex not installed
    return null;
  }
}

function rexStr(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function parseRexJson(text: string, what: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new ContractError("schema", `Failed to parse Rex ${what} output: ${error}`);
  }
}

function parseRexJsonOrNull(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function requireRex(result: RexSpawnResult | null, what: string): RexSpawnResult {
  if (result === null) {
    throw new ContractError("state", "Rex CLI not available");
  }
  if (result.code !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim();
    throw new ContractError("state", `Rex ${what} failed${detail ? `: ${detail}` : ""}`);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RexSession {
  id: string;
  label: string;
}

export interface RexBlock {
  id: string;
  label: string;
  windowId: string;
  creatorName?: string;
  flavor?: string;
}

export interface RexWindow {
  id: string;
  label: string;
  focusedBlockId?: string;
  blocks: RexBlock[];
}

export interface RexSessionDetail extends RexSession {
  activeWindowId?: string;
  windows: RexWindow[];
}

/** One OSC 7501 program_status record as reported by a block. */
export interface RexProgramStatusRecord {
  state: string;
  id?: string;
  kind?: string;
  app?: string;
  msg?: string;
  progress?: number;
  /** Server-side report timestamp; distinguishes a re-report of an identical
   * state (a new turn's `done`) from the stale record it replaces. */
  updatedAt?: string;
}

export interface RexProcessInfo {
  foreground?: { pid: number; name: string; cwd?: string };
  lastExit: number | null;
}

// ---------------------------------------------------------------------------
// Session operations
// ---------------------------------------------------------------------------

/**
 * Create a session with one shell window (`rex new`). The root block is a
 * plain login shell; workers are started in their own windows/blocks.
 */
export async function createSession(
  cwd: string,
  label: string,
  options: { windowLabel?: string; command?: string[] } = {}
): Promise<RexSessionDetail> {
  const args = ["new", label, "-c", cwd, "--json"];
  if (options.windowLabel) args.push("--window", options.windowLabel);
  if (options.command && options.command.length > 0) args.push("--", ...options.command);
  const result = requireRex(await rexSpawn(args, { cwd }), "session create");
  const parsed = parseRexJson(result.stdout.trim(), "session create");
  if (!isPlainObject(parsed) || typeof parsed["session_id"] !== "string") {
    throw new ContractError("schema", "Rex session create: missing session_id");
  }
  return {
    id: parsed["session_id"],
    label: rexStr(parsed["label"]) ?? label,
    activeWindowId: undefined,
    windows: [],
  };
}

export async function listSessions(): Promise<RexSession[]> {
  const result = await rexSpawn(["ls", "--json"]);
  if (result === null || result.code !== 0) return [];
  const parsed = parseRexJsonOrNull(result.stdout.trim());
  if (!isPlainObject(parsed) || !Array.isArray(parsed["sessions"])) return [];
  const out: RexSession[] = [];
  for (const entry of parsed["sessions"]) {
    if (!isPlainObject(entry)) continue;
    const id = rexStr(entry["session_id"]);
    if (!id) continue;
    out.push({ id, label: rexStr(entry["label"]) ?? "" });
  }
  return out;
}

function rexBlockFromRaw(raw: unknown): RexBlock | null {
  if (!isPlainObject(raw)) return null;
  const id = rexStr(raw["block_id"]);
  if (!id) return null;
  return {
    id,
    label: rexStr(raw["label"]) ?? "",
    windowId: rexStr(raw["window_id"]) ?? "",
    creatorName: rexStr(raw["creator_name"]),
    flavor: rexStr(raw["flavor"]),
  };
}

/** `rex session inspect --json` → windows with their blocks. */
export async function getSession(sessionId: string): Promise<RexSessionDetail | null> {
  const result = await rexSpawn(["session", "inspect", sessionId, "--json"]);
  if (result === null || result.code !== 0) return null;
  const parsed = parseRexJsonOrNull(result.stdout.trim());
  if (!isPlainObject(parsed)) return null;
  const id = rexStr(parsed["session_id"]);
  if (!id) return null;
  const windows: RexWindow[] = [];
  const rawWindows = parsed["windows"];
  if (Array.isArray(rawWindows)) {
    for (const rawWindow of rawWindows) {
      if (!isPlainObject(rawWindow)) continue;
      const windowId = rexStr(rawWindow["window_id"]);
      if (!windowId) continue;
      const blocks: RexBlock[] = [];
      const layers = rawWindow["layers"];
      if (Array.isArray(layers)) {
        for (const layer of layers) {
          if (!isPlainObject(layer)) continue;
          const rawBlocks = layer["blocks"];
          if (!Array.isArray(rawBlocks)) continue;
          for (const rawBlock of rawBlocks) {
            const block = rexBlockFromRaw(rawBlock);
            if (block) blocks.push(block);
          }
        }
      }
      windows.push({
        id: windowId,
        label: rexStr(rawWindow["label"]) ?? "",
        focusedBlockId: rexStr(rawWindow["focused_block_id"]),
        blocks,
      });
    }
  }
  return {
    id,
    label: rexStr(parsed["label"]) ?? "",
    activeWindowId: rexStr(parsed["active_window_id"]),
    windows,
  };
}

// ---------------------------------------------------------------------------
// Block / window operations
// ---------------------------------------------------------------------------

export interface RunBlockOptions {
  sessionId: string;
  label: string;
  cwd?: string;
  /** Full argv for the block's process (after `--`). */
  argv: string[];
  /** Non-secret env only; rendered as an `env NAME=VALUE` argv prefix. */
  env?: Record<string, string>;
  /** New window (default) vs split beside an existing block. */
  split?: { anchorBlockId: string; direction: "right" | "left" | "above" | "below"; ratio?: number };
  focus?: boolean;
  keepOpen?: boolean;
  /** Also read the shell's interactive startup files (needed for mise/agent PATH). */
  interactive?: boolean;
}

function envPrefix(env: Record<string, string> | undefined): string[] {
  if (!env) return [];
  const pairs = Object.entries(env).map(([k, v]) => `${k}=${v}`);
  return pairs.length > 0 ? ["env", ...pairs] : [];
}

function parseBlockCreation(parsed: unknown, what: string): { blockId: string; windowId: string } {
  if (!isPlainObject(parsed)) {
    throw new ContractError("schema", `Rex ${what}: output is not an object`);
  }
  const blockIds = parsed["block_ids"];
  const blockId = Array.isArray(blockIds) ? rexStr(blockIds[0]) : undefined;
  if (!blockId) {
    throw new ContractError("schema", `Rex ${what}: missing block_ids[0]`);
  }
  return { blockId, windowId: rexStr(parsed["window_id"]) ?? "" };
}

/**
 * Start a command in a new block. Default placement is a new window in the
 * session (a "function tab"); `split` places it beside an existing block.
 * Returns the created block/window IDs from the `--json` reply.
 */
export async function runBlock(options: RunBlockOptions): Promise<{ blockId: string; windowId: string }> {
  const argv = [...envPrefix(options.env), ...options.argv];
  const args: string[] = [];
  if (options.split) {
    args.push("split", "-s", options.sessionId, "-b", options.split.anchorBlockId,
      "--split", options.split.direction, "--label", options.label);
    if (options.split.ratio !== undefined) args.push("--ratio", String(options.split.ratio));
  } else {
    args.push("run", "-s", options.sessionId, "--label", options.label);
  }
  if (options.cwd) args.push("-c", options.cwd);
  if (options.keepOpen) args.push("--keep-open");
  if (options.focus === false) args.push("--focus=false");
  if (options.interactive) args.push("--interactive");
  args.push("--json");
  // No argv -> plain `--` omitted so the block runs a login shell.
  if (argv.length > 0) args.push("--", ...argv);
  const result = requireRex(await rexSpawn(args), "block create");
  return parseBlockCreation(parseRexJson(result.stdout.trim(), "block create"), "block create");
}

/** All blocks in a session (`rex block ls --json`). */
export async function listBlocks(sessionId: string): Promise<RexBlock[]> {
  const result = await rexSpawn(["block", "ls", "-s", sessionId, "--json"]);
  if (result === null || result.code !== 0) return [];
  const parsed = parseRexJsonOrNull(result.stdout.trim());
  if (!isPlainObject(parsed) || !Array.isArray(parsed["blocks"])) return [];
  return parsed["blocks"].map(rexBlockFromRaw).filter((b): b is RexBlock => b !== null);
}

/** One block's metadata, or null when it no longer exists. */
export async function getBlock(sessionId: string, blockId: string): Promise<RexBlock | null> {
  const result = await rexSpawn(["block", "inspect", "-s", sessionId, blockId, "--json"]);
  if (result === null || result.code !== 0) return null;
  const parsed = parseRexJsonOrNull(result.stdout.trim());
  if (!isPlainObject(parsed)) return null;
  const block = isPlainObject(parsed["block"]) ? parsed["block"] : parsed;
  return rexBlockFromRaw(block);
}

export type BlockPresence = "present" | "absent" | "unknown";

/**
 * Authoritative worker-existence probe. The three outcomes are distinct on
 * purpose (ADR-0021 §4 fail-closed rule):
 *
 * - "present": `block inspect` returned a block record.
 * - "absent": the server answered and reported the block (or its session)
 *   as not found — exit 3 with a "not found" diagnostic. Only this outcome
 *   may be read as "the worker is gone".
 * - "unknown": the CLI is missing, the server is unreachable, or the
 *   command failed for any other reason. Callers must NOT treat this as
 *   absence — a transport blip is not evidence the worker exited.
 */
export async function inspectBlockPresence(sessionId: string, blockId: string): Promise<BlockPresence> {
  const result = await rexSpawn(["block", "inspect", "-s", sessionId, blockId, "--json"]);
  if (result === null) return "unknown";
  if (result.code === 0) {
    const parsed = parseRexJsonOrNull(result.stdout.trim());
    if (!isPlainObject(parsed)) return "unknown";
    const block = isPlainObject(parsed["block"]) ? parsed["block"] : parsed;
    return rexBlockFromRaw(block) !== null ? "present" : "unknown";
  }
  const detail = `${result.stderr}\n${result.stdout}`;
  if (result.code === 3 && /not found/i.test(detail)) return "absent";
  return "unknown";
}

export async function closeBlock(sessionId: string, blockId: string): Promise<void> {
  const result = await rexSpawn(["block", "close", "-s", sessionId, blockId]);
  if (result === null) return; // rex not available; nothing to clean
  if (result.code !== 0) {
    throw new ContractError("state", `Rex block close failed: ${result.stderr.trim() || result.stdout.trim()}`);
  }
}

export async function closeWindow(sessionId: string, windowId: string): Promise<void> {
  const result = await rexSpawn(["window", "close", "-s", sessionId, windowId]);
  if (result === null) return;
  if (result.code !== 0) {
    throw new ContractError("state", `Rex window close failed: ${result.stderr.trim() || result.stdout.trim()}`);
  }
}

export async function killSession(sessionId: string): Promise<void> {
  const result = await rexSpawn(["kill", sessionId]);
  if (result === null) return;
  if (result.code !== 0) {
    throw new ContractError("state", `Rex session kill failed: ${result.stderr.trim() || result.stdout.trim()}`);
  }
}

// ---------------------------------------------------------------------------
// Input / output
// ---------------------------------------------------------------------------

/** Type text into a block's foreground program (`rex send`). */
export async function sendText(sessionId: string, blockId: string, text: string): Promise<void> {
  requireRex(
    await rexSpawn(["send", "-s", sessionId, "-b", blockId, text]),
    "send",
  );
}

/** Press a key in a block (`rex send-key`). */
export async function sendKey(sessionId: string, blockId: string, key: string): Promise<void> {
  requireRex(await rexSpawn(["send-key", "-s", sessionId, "-b", blockId, key]), "send-key");
}

/** Screen + scrollback of a block (`rex capture`). */
export async function captureBlock(
  sessionId: string,
  blockId: string,
  options: { trim?: boolean; unwrap?: boolean; tailLines?: number } = {}
): Promise<string> {
  const args = ["capture", "-s", sessionId, "-b", blockId];
  if (options.trim) args.push("--trim");
  if (options.unwrap) args.push("--unwrap");
  const result = requireRex(await rexSpawn(args), "capture");
  let text = result.stdout;
  if (options.tailLines !== undefined && options.tailLines > 0) {
    const lines = text.replace(/\n$/, "").split("\n");
    text = lines.slice(-options.tailLines).join("\n") + "\n";
  }
  return text;
}

// ---------------------------------------------------------------------------
// Observation
// ---------------------------------------------------------------------------

async function blockCall(sessionId: string, blockId: string, method: string): Promise<unknown | null> {
  const result = await rexSpawn(["block", "call", "-s", sessionId, "-b", blockId, method]);
  if (result === null || result.code !== 0) return null;
  return parseRexJsonOrNull(result.stdout.trim());
}

/** OSC 7501 program_status records reported by programs in the block. */
export async function blockProgramStatus(sessionId: string, blockId: string): Promise<RexProgramStatusRecord[]> {
  const parsed = await blockCall(sessionId, blockId, "program_status");
  if (!isPlainObject(parsed) || !Array.isArray(parsed["records"])) return [];
  const records: RexProgramStatusRecord[] = [];
  for (const raw of parsed["records"]) {
    if (!isPlainObject(raw)) continue;
    const state = rexStr(raw["state"]);
    if (!state) continue;
    records.push({
      state,
      id: rexStr(raw["id"]),
      kind: rexStr(raw["kind"]),
      app: rexStr(raw["app"]),
      msg: rexStr(raw["msg"]),
      progress: typeof raw["progress"] === "number" ? raw["progress"] : undefined,
      updatedAt: rexStr(raw["updated_at"]),
    });
  }
  return records;
}

/** Foreground process + last exit status of the block's terminal. */
export async function blockProcess(sessionId: string, blockId: string): Promise<RexProcessInfo | null> {
  const parsed = await blockCall(sessionId, blockId, "process");
  if (!isPlainObject(parsed)) return null;
  const foregroundRaw = parsed["foreground"];
  const foreground = isPlainObject(foregroundRaw)
    ? {
        pid: typeof foregroundRaw["pid"] === "number" ? foregroundRaw["pid"] : 0,
        name: rexStr(foregroundRaw["name"]) ?? "",
        cwd: rexStr(foregroundRaw["cwd"]),
      }
    : undefined;
  return {
    ...(foreground !== undefined ? { foreground } : {}),
    lastExit: typeof parsed["last_exit"] === "number" ? parsed["last_exit"] : null,
  };
}

/**
 * Derive a coarse worker state from program_status records, in the same
 * vocabulary Herdr uses so callers can share verdict logic. Precedence:
 * blocked > working > done > error > idle. With no records the state is
 * "unknown" — callers must not treat that as success.
 */
export function deriveWorkerState(records: RexProgramStatusRecord[]): "idle" | "working" | "blocked" | "done" | "unknown" {
  if (records.length === 0) return "unknown";
  const states = new Set(records.map((r) => r.state));
  if (states.has("blocked")) return "blocked";
  if (states.has("working")) return "working";
  if (states.has("done")) return "done";
  if (states.has("error")) return "done";
  if (states.has("idle")) return "idle";
  return "unknown";
}

/**
 * Wait for a block's terminal child to exit (`rex wait --for`). Returns
 * completed=false on timeout or when the block vanished first.
 */
export async function waitBlock(sessionId: string, blockId: string, timeoutMs: number): Promise<{ completed: boolean; reason?: string }> {
  const seconds = Math.max(1, Math.ceil(timeoutMs / 1000));
  const result = await rexSpawn(["wait", blockId, "-s", sessionId, "--for", `${seconds}s`, "--json"]);
  if (result === null) return { completed: false, reason: "rex not available" };
  if (result.code !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim();
    return { completed: false, reason: detail || "wait failed" };
  }
  const parsed = parseRexJsonOrNull(result.stdout.trim());
  return { completed: true, ...(isPlainObject(parsed) ? { reason: JSON.stringify(parsed) } : {}) };
}

// ---------------------------------------------------------------------------
// Prompt / wait helper (semantic layer for the runtime adapter, #196)
// ---------------------------------------------------------------------------

export interface PromptResult {
  blocked?: boolean;
  stalled?: boolean;
  errorCode?: string;
  response?: string;
}

const PROMPT_POLL_INTERVAL_MS = 1000;

/**
 * Send a prompt into a worker block and optionally wait for it to settle.
 *
 * "Settled" means every program_status record is idle/done (or records are
 * absent AND the foreground process is gone). A `blocked` record maps to
 * blocked=true; timeout maps to stalled=true. Both mirror the Herdr
 * promptAgent contract so promptFailureSignal can classify them without a
 * runtime branch.
 */
export async function promptBlock(
  sessionId: string,
  blockId: string,
  prompt: string,
  options: { wait?: boolean; timeoutMs?: number } = {}
): Promise<PromptResult> {
  // Correlate status records to THIS prompt: a `done` record survives a new
  // prompt until the program reports again, so the pre-send snapshot is the
  // baseline. Only a CHANGED record set may settle the wait — an unchanged
  // snapshot is stale evidence, never proof of completion.
  const baselineRecords = await blockProgramStatus(sessionId, blockId).catch(
    () => [] as RexProgramStatusRecord[],
  );
  const baselineSignature = JSON.stringify(baselineRecords);

  await sendText(sessionId, blockId, prompt);
  await sendKey(sessionId, blockId, "enter");
  if (!options.wait) return {};

  const timeoutMs = options.timeoutMs ?? 300000;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const records = await blockProgramStatus(sessionId, blockId).catch(() => [] as RexProgramStatusRecord[]);
    const signature = JSON.stringify(records);
    const fresh = signature !== baselineSignature;
    const state = deriveWorkerState(records);
    if (fresh && state === "blocked") {
      const kind = records.find((r) => r.state === "blocked")?.kind;
      return { blocked: true, errorCode: kind ? `agent-blocked-${kind}` : "agent-blocked" };
    }
    if (fresh && records.length > 0 && (state === "idle" || state === "done")) {
      return {};
    }
    // No NEW OSC 7501 records: fall back to process liveness. A gone block
    // or a dead foreground child means the worker exited. A transport
    // failure stays "unknown" — never success; only a definitive "absent"
    // probe may settle the wait as exited.
    if (records.length === 0 || !fresh) {
      const proc = await blockProcess(sessionId, blockId).catch(() => null);
      if (proc !== null && proc.lastExit !== null) {
        return {};
      }
      if (proc === null) {
        const presence = await inspectBlockPresence(sessionId, blockId);
        if (presence === "absent") return {};
      }
    }
    if (Date.now() >= deadline) {
      return { stalled: true, errorCode: "agent-stalled" };
    }
    await new Promise((r) => setTimeout(r, PROMPT_POLL_INTERVAL_MS));
  }
}

// ---------------------------------------------------------------------------
// Task mapping persistence (mirrors herdr-tasks, runtime-scoped)
// ---------------------------------------------------------------------------

const REX_TASK_STATE_DIR = join(agentStateDir(), "rex-tasks");

function ensureRexTaskStateDir(): void {
  if (!existsSync(REX_TASK_STATE_DIR)) {
    mkdirSync(REX_TASK_STATE_DIR, { recursive: true });
  }
}

function rexTaskStatePath(taskId: string): string {
  return join(REX_TASK_STATE_DIR, `${taskId}.json`);
}

export interface RexTaskMapping {
  taskId: string;
  sessionId: string;
  windowId: string;
  blockId: string;
  workerLabel: string;
  createdAt: string;
  route: string;
  model: string;
}

export function saveRexTaskMapping(mapping: RexTaskMapping): void {
  ensureRexTaskStateDir();
  writeFileSync(rexTaskStatePath(mapping.taskId), JSON.stringify(mapping, null, 2));
}

export function loadRexTaskMapping(taskId: string): RexTaskMapping | null {
  const path = rexTaskStatePath(taskId);
  if (!existsSync(path)) return null;
  try {
    const raw: unknown = JSON.parse(readFileSync(path, "utf-8"));
    if (!isPlainObject(raw)) return null;
    const mapping: Record<keyof RexTaskMapping, string> = {
      taskId: "", sessionId: "", windowId: "", blockId: "", workerLabel: "",
      createdAt: "", route: "", model: "",
    };
    for (const key of ["taskId", "sessionId", "windowId", "blockId", "workerLabel", "createdAt", "route", "model"] as const) {
      const value = raw[key];
      if (typeof value !== "string") return null;
      mapping[key] = value;
    }
    return mapping;
  } catch {
    return null;
  }
}

