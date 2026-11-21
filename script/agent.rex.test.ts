#!/usr/bin/env bun
/**
 * Tests for the Rex CLI integration (dotfiles#195, ADR-0021).
 *
 * Read-only probes always run; the lifecycle test creates and kills its own
 * session and is skipped when the Rex CLI or server is unavailable.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import {
  checkRexAvailable,
  createSession,
  listSessions,
  getSession,
  listBlocks,
  getBlock,
  inspectBlockPresence,
  runBlock,
  sendText,
  sendKey,
  captureBlock,
  blockProgramStatus,
  blockProcess,
  deriveWorkerState,
  waitBlock,
  killSession,
  saveRexTaskMapping,
  loadRexTaskMapping,
  type RexProgramStatusRecord,
} from "./agent/rex.ts";
import { runtimeAdapter } from "./agent/runtime.ts";
import { mkdtempSync, rmSync, existsSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentStateDir } from "./agent/contract.ts";

const rexAvailable = await checkRexAvailable();

describe("Rex CLI availability", () => {
  it("checks Rex availability", () => {
    expect(typeof rexAvailable.available).toBe("boolean");
    if (rexAvailable.available) {
      expect(typeof rexAvailable.version).toBe("string");
    } else {
      expect(typeof rexAvailable.error).toBe("string");
    }
  });
});

describe("Session read paths", () => {
  it("lists sessions as an array", async () => {
    const sessions = await listSessions();
    expect(Array.isArray(sessions)).toBe(true);
  });

  it("returns null for a non-existent session", async () => {
    const session = await getSession("session:00000000-0000-0000-0000-000000000000");
    expect(session).toBeNull();
  });
});

describe("deriveWorkerState", () => {
  const rec = (state: string): RexProgramStatusRecord => ({ state });

  it("is unknown with no records", () => {
    expect(deriveWorkerState([])).toBe("unknown");
  });

  it("prefers blocked over working", () => {
    expect(deriveWorkerState([rec("working"), rec("blocked")])).toBe("blocked");
  });

  it("prefers working over done/idle", () => {
    expect(deriveWorkerState([rec("done"), rec("working")])).toBe("working");
  });

  it("maps idle-only to idle", () => {
    expect(deriveWorkerState([rec("idle")])).toBe("idle");
  });
});

describe("Task mapping persistence", () => {
  it("round-trips a mapping and rejects malformed files", () => {
    const taskId = `rex-test-${Date.now()}`;
    const mapping = {
      taskId,
      sessionId: "session:x",
      windowId: "window:y",
      blockId: "block:z",
      workerLabel: "worker-1",
      createdAt: new Date().toISOString(),
      route: "omp.openrouter",
      model: "m",
    };
    saveRexTaskMapping(mapping);
    expect(loadRexTaskMapping(taskId)).toEqual(mapping);
    expect(loadRexTaskMapping("nonexistent-task")).toBeNull();
    rmSync(join(agentStateDir(), "rex-tasks", `${taskId}.json`), { force: true });
    expect(existsSync(join(agentStateDir(), "rex-tasks", `${taskId}.json`))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Fault injection: a fake `rex` binary driven by REX_CLI + a mode file.
// Covers the ADR-0021 fail-closed rule — worker absence, transport failure
// and command failure must never collapse into the same verdict.
// ---------------------------------------------------------------------------

const FAKE_REX_SCRIPT = `#!/usr/bin/env bash
set -u
MODE_FILE="__MODE_FILE__"
mode="$(cat "$MODE_FILE" 2>/dev/null || echo error)"
if [ "$1" = "block" ] && [ "$2" = "inspect" ]; then
  case "$mode" in
    absent)  echo 'Error: block target "block:x" not found' >&2; exit 3 ;;
    error)   echo 'Error: connection refused' >&2; exit 1 ;;
    present) echo '{"block":{"block_id":"block:1","label":"w","window_id":"window:1"}}'; exit 0 ;;
  esac
fi
if [ "$1" = "block" ] && [ "$2" = "call" ]; then
  method="\${@: -1}"
  case "$method" in
    program_status) echo '{"records":[{"state":"idle"}]}';;
    process) echo '{"last_exit":null}';;
    *) echo '{}' ;;
  esac
  exit 0
fi
exit 0
`;

describe("Fault injection (fake rex binary)", () => {
  let dir: string;
  let fakeBin: string;
  let modeFile: string;
  let savedCli: string | undefined;

  const setMode = (mode: string) => writeFileSync(modeFile, mode);

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "fake-rex-"));
    fakeBin = join(dir, "rex");
    modeFile = join(dir, "mode");
    // Bun.spawn does not propagate env vars set after process start, so the
    // mode-file path is baked into the generated script instead.
    writeFileSync(fakeBin, FAKE_REX_SCRIPT.replace("__MODE_FILE__", modeFile));
    chmodSync(fakeBin, 0o755);
    savedCli = process.env.REX_CLI;
    process.env.REX_CLI = fakeBin;
  });

  afterAll(() => {
    if (savedCli === undefined) delete process.env.REX_CLI;
    else process.env.REX_CLI = savedCli;
    rmSync(dir, { recursive: true, force: true });
  });

  const handle = { runtime: "rex" as const, id: "block:1", surfaceId: "session:1", paneId: "block:1" };

  it("distinguishes absent / unreachable / present block", async () => {
    setMode("absent");
    expect(await inspectBlockPresence("session:1", "block:1")).toBe("absent");
    setMode("error");
    expect(await inspectBlockPresence("session:1", "block:1")).toBe("unknown");
    setMode("present");
    expect(await inspectBlockPresence("session:1", "block:1")).toBe("present");
  });

  it("getWorker: absent -> null, unreachable -> throws, present -> record", async () => {
    const adapter = runtimeAdapter("rex");
    setMode("absent");
    expect(await adapter.getWorker(handle)).toBeNull();
    setMode("error");
    await expect(adapter.getWorker(handle)).rejects.toThrow(/inconclusive/);
    setMode("present");
    const worker = await adapter.getWorker(handle);
    expect(worker?.name).toBe("block:1");
  });

  it("waitWorker never reports a transport failure as worker exit", async () => {
    const adapter = runtimeAdapter("rex");
    setMode("absent");
    const gone = await adapter.waitWorker(handle, 5000);
    expect(gone.completed).toBe(true);
    expect(gone.reason).toBe("worker exited");

    setMode("error");
    const unreachable = await adapter.waitWorker(handle, 1500);
    expect(unreachable.completed).toBe(false);
    expect(unreachable.reason).toBe("runtime-unreachable");

    setMode("present");
    const settled = await adapter.waitWorker(handle, 5000);
    expect(settled.completed).toBe(true);
    expect(settled.reason).toBe("idle");
  });
});

// ---------------------------------------------------------------------------
// Live lifecycle: skipped unless rex + server are reachable.
// ---------------------------------------------------------------------------

describe("Live session lifecycle", () => {
  it("creates a session, runs a block, observes it, and kills the session", async () => {
    if (!rexAvailable.available) return;

    const session = await createSession(process.cwd(), `test-${Date.now()}`, { windowLabel: "Test" });
    try {
      expect(session.id).toMatch(/^session:/);
      const detail = await getSession(session.id);
      expect(detail).not.toBeNull();

      const blocks = await listBlocks(session.id);
      expect(blocks.length).toBeGreaterThan(0);
      const shellBlock = blocks[0];

      const worker = await runBlock({
        sessionId: session.id,
        label: "worker",
        argv: ["sh", "-c", "echo READY; sleep 30"],
        keepOpen: true,
        focus: false,
      });
      expect(worker.blockId).toMatch(/^block:/);

      // The block may take a moment to spawn; poll briefly for the marker.
      let output = "";
      for (let i = 0; i < 20; i++) {
        output = await captureBlock(session.id, worker.blockId, { trim: true });
        if (output.includes("READY")) break;
        await new Promise((r) => setTimeout(r, 250));
      }
      expect(output).toContain("READY");

      const process = await blockProcess(session.id, worker.blockId);
      expect(process).not.toBeNull();

      const statuses = await blockProgramStatus(session.id, worker.blockId);
      expect(Array.isArray(statuses)).toBe(true);

      const inspect = await getBlock(session.id, worker.blockId);
      expect(inspect?.id).toBe(worker.blockId);

      // Input path: send text + Enter into a shell block, then read it back.
      await sendText(session.id, shellBlock.id, "echo REXPING");
      await sendKey(session.id, shellBlock.id, "enter");
      let shellOut = "";
      for (let i = 0; i < 20; i++) {
        shellOut = await captureBlock(session.id, shellBlock.id, { trim: true });
        if (shellOut.includes("REXPING")) break;
        await new Promise((r) => setTimeout(r, 250));
      }
      expect(shellOut).toContain("REXPING");

      const wait = await waitBlock(session.id, worker.blockId, 500);
      expect(wait.completed).toBe(false); // sleep 30 still running
    } finally {
      await killSession(session.id).catch(() => {});
    }
    // The session must be gone afterwards.
    expect(await getSession(session.id)).toBeNull();
  }, 60000);
});
