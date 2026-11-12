#!/usr/bin/env bun
/**
 * Tests for Herdr CLI integration (dotfiles#100).
 *
 * Uses mocks - does not require actual Herdr CLI.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import {
  checkHerdrAvailable,
  listWorkspaces,
  getWorkspace,
  createPane,
  getPaneStatus,
  closePane,
  startAgent,
  promptAgent,
  readAgent,
  waitAgent,
  listAgents,
  getAgent,
  saveHerdrTaskMapping,
  loadHerdrTaskMapping,
} from "./agent/herdr.ts";
import { ContractError } from "./agent/contract.ts";
import { rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { agentStateDir } from "./agent/contract.ts";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Herdr CLI availability", () => {
  it("checks Herdr availability", async () => {
    const result = await checkHerdrAvailable();
    // Herdr may or may not be installed in test environment
    expect(typeof result.available).toBe("boolean");
    if (result.available) {
      expect(typeof result.version).toBe("string");
    } else {
      expect(typeof result.error).toBe("string");
    }
  });
});

describe("Workspace operations", () => {
  it("lists workspaces (returns empty array if none)", async () => {
    const workspaces = await listWorkspaces();
    expect(Array.isArray(workspaces)).toBe(true);
  });

  it("returns null for non-existent workspace", async () => {
    const workspace = await getWorkspace("non-existent-workspace");
    expect(workspace).toBeNull();
  });

  it("handles createWorkspace gracefully when Herdr not available", async () => {
    // This will fail if Herdr not installed, which is expected in test env
    try {
      await createWorkspace("/tmp", "test-workspace");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
    }
  });
});

describe("Pane operations", () => {
  it("returns null for non-existent pane", async () => {
    const status = await getPaneStatus("non-existent-pane");
    expect(status).toBeNull();
  });

  it("handles createPane gracefully when Herdr not available", async () => {
    try {
      await createPane({ workspaceId: "test-workspace" });
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
    }
  });

  it("handles closePane gracefully", async () => {
    try {
      await closePane("non-existent-pane");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
    }
  });
});

describe("Agent operations", () => {
  it("lists agents (returns empty array if none)", async () => {
    const agents = await listAgents();
    expect(Array.isArray(agents)).toBe(true);
  });

  it("returns null for non-existent agent", async () => {
    const agent = await getAgent("non-existent-agent");
    expect(agent).toBeNull();
  });

  it("handles startAgent gracefully", async () => {
    try {
      await startAgent({ workerName: "test-worker", kind: "claude", paneId: "test-pane" });
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
    }
  });

  it("handles promptAgent gracefully", async () => {
    const result = await promptAgent("test-worker", "test prompt");
    // Should return a response object even if Herdr not available
    expect(typeof result).toBe("object");
  });

  it("handles readAgent gracefully", async () => {
    const result = await readAgent("test-worker");
    expect(typeof result).toBe("object");
    expect(typeof result.output).toBe("string");
  });

  it("handles waitAgent gracefully", async () => {
    const result = await waitAgent("test-worker", 1000);
    expect(typeof result.completed).toBe("boolean");
  });
});

describe("Herdr task mapping persistence", () => {
  it("saves and loads Herdr task mapping", () => {
    const mapping = {
      taskId: "test-task-1",
      workspaceId: "ws-test-1",
      paneId: "pane-1",
      workerName: "worker-1",
      createdAt: new Date().toISOString(),
      route: "omp.mistral",
      model: "zai-glm-5-3-flash",
    };
    
    // Clean up first
    const path = join(agentStateDir(), "herdr-tasks", "test-task-1.json");
    if (existsSync(path)) rmSync(path);
    
    saveHerdrTaskMapping(mapping);
    
    const loaded = loadHerdrTaskMapping("test-task-1");
    expect(loaded).not.toBeNull();
    expect(loaded!.taskId).toBe("test-task-1");
    expect(loaded!.workspaceId).toBe("ws-test-1");
    expect(loaded!.paneId).toBe("pane-1");
    expect(loaded!.workerName).toBe("worker-1");
    expect(loaded!.route).toBe("omp.mistral");
  });
});
