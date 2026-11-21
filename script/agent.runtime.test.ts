#!/usr/bin/env bun
/**
 * Tests for the shared runtime contract (dotfiles#196, ADR-0021):
 * runtime selection helpers, attempt<->handle mapping, and the
 * `agent task run --runtime` CLI surface. No runtime process is spawned.
 */

import { describe, it, expect } from "bun:test";
import {
  RUNTIME_KINDS,
  attemptRuntime,
  attemptWorkerId,
  attemptRuntimeFields,
  workerHandleOf,
  runtimeAdapter,
} from "./agent/runtime.ts";
import { parseArgs } from "./agent/args.ts";

describe("runtime contract", () => {
  it("knows exactly herdr and rex", () => {
    expect(RUNTIME_KINDS).toEqual(["herdr", "rex"]);
    expect(runtimeAdapter("herdr").kind).toBe("herdr");
    expect(runtimeAdapter("rex").kind).toBe("rex");
  });

  it("treats a missing runtime field as herdr (pre---runtime records)", () => {
    expect(attemptRuntime({})).toBe("herdr");
    expect(attemptRuntime({ runtime: "rex" })).toBe("rex");
    expect(attemptRuntime({ runtime: "bogus" })).toBe("herdr");
  });

  it("maps attempt fields to the runtime-scoped worker identity", () => {
    const herdrAttempt = {
      herdrWorkerName: "worker-1",
      herdrPaneId: "pane-1",
      herdrWorkspaceId: "ws-1",
    };
    expect(attemptWorkerId(herdrAttempt)).toBe("worker-1");
    const herdrHandle = workerHandleOf(herdrAttempt);
    expect(herdrHandle?.id).toBe("worker-1");
    expect(herdrHandle?.surfaceId).toBe("ws-1");

    const rexAttempt = {
      runtime: "rex",
      rexBlockId: "block:1",
      rexWindowId: "window:1",
      rexSessionId: "session:1",
      rexWorkerLabel: "worker-1",
    };
    expect(attemptWorkerId(rexAttempt)).toBe("block:1");
    const rexHandle = workerHandleOf(rexAttempt);
    expect(rexHandle?.id).toBe("block:1");
    expect(rexHandle?.surfaceId).toBe("session:1");
    expect(rexHandle?.windowId).toBe("window:1");
  });

  it("returns null handles when the runtime worker ref is absent", () => {
    expect(workerHandleOf({ runtime: "rex" })).toBeNull();
    expect(workerHandleOf({})).toBeNull();
  });

  it("writes runtime-scoped attempt fields and never mixes namespaces", () => {
    const rexFields = attemptRuntimeFields("rex", {
      surfaceId: "session:1",
      windowId: "window:1",
      workerId: "block:1",
      workerLabel: "worker-1",
    });
    expect(rexFields).toEqual({
      rexSessionId: "session:1",
      rexWindowId: "window:1",
      rexBlockId: "block:1",
      rexWorkerLabel: "worker-1",
    });
    expect(rexFields).not.toHaveProperty("herdrWorkerName");

    const herdrFields = attemptRuntimeFields("herdr", {
      surfaceId: "ws-1",
      paneId: "pane-1",
      workerId: "worker-1",
    });
    expect(herdrFields).toEqual({
      herdrWorkspaceId: "ws-1",
      herdrPaneId: "pane-1",
      herdrWorkerName: "worker-1",
    });
    expect(herdrFields).not.toHaveProperty("rexBlockId");
  });
});

describe("task run --runtime parsing", () => {
  it("defaults to null (herdr) when --runtime is absent", () => {
    const action = parseArgs(["task", "run", "omp.paid", "--prompt", "hi"]);
    expect(action[0]).toBe("task");
    if (action[0] !== "task" || action[1] !== "run") throw new Error("unexpected action");
    expect(action[3].runtime).toBeNull();
  });

  it("accepts --runtime rex and --runtime herdr explicitly", () => {
    for (const runtime of ["rex", "herdr"] as const) {
      const action = parseArgs(["task", "run", "omp.paid", "--runtime", runtime]);
      if (action[0] !== "task" || action[1] !== "run") throw new Error("unexpected action");
      expect(action[3].runtime).toBe(runtime);
    }
  });

  it("rejects an unknown runtime", () => {
    expect(() =>
      parseArgs(["task", "run", "omp.paid", "--runtime", "tmux"]),
    ).toThrow();
  });
});
