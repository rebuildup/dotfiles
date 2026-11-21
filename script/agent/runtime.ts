#!/usr/bin/env bun
/**
 * Execution-runtime adapters for `agent task` (dotfiles#196, ADR-0021).
 *
 * One logical contract — create surface, create pane, start worker, prompt,
 * read, wait, probe, close — implemented once per runtime:
 *
 *   herdr: workspace -> tab -> pane, named-agent registry (agent_status)
 *   rex:   session  -> window -> block, OSC 7501 program_status + process
 *
 * The adapter is deliberately thin: organizational semantics (attempt
 * class, fencing, evidence, acceptance) stay in task.ts / project-init.
 * Runtime selection is explicit (`--runtime`); there is no implicit
 * fallback between runtimes.
 */

import {
  checkHerdrAvailable,
  createWorkspace,
  createPane as herdrCreatePane,
  startAgent as herdrStartAgent,
  promptAgent as herdrPromptAgent,
  readAgent as herdrReadAgent,
  waitAgent as herdrWaitAgent,
  getAgent as herdrGetAgent,
  closePane as herdrClosePane,
  saveHerdrTaskMapping,
  loadHerdrTaskMapping,
  type AgentKind,
} from "./herdr.ts";
import {
  checkRexAvailable,
  createSession,
  getSession,
  listBlocks,
  runBlock,
  promptBlock,
  captureBlock,
  blockProgramStatus,
  blockProcess,
  deriveWorkerState,
  getBlock,
  inspectBlockPresence,
  closeBlock,
  killSession,
  saveRexTaskMapping,
  loadRexTaskMapping,
  type RexProgramStatusRecord,
} from "./rex.ts";
import { ContractError } from "./contract.ts";

export const RUNTIME_KINDS = ["herdr", "rex"] as const;
export type RuntimeKind = (typeof RUNTIME_KINDS)[number];

export function isRuntimeKind(value: unknown): value is RuntimeKind {
  return value === "herdr" || value === "rex";
}

// ---------------------------------------------------------------------------
// Normalized shapes
// ---------------------------------------------------------------------------

/** Canonical worker identity. `id` is the journal/effect target: the Herdr
 * agent name or the Rex block ID. `surfaceId` scopes Rex block operations
 * (session ID) and is the Herdr workspace ID. */
export interface WorkerHandle {
  /** Runtime that owns this worker; absent = "herdr" (legacy records). */
  runtime?: RuntimeKind;
  /** Rex host label/address for remote servers; absent = local server. */
  server?: string;
  id: string;
  surfaceId?: string;
  paneId?: string;
  windowId?: string;
  tabId?: string;
  label?: string;
}

export interface SurfaceRef {
  surfaceId: string;
  server?: string;
  paneId: string;
  windowId?: string;
  tabId?: string;
}

export interface PaneRef {
  paneId: string;
  tabId?: string;
}

export interface WorkerStartSpec {
  /** Requested worker name/label (Herdr agent name; Rex block label). */
  workerName: string;
  /** Herdr agent kind (`omp`); ignored by Rex, which runs argv directly. */
  kind: string;
  /** Herdr `agent start` options, e.g. ["--", "--provider", ...]. */
  options: string[];
  /** Rex worker argv (harness command + flags). Required for rex. */
  argv?: string[];
  /** Non-secret env only (credential policy, ADR-0021 §5). */
  env?: Record<string, string>;
  /** Rex host label/address for remote servers; absent = local server. */
  server?: string;
}

export interface PromptResult {
  blocked?: boolean;
  stalled?: boolean;
  errorCode?: string;
  response?: string;
}

export interface RuntimeTaskMapping {
  taskId: string;
  surfaceId: string;
  paneId: string;
  workerId: string;
  /** Runtime-specific extras: Rex window id and the human worker label. */
  windowId?: string;
  workerLabel?: string;
  createdAt: string;
  route: string;
  model: string;
  server?: string;
}

export interface TaskRuntimeAdapter {
  readonly kind: RuntimeKind;
  checkAvailable(): Promise<{ available: boolean; version?: string; error?: string }>;
  createSurface(cwd: string, label: string, env: Record<string, string>, target?: { server?: string }): Promise<SurfaceRef>;
  createPane(
    surfaceId: string,
    opts: { cwd?: string; split?: "right" | "down"; noFocus?: boolean; env?: Record<string, string>; server?: string },
  ): Promise<PaneRef>;
  startWorker(surface: SurfaceRef, paneId: string, spec: WorkerStartSpec): Promise<WorkerHandle>;
  promptWorker(handle: WorkerHandle, prompt: string, opts?: { wait?: boolean; timeoutMs?: number }): Promise<PromptResult>;
  readWorker(handle: WorkerHandle, opts?: { lines?: number }): Promise<{ output: string }>;
  waitWorker(handle: WorkerHandle, timeoutMs: number): Promise<{ completed: boolean; reason?: string }>;
  /** Existence probe: null when the worker is gone. */
  getWorker(handle: WorkerHandle): Promise<{ name: string; status: string } | null>;
  closePane(handle: WorkerHandle): Promise<void>;
  /** Close every runtime resource the attempt created (best effort). */
  destroySurface?(surfaceId: string, server?: string): Promise<void>;
  saveMapping(mapping: RuntimeTaskMapping): void;
  loadMapping(taskId: string): RuntimeTaskMapping | null;
}

// ---------------------------------------------------------------------------
// Herdr adapter
// ---------------------------------------------------------------------------

const herdrAdapter: TaskRuntimeAdapter = {
  kind: "herdr",

  checkAvailable: () => checkHerdrAvailable(),

  async createSurface(cwd, label, env) { // `target` is rex-only; herdr has no remote-server concept here
    const workspace = await createWorkspace(cwd, label, { noFocus: true, env });
    const rootPaneId = workspace.tabs[0]?.panes[0]?.id ?? "";
    // The root pane must reach an interactive shell prompt before an agent
    // can start (same settle the pre-adapter dispatch waited for).
    await new Promise((r) => setTimeout(r, 2000));
    return { surfaceId: workspace.id, paneId: rootPaneId, tabId: workspace.tabs[0]?.id };
  },

  createPane: (surfaceId, opts) =>
    herdrCreatePane({
      workspaceId: surfaceId,
      cwd: opts.cwd,
      split: opts.split,
      noFocus: opts.noFocus,
      env: opts.env,
    }),

  async startWorker(surface, paneId, spec) {
    const start = await herdrStartAgent({
      workerName: spec.workerName,
      kind: spec.kind as AgentKind,
      paneId,
      options: spec.options,
    });
    // `herdr agent prompt --wait` requires an observed working/blocked
    // transition within 5s of submission. OMP 19 cold-boots slower than
    // that, so prompting immediately reports agent_prompt_stalled even
    // though the worker is healthy (dotfiles#212). Wait for herdr's
    // interactive_ready signal — the TUI is up and can register a turn —
    // before the caller prompts. A herdr that never reports the field
    // keeps the legacy no-wait behaviour; a field that stays false past
    // the deadline is a startup failure, not a prompt failure.
    const readyDeadline = Date.now() + 30000;
    let sawReadyField = false;
    for (;;) {
      const agent = await herdrGetAgent(start.agentName).catch(() => null);
      if (agent?.interactiveReady !== undefined) sawReadyField = true;
      if (agent?.interactiveReady === true) break;
      if (Date.now() >= readyDeadline) {
        // A herdr too old to report interactive_ready keeps the legacy
        // fire-and-observe behaviour; a reported-but-never-ready worker is
        // a startup failure distinct from a prompt failure.
        if (!sawReadyField) break;
        throw new ContractError(
          "state",
          `herdr worker '${start.agentName}' not interactive-ready within 30s`,
        );
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    return {
      runtime: "herdr",
      id: start.agentName,
      surfaceId: surface.surfaceId,
      paneId,
      tabId: surface.tabId,
      label: spec.workerName,
    };
  },

  promptWorker: async (handle, prompt, opts) => {
    const result = await herdrPromptAgent(handle.id, prompt, opts);
    // `agent prompt --wait` demands an observed working/blocked transition
    // within a hardcoded 5s of submission. OMP 19 reports its turn through
    // the herdr extension with enough delay that the window can expire
    // while the worker is healthy — the prompt text was still delivered
    // and the turn runs to completion (dotfiles#212). A stalled verdict
    // here is therefore NOT proof of failure: keep observing agent state
    // until the turn settles or the caller's budget expires. Only a turn
    // we actually saw progress on may settle as success; silence past the
    // deadline stays stalled — never upgraded to completion.
    if (!result.stalled || result.errorCode !== "agent_prompt_stalled") {
      return result;
    }
    const deadline = Date.now() + (opts?.timeoutMs ?? 300000);
    let sawProgress = false;
    for (;;) {
      const agent = await herdrGetAgent(handle.id).catch(() => null);
      const status = agent?.status;
      if (status === "working" || status === "blocked") sawProgress = true;
      if (status === "done" || (sawProgress && status === "idle")) return {};
      if (status === "blocked") return { blocked: true, errorCode: "agent-blocked" };
      if (Date.now() >= deadline) return result;
      await new Promise((r) => setTimeout(r, 1000));
    }
  },

  readWorker: (handle, opts) =>
    herdrReadAgent(handle.id, { source: "recent", lines: opts?.lines ?? 200 }),

  waitWorker: (handle, timeoutMs) => herdrWaitAgent(handle.id, timeoutMs),

  getWorker: async (handle) => {
    const agent = await herdrGetAgent(handle.id);
    return agent === null ? null : { name: agent.name, status: agent.status };
  },

  closePane: async (handle) => {
    if (handle.paneId) await herdrClosePane(handle.paneId);
  },

  saveMapping: (m) =>
    saveHerdrTaskMapping({
      taskId: m.taskId,
      workspaceId: m.surfaceId,
      paneId: m.paneId,
      workerName: m.workerId,
      createdAt: m.createdAt,
      route: m.route,
      model: m.model,
    }),

  loadMapping: (taskId) => {
    const m = loadHerdrTaskMapping(taskId);
    if (!m) return null;
    return {
      taskId: m.taskId,
      surfaceId: m.workspaceId,
      paneId: m.paneId,
      workerId: m.workerName,
      createdAt: m.createdAt,
      route: m.route,
      model: m.model,
    };
  },
};

// ---------------------------------------------------------------------------
// Rex adapter
// ---------------------------------------------------------------------------

const REX_WAIT_POLL_MS = 1000;

function requireSessionId(handle: WorkerHandle, op: string): string {
  if (!handle.surfaceId) {
    throw new ContractError("state", `Rex ${op}: worker handle has no session id`);
  }
  return handle.surfaceId;
}

const rexAdapter: TaskRuntimeAdapter = {
  kind: "rex",

  checkAvailable: () => checkRexAvailable(),

  async createSurface(cwd, label, _env, target) {
    const server = target?.server;
    const session = await createSession(cwd, label, { server });
    try {
      // The session's first window holds a root shell block; it doubles as
      // the default split anchor, mirroring the Herdr root pane. A failed
      // inspection is a transport problem, not an empty session — fail
      // closed and clean up the surface we just created.
      const detail = await getSession(session.id, server);
      if (detail === null) {
        throw new ContractError("state", `Rex session ${session.id} inspection failed`);
      }
      const rootBlock = detail.windows[0]?.blocks[0];
      return {
        surfaceId: session.id,
        paneId: rootBlock?.id ?? "",
        windowId: detail.windows[0]?.id,
        tabId: detail.windows[0]?.id,
      };
    } catch (error) {
      await killSession(session.id, server).catch(() => {});
      throw error;
    }
  },

  async createPane(surfaceId, opts) {
    // Observational pane: a plain login shell split beside the session's
    // first block. `env` is intentionally not applied — it carries worker
    // credentials policy-wise and belongs on the worker block only.
    const blocks = await listBlocks(surfaceId, opts.server);
    const anchor = blocks[0]?.id;
    if (!anchor) {
      throw new ContractError("state", `Rex session ${surfaceId} has no block to split`);
    }
    const direction = opts.split === "down" ? "below" : "right";
    const created = await runBlock({
      sessionId: surfaceId,
      label: "output",
      cwd: opts.cwd,
      argv: [], // no command -> login shell
      split: { anchorBlockId: anchor, direction },
      focus: opts.noFocus === false ? true : false,
      server: opts.server,
    });
    return { paneId: created.blockId, tabId: created.windowId };
  },

  async startWorker(surface, _paneId, spec) {
    if (!spec.argv || spec.argv.length === 0) {
      throw new ContractError("state", "Rex worker start requires an argv (harness command + flags)");
    }
    const created = await runBlock({
      sessionId: surface.surfaceId,
      label: spec.workerName,
      argv: spec.argv,
      env: spec.env,
      focus: false,
      interactive: true,
      server: spec.server ?? surface.server,
    });
    return {
      runtime: "rex",
      server: spec.server ?? surface.server,
      id: created.blockId, // block id is the canonical worker handle
      surfaceId: surface.surfaceId,
      paneId: created.blockId,
      windowId: created.windowId,
      tabId: created.windowId,
      label: spec.workerName,
    };
  },

  promptWorker: (handle, prompt, opts) =>
    promptBlock(requireSessionId(handle, "prompt"), handle.paneId ?? handle.id, prompt, { ...opts, server: handle.server }),

  async readWorker(handle, opts) {
    const output = await captureBlock(requireSessionId(handle, "read"), handle.paneId ?? handle.id, {
      trim: true,
      tailLines: opts?.lines ?? 200,
      server: handle.server,
    });
    return { output };
  },

  async waitWorker(handle, timeoutMs) {
    const sessionId = requireSessionId(handle, "wait");
    const blockId = handle.paneId ?? handle.id;
    const server = handle.server;
    const deadline = Date.now() + timeoutMs;
    let lastState = "unknown";
    for (;;) {
      // Existence is probed separately from status: only a definitive
      // "absent" may end the wait. A transport/command failure is "unknown"
      // and keeps polling — it is never read as worker exit.
      const presence = await inspectBlockPresence(sessionId, blockId, server);
      if (presence === "absent") {
        // The worker's terminal is gone: the process exited and the block
        // closed. That is a settled end state, equivalent to Herdr's
        // done/idle.
        return { completed: true, reason: "worker exited" };
      }
      if (presence === "present") {
        const records = await blockProgramStatus(sessionId, blockId, server).catch(
          () => [] as RexProgramStatusRecord[],
        );
        const state = deriveWorkerState(records);
        lastState = state;
        if (state === "idle" || state === "done") {
          return { completed: true, reason: state };
        }
        if (state === "blocked") {
          return { completed: false, reason: "blocked" };
        }
        const proc = await blockProcess(sessionId, blockId, server).catch(() => null);
        if (proc !== null && proc.lastExit !== null) {
          return { completed: true, reason: `exit ${proc.lastExit}` };
        }
      }
      if (Date.now() >= deadline) {
        return {
          completed: false,
          reason: presence === "unknown" ? "runtime-unreachable" : lastState === "unknown" ? "timeout" : lastState,
        };
      }
      await new Promise((r) => setTimeout(r, REX_WAIT_POLL_MS));
    }
  },

  async getWorker(handle) {
    const sessionId = handle.surfaceId;
    if (!sessionId) return null;
    const blockId = handle.paneId ?? handle.id;
    const presence = await inspectBlockPresence(sessionId, blockId, handle.server);
    if (presence === "absent") return null;
    if (presence === "unknown") {
      // Fail closed: an unreachable runtime is not proof the worker is gone.
      throw new ContractError("state", `Rex worker probe inconclusive for block ${blockId}`);
    }
    const block = await getBlock(sessionId, blockId, handle.server).catch(() => null);
    return block === null ? null : { name: block.id, status: "present" };
  },

  closePane: async (handle) => {
    const sessionId = handle.surfaceId;
    if (!sessionId) return;
    await closeBlock(sessionId, handle.paneId ?? handle.id, handle.server);
  },

  destroySurface: async (surfaceId, server) => {
    await killSession(surfaceId, server);
  },

  saveMapping: (m) =>
    saveRexTaskMapping({
      taskId: m.taskId,
      sessionId: m.surfaceId,
      windowId: m.windowId ?? "",
      blockId: m.workerId,
      workerLabel: m.workerLabel ?? m.workerId,
      server: m.server,
      createdAt: m.createdAt,
      route: m.route,
      model: m.model,
    }),

  loadMapping: (taskId) => {
    const m = loadRexTaskMapping(taskId);
    if (!m) return null;
    return {
      taskId: m.taskId,
      surfaceId: m.sessionId,
      paneId: m.blockId,
      workerId: m.blockId,
      server: m.server,
      windowId: m.windowId,
      workerLabel: m.workerLabel,
      createdAt: m.createdAt,
      route: m.route,
      model: m.model,
    };
  },
};

const ADAPTERS: Record<RuntimeKind, TaskRuntimeAdapter> = {
  herdr: herdrAdapter,
  rex: rexAdapter,
};

export function runtimeAdapter(kind: RuntimeKind): TaskRuntimeAdapter {
  return ADAPTERS[kind];
}

// ---------------------------------------------------------------------------
// Attempt <-> handle helpers (runtime-aware; legacy records are herdr)
// ---------------------------------------------------------------------------

/** The runtime an attempt runs on. Records written before --runtime existed
 * have no `runtime` field and are Herdr attempts. An UNKNOWN value fails
 * closed — silently treating it as Herdr could aim Rex operations at a
 * Herdr worker (or vice versa). */
export function attemptRuntime(attempt: { runtime?: string }): RuntimeKind {
  if (attempt.runtime === undefined || attempt.runtime === "herdr") return "herdr";
  if (attempt.runtime === "rex") return "rex";
  throw new ContractError("schema", `unknown task runtime '${attempt.runtime}'`);
}

/** Canonical worker id for an attempt: Herdr agent name | Rex block id. */
export function attemptWorkerId(attempt: {
  runtime?: string;
  herdrWorkerName?: string;
  rexBlockId?: string;
}): string | undefined {
  return attemptRuntime(attempt) === "rex" ? attempt.rexBlockId : attempt.herdrWorkerName;
}

export function workerHandleOf(attempt: {
  runtime?: string;
  herdrWorkerName?: string;
  herdrPaneId?: string;
  herdrWorkspaceId?: string;
  rexSessionId?: string;
  rexWindowId?: string;
  rexBlockId?: string;
  rexWorkerLabel?: string;
  rexHost?: string;
}): WorkerHandle | null {
  const runtime = attemptRuntime(attempt);
  if (runtime === "rex") {
    if (!attempt.rexBlockId) return null;
    return {
      runtime,
      server: attempt.rexHost,
      id: attempt.rexBlockId,
      surfaceId: attempt.rexSessionId,
      paneId: attempt.rexBlockId,
      windowId: attempt.rexWindowId,
      label: attempt.rexWorkerLabel,
    };
  }
  if (!attempt.herdrWorkerName) return null;
  return {
    runtime,
    id: attempt.herdrWorkerName,
    surfaceId: attempt.herdrWorkspaceId,
    paneId: attempt.herdrPaneId,
  };
}

/** Runtime-scoped ref fields for a TaskAttempt, keyed by runtime. */
export function attemptRuntimeFields(
  runtime: RuntimeKind,
  refs: { surfaceId?: string; paneId?: string; windowId?: string; workerId: string; workerLabel?: string },
): Record<string, string> {
  if (runtime === "rex") {
    return {
      ...(refs.surfaceId ? { rexSessionId: refs.surfaceId } : {}),
      ...(refs.windowId ? { rexWindowId: refs.windowId } : {}),
      ...(refs.workerId ? { rexBlockId: refs.workerId } : {}),
      ...(refs.workerLabel ? { rexWorkerLabel: refs.workerLabel } : {}),
    };
  }
  return {
    ...(refs.surfaceId ? { herdrWorkspaceId: refs.surfaceId } : {}),
    ...(refs.paneId ? { herdrPaneId: refs.paneId } : {}),
    ...(refs.workerId ? { herdrWorkerName: refs.workerId } : {}),
  };
}

