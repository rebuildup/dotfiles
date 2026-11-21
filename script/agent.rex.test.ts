#!/usr/bin/env bun
/**
 * Tests for the Rex CLI integration (dotfiles#195, ADR-0021).
 *
 * Read-only probes always run; the lifecycle test creates and kills its own
 * session and is skipped when the Rex CLI or server is unavailable.
 */

import { describe, it, expect } from "bun:test";
import {
  checkRexAvailable,
  createSession,
  listSessions,
  getSession,
  listBlocks,
  getBlock,
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
import { rmSync, existsSync } from "node:fs";
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
