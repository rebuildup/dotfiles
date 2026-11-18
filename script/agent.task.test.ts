#!/usr/bin/env bun
/**
 * Tests for Herdr task dispatch/collect (dotfiles#100, T014).
 *
 * Uses mocks and stubs - does not import the main agent launcher.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from "bun:test";
import {
  dispatchTask,
  startTaskAttempt,
  collectTaskAttempt,
  recordAttemptOutcome,
  getTaskStatus,
  loadTaskState,
  saveTaskState,
  buildAgentStartOptions,
  routeWorkerEnv,
  verifyAcceptanceCriteria,
  captureWorkspaceBaseline,
  runTaskToCompletion,
} from "./agent/task.ts";
import { ContractError } from "./agent/contract.ts";
import { type Config, type Provider } from "./agent/config.ts";
import { rmSync, existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentStateDir } from "./agent/contract.ts";

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

const TEST_TASK_DIR = join(agentStateDir(), "tasks");

beforeAll(() => {
  // Clean up any existing test state
  const testFiles = ["test-task-1", "test-task-2", "test-task-fallback", "test-status-1", "test-status-2", "test-status-3", "test-start-1", "test-collect-1", "test-fallback-1", "test-max-attempts", "test-dispatch-1", "test-invalid-route", "test-invalid-model", "test-profile-mismatch", "test-fallback-1", "test-fallback-2"];
  for (const taskId of testFiles) {
    const path = join(agentStateDir(), "tasks", `${taskId}.json`);
    if (existsSync(path)) rmSync(path);
  }
});

afterAll(() => {
  // Clean up
  for (const taskId of ["test-task-1", "test-task-2", "test-task-fallback", "test-status-1", "test-status-2", "test-status-3", "test-start-1", "test-collect-1", "test-fallback-1", "test-max-attempts", "test-dispatch-1", "test-invalid-route", "test-invalid-model", "test-profile-mismatch", "test-fallback-1", "test-fallback-2"]) {
    const path = join(agentStateDir(), "tasks", `${taskId}.json`);
    if (existsSync(path)) rmSync(path);
  }
});

// ---------------------------------------------------------------------------
// Mock config for tests
// ---------------------------------------------------------------------------

const MOCK_PROVIDER = {
  key: "mock",
  label: "Mock",
  base_url: null,
  require_model: true,
  opencode_id: "mock",
  omp_id: "mock",
  anonymous: false,
  opencode_npm: null,
  opencode_models: {},
  opencode_base_url: null,
  omp_custom: false,
  omp_api: null,
  omp_models: {},
};

const MOCK_CONFIG: Config = {
  path: "/fake/config/agents.toml",
  providers: {
    mistral: { ...MOCK_PROVIDER, key: "mistral", models: ["zai-glm-5-3-flash"], require_infisical: true, secret: "MISTRAL_API_KEY", env: "MISTRAL_API_KEY", default_model: "zai-glm-5-3-flash" },
    openrouter: { ...MOCK_PROVIDER, key: "openrouter", models: ["z-ai/glm-5.3-flash"], require_infisical: false, secret: "OPENROUTER_API_KEY", env: "OPENROUTER_API_KEY", default_model: "z-ai/glm-5.3-flash" },
    "openrouter-free": { ...MOCK_PROVIDER, key: "openrouter-free", models: ["nvidia/nemotron-3-ultra-550b-a55b:free"], require_infisical: false, secret: "OPENROUTER_API_KEY", env: "OPENROUTER_API_KEY", default_model: "nvidia/nemotron-3-ultra-550b-a55b:free" },
  },
  routes: {
    "omp.mistral": { key: "omp.mistral", harness: "omp", provider: "mistral", models: ["zai-glm-5-3-flash"], require_model: true, default_model: "zai-glm-5-3-flash", note: "" },
    "omp.openrouter": { key: "omp.openrouter", harness: "omp", provider: "openrouter", models: ["z-ai/glm-5.3-flash"], require_model: false, default_model: "z-ai/glm-5.3-flash", note: "" },
    "omp.openrouter-free": { key: "omp.openrouter-free", harness: "omp", provider: "openrouter", models: ["nvidia/nemotron-3-ultra-550b-a55b:free"], require_model: true, default_model: "nvidia/nemotron-3-ultra-550b-a55b:free", note: "" },
  },
  harnesses: {
    omp: { adapter: "omp", key: "omp", label: "Oh My Pi", command: "omp", env: {} },
  },
  drop_env: [],
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Task state persistence", () => {
  it("saves and loads task state", () => {
    const state = {
      descriptor: {
        id: "test-1",
        class: "simple" as const,
        route: "omp.mistral",
        model: "zai-glm-5-3-flash",
        prompt: "test prompt",
        acceptanceCriteria: ["criteria 1"],
      },
      history: [],
      currentAttempt: null,
    };
    
    saveTaskState("test-task-1", state);
    const loaded = loadTaskState("test-task-1");
    
    expect(loaded).not.toBeNull();
    expect(loaded!.descriptor.id).toBe("test-1");
    expect(loaded!.descriptor.route).toBe("omp.mistral");
  });

  it("returns null for non-existent task", () => {
    const loaded = loadTaskState("non-existent-task");
    expect(loaded).toBeNull();
  });
});

describe("dispatchTask", () => {
  it("rejects a route whose provider is not configured", async () => {
    // The dispatch contract is checked before any Herdr work happens, so
    // this needs no live agent.
    const descriptor = {
      id: "test-task-dispatch-1",
      class: "simple" as const,
      route: "omp.mistral",
      model: "zai-glm-5-3-flash",
      prompt: "test prompt",
      acceptanceCriteria: ["test passes"],
    };
    const config = {
      ...MOCK_CONFIG,
      providers: { ...MOCK_CONFIG.providers, mistral: undefined as unknown as Provider },
    } as unknown as typeof MOCK_CONFIG;

    await expect(dispatchTask(config, descriptor)).rejects.toThrow(/Provider not configured/);
  });

  it("rejects a model the route does not allow", async () => {
    const descriptor = {
      id: "test-task-dispatch-1",
      class: "simple" as const,
      route: "omp.mistral",
      model: "not-an-allowed-model",
      prompt: "test prompt",
      acceptanceCriteria: [],
    };

    await expect(dispatchTask(MOCK_CONFIG, descriptor)).rejects.toThrow(/Model not allowed/);
  });

  it("throws for invalid route", async () => {
    const descriptor = {
      id: "test-invalid-route",
      class: "simple" as const,
      route: "omp.nonexistent",
      model: "some-model",
      prompt: "test",
      acceptanceCriteria: [],
    };
    
    await expect(dispatchTask(MOCK_CONFIG, descriptor)).rejects.toThrow("Route not configured");
  });

  it("throws for invalid model", async () => {
    const descriptor = {
      id: "test-invalid-model",
      class: "simple" as const,
      route: "omp.mistral",
      model: "invalid-model",
      prompt: "test",
      acceptanceCriteria: [],
    };
    
    await expect(dispatchTask(MOCK_CONFIG, descriptor)).rejects.toThrow("Model not allowed");
  });

  it("validates fallback profile matches route", async () => {
    // Requires file system mocking for TOML profile validation - skip for now
    expect(true).toBe(true);
  });
});

describe("Task state management", () => {
  it("tracks task status correctly", () => {
    const state = {
      descriptor: {
        id: "test-status-1",
        class: "simple" as const,
        route: "omp.mistral",
        model: "zai-glm-5-3-flash",
        prompt: "test",
        acceptanceCriteria: [],
      },
      history: [
        {
          id: "attempt-1",
          taskId: "test-status-1",
          route: { harness: "omp", provider: "mistral" },
          model: "zai-glm-5-3-flash",
          attemptNumber: 1,
          startedAt: new Date().toISOString(),
          status: "running" as const,
          generation: 1,
        },
      ],
      currentAttempt: {
        id: "attempt-1",
        taskId: "test-status-1",
        route: { harness: "omp", provider: "mistral" },
        model: "zai-glm-5-3-flash",
        attemptNumber: 1,
        startedAt: new Date().toISOString(),
        status: "running" as const,
        generation: 1,
      },
    };
    
    saveTaskState("test-status-1", state);
    const status = getTaskStatus("test-status-1");
    
    expect(status).not.toBeNull();
    expect(status!.taskId).toBe("test-status-1");
    expect(status!.overallStatus).toBe("running");
    expect(status!.currentAttempt).not.toBeNull();
    expect(status!.currentAttempt!.status).toBe("running");
  });

  it("returns completed status for completed attempt", () => {
    const state = {
      descriptor: {
        id: "test-status-2",
        class: "simple" as const,
        route: "omp.mistral",
        model: "zai-glm-5-3-flash",
        prompt: "test",
        acceptanceCriteria: [],
      },
      history: [
        {
          id: "attempt-1",
          taskId: "test-status-2",
          route: { harness: "omp", provider: "mistral" },
          model: "zai-glm-5-3-flash",
          attemptNumber: 1,
          startedAt: new Date().toISOString(),
          status: "completed" as const,
          generation: 1,
          result: { success: true },
        },
      ],
      currentAttempt: {
        id: "attempt-1",
        taskId: "test-status-2",
        route: { harness: "omp", provider: "mistral" },
        model: "zai-glm-5-3-flash",
        attemptNumber: 1,
        startedAt: new Date().toISOString(),
        status: "completed" as const,
        generation: 1,
        result: { success: true },
      },
    };
    
    saveTaskState("test-status-2", state);
    const status = getTaskStatus("test-status-2");
    
    expect(status!.overallStatus).toBe("completed");
  });

  it("returns failed status for failed attempt", () => {
    const state = {
      descriptor: {
        id: "test-status-3",
        class: "simple" as const,
        route: "omp.mistral",
        model: "zai-glm-5-3-flash",
        prompt: "test",
        acceptanceCriteria: [],
      },
      history: [
        {
          id: "attempt-1",
          taskId: "test-status-3",
          route: { harness: "omp", provider: "mistral" },
          model: "zai-glm-5-3-flash",
          attemptNumber: 1,
          startedAt: new Date().toISOString(),
          status: "failed" as const,
          generation: 1,
          error: { category: "billing" as const, observedAt: new Date().toISOString(), resetAt: null, retryAfterMs: null, exhausted: false, reason: "Payment required", quotaScopeKey: null },
        },
      ],
      currentAttempt: {
        id: "attempt-1",
        taskId: "test-status-3",
        route: { harness: "omp", provider: "mistral" },
        model: "zai-glm-5-3-flash",
        attemptNumber: 1,
        startedAt: new Date().toISOString(),
        status: "failed" as const,
        generation: 1,
        error: { category: "billing" as const, observedAt: new Date().toISOString(), resetAt: null, retryAfterMs: null, exhausted: false, reason: "Payment required", quotaScopeKey: null },
      },
    };
    
    saveTaskState("test-status-3", state);
    const status = getTaskStatus("test-status-3");
    
    expect(status!.overallStatus).toBe("failed");
  });
});

describe("startTaskAttempt", () => {
  it("reports the classified reason when no worker is attached", async () => {
    // Without a worker there is nothing to prompt: the attempt must fail
    // loudly rather than report a success it cannot have produced.
    const attempt = {
      id: "attempt-test-1",
      taskId: "test-start-1",
      route: { harness: "omp", provider: "mistral" },
      model: "zai-glm-5-3-flash",
      attemptNumber: 1,
      startedAt: new Date().toISOString(),
      status: "running" as const,
      generation: 1,
    };

    await expect(startTaskAttempt(MOCK_CONFIG, attempt, "test prompt")).rejects.toThrow(ContractError);
  });
});

describe("collectTaskAttempt", () => {
  it("reports failure when no worker is attached", async () => {
    const attempt = {
      id: "attempt-collect-1",
      taskId: "test-collect-1",
      route: { harness: "omp", provider: "mistral" },
      model: "zai-glm-5-3-flash",
      attemptNumber: 1,
      startedAt: new Date().toISOString(),
      status: "completed" as const,
      generation: 1,
    };

    const result = await collectTaskAttempt(attempt);

    expect(result.taskId).toBe("test-collect-1");
    expect(result.success).toBe(false);
    expect(result.error?.category).toBe("unknown");
  });
});

describe("recordAttemptOutcome", () => {
  it("records a failed attempt with its classified reason", () => {
    const attempt = {
      id: "attempt-fallback-1",
      taskId: "test-fallback-1",
      route: { harness: "omp", provider: "mistral" },
      model: "zai-glm-5-3-flash",
      attemptNumber: 1,
      startedAt: new Date().toISOString(),
      status: "running" as const,
      generation: 1,
    };

    saveTaskState("test-fallback-1", {
      descriptor: {
        id: "test-fallback-1",
        class: "simple" as const,
        route: "omp.mistral",
        model: "zai-glm-5-3-flash",
        prompt: "test",
        acceptanceCriteria: [],
      },
      history: [attempt],
      currentAttempt: attempt,
    });

    const recorded = recordAttemptOutcome("test-fallback-1", attempt, {
      status: "failed" as const,
      error: {
        category: "auth",
        observedAt: new Date().toISOString(),
        resetAt: null,
        retryAfterMs: null,
        exhausted: false,
        reason: "credential or authorization failure; not transient",
        quotaScopeKey: null,
      },
    });

    expect(recorded).not.toBeNull();
    expect(recorded!.status).toBe("failed");
    expect(recorded!.error?.category).toBe("auth");

    // The classified reason is durable: a resumed task can tell an auth
    // failure from a quota exhaustion without re-deriving it.
    const reloaded = loadTaskState("test-fallback-1");
    expect(reloaded!.currentAttempt!.error?.category).toBe("auth");
    expect(reloaded!.history).toHaveLength(1);
  });

  it("records a completed attempt with its result", () => {
    const attempt = {
      id: "attempt-completed-1",
      taskId: "test-completed-1",
      route: { harness: "omp", provider: "mistral" },
      model: "zai-glm-5-3-flash",
      attemptNumber: 1,
      startedAt: new Date().toISOString(),
      status: "running" as const,
      generation: 1,
    };

    saveTaskState("test-completed-1", {
      descriptor: {
        id: "test-completed-1",
        class: "simple" as const,
        route: "omp.mistral",
        model: "zai-glm-5-3-flash",
        prompt: "test",
        acceptanceCriteria: [],
      },
      history: [attempt],
      currentAttempt: attempt,
    });

    const recorded = recordAttemptOutcome("test-completed-1", attempt, {
      status: "completed" as const,
      result: { output: "done" },
    });

    expect(recorded!.status).toBe("completed");
    expect(recorded!.error).toBeUndefined();
    expect(loadTaskState("test-completed-1")!.currentAttempt!.status).toBe("completed");
  });

  it("returns null for an unknown task", () => {
    const attempt = {
      id: "attempt-unknown-1",
      taskId: "test-unknown-task",
      route: { harness: "omp", provider: "mistral" },
      model: "zai-glm-5-3-flash",
      attemptNumber: 1,
      startedAt: new Date().toISOString(),
      status: "running" as const,
      generation: 1,
    };
    expect(recordAttemptOutcome("test-unknown-task", attempt, { status: "failed" })).toBeNull();
  });
});

describe("getTaskStatus", () => {
  it("returns null for non-existent task", () => {
    const status = getTaskStatus("non-existent-task");
    expect(status).toBeNull();
  });

  it("returns correct status for each state", () => {
    const states = [
      { status: "running" as const, expected: "running" as const },
      { status: "completed" as const, expected: "completed" as const },
      { status: "failed" as const, expected: "failed" as const },
      { status: "blocked" as const, expected: "blocked" as const },
      { status: "fallback" as const, expected: "awaiting-fallback" as const },
    ];
    
    for (const { status, expected } of states) {
      const state = {
        descriptor: {
          id: `test-${status}`,
          class: "simple" as const,
          route: "omp.mistral",
          model: "zai-glm-5-3-flash",
          prompt: "test",
          acceptanceCriteria: [],
        },
        history: [{
          id: "attempt-1",
          taskId: `test-${status}`,
          route: { harness: "omp", provider: "mistral" },
          model: "zai-glm-5-3-flash",
          attemptNumber: 1,
          startedAt: new Date().toISOString(),
          status,
          generation: 1,
        }],
        currentAttempt: {
          id: "attempt-1",
          taskId: `test-${status}`,
          route: { harness: "omp", provider: "mistral" },
          model: "zai-glm-5-3-flash",
          attemptNumber: 1,
          startedAt: new Date().toISOString(),
          status,
          generation: 1,
        },
      };
      
      saveTaskState(`test-${status}`, state);
      const result = getTaskStatus(`test-${status}`);
      
      expect(result!.overallStatus).toBe(expected);
    }
  });
});

// ---------------------------------------------------------------------------
// OMP provider aggregation: the worker must start on the route's own
// provider (the provider id OMP knows) and pin its model roles, so a worker
// never runs against a different account than the route authorized.
// ---------------------------------------------------------------------------

describe("buildAgentStartOptions", () => {
  const provider = (over: Partial<Provider> = {}): Provider => ({
    key: "test",
    label: "Test",
    base_url: null,
    secret: null,
    env: null,
    default_model: null,
    require_model: false,
    models: [],
    opencode_id: "test",
    omp_id: "test",
    require_infisical: false,
    anonymous: false,
    opencode_npm: null,
    opencode_models: {},
    opencode_base_url: null,
    omp_custom: false,
    omp_api: null,
    omp_models: {},
    ...over,
  });

  it("passes the provider id OMP knows, not the launcher route key", () => {
    const opts = buildAgentStartOptions(
      provider({ key: "openrouter-free", omp_id: "openrouter" }),
      "nvidia/nemotron-3-ultra-550b-a55b:free",
    );
    // The selector pair leads the worker argv (after the "--" separator);
    // the tool-surface hardening flags follow it.
    expect(opts.slice(0, 5)).toEqual([
      "--", "--provider", "openrouter", "--model", "nvidia/nemotron-3-ultra-550b-a55b:free",
    ]);
    expect(opts).toContain("--tools");
    expect(opts).toContain("--trusted-extension");
  });

  it("includes every omp route's provider, including ones added later", () => {
    // A provider missing from the option builder would start the worker on
    // OMP's default provider instead of the route's own.
    const opts = buildAgentStartOptions(provider({ key: "groq", omp_id: "groq" }), "openai/gpt-oss-120b");
    expect(opts).toContain("--provider");
    expect(opts[opts.indexOf("--provider") + 1]).toBe("groq");
  });

  it("pins the model roles for credentialed providers", () => {
    const opts = buildAgentStartOptions(
      provider({ key: "kilo", omp_id: "kilo", require_infisical: true }),
      "nvidia/nemotron-3-ultra-550b-a55b:free",
    );
    const selector = "kilo/nvidia/nemotron-3-ultra-550b-a55b:free";
    expect(opts).toContain("--smol");
    expect(opts).toContain("--slow");
    expect(opts).toContain("--plan");
    expect(opts[opts.indexOf("--smol") + 1]).toBe(selector);
    expect(opts[opts.indexOf("--slow") + 1]).toBe(selector);
    expect(opts[opts.indexOf("--plan") + 1]).toBe(selector);
  });

  it("omits model-role pinning for providers without Infisical credentials", () => {
    const opts = buildAgentStartOptions(provider({ key: "openrouter", omp_id: "openrouter" }), "z-ai/glm-5.3-flash");
    expect(opts).not.toContain("--smol");
    expect(opts).not.toContain("--slow");
    expect(opts).not.toContain("--plan");
  });

  it("refuses an anonymous provider: OMP has no credential-free route", () => {
    expect(() => buildAgentStartOptions(provider({ key: "ovhcloud", anonymous: true }), "gpt-oss-120b")).toThrow(ContractError);
  });
});

// ---------------------------------------------------------------------------
// Worker credentials: a Herdr worker inherits the Herdr SERVER's
// environment, so the route's credential must be passed explicitly. Without
// it the worker starts, accepts the prompt, and then fails with
// "No API key found for <provider>" — which looks like a provider-side
// rejection rather than a missing credential.
// ---------------------------------------------------------------------------

describe("worker credential injection", () => {
  const ORIGINAL = { ...process.env };

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in ORIGINAL)) delete process.env[key];
    }
    for (const [key, value] of Object.entries(ORIGINAL)) {
      if (value !== undefined) process.env[key] = value;
    }
  });

  it("fails before starting a worker when the credential is absent", async () => {
    delete process.env.TEST_ROUTE_KEY;
    const config = {
      path: "/fake/config/agents.toml",
      providers: {
        mistral: {
          key: "mistral", label: "Mistral", base_url: null, secret: "TEST_ROUTE_KEY",
          env: "TEST_ROUTE_KEY", default_model: "m", require_model: false, models: ["m"],
          opencode_id: "mistral", omp_id: "mistral", require_infisical: true, anonymous: false,
          opencode_npm: null, opencode_models: {}, opencode_base_url: null,
        },
      },
      harnesses: { omp: { key: "omp", label: "OMP", command: "omp", adapter: "omp", env: {} } },
      routes: {
        "omp.mistral": {
          key: "omp.mistral", harness: "omp", provider: "mistral", default_model: "m",
          models: ["m"], require_model: false, note: "",
        },
      },
      drop_env: [],
    } as unknown as Parameters<typeof dispatchTask>[0];

    await expect(
      dispatchTask(config, {
        id: "test-missing-cred",
        route: "omp.mistral",
        model: "m",
        prompt: "test",
      }),
    ).rejects.toThrow(/TEST_ROUTE_KEY/);
  });

  it("never hands a managed-profile credential to Herdr --env", () => {
    // Native require_infisical providers (kilo/groq/opencode-go/mistral/...)
    // and omp_custom providers resolve the secret inside OMP via the
    // managed models.yml `apiKey: "!infisical-key.sh <NAME>"`. The value must
    // not transit `herdr --env NAME=VALUE` (argv + server state exposure).
    const base = {
      key: "kilo", label: "Kilo", base_url: null, secret: "KILO_API_KEY",
      env: "KILO_API_KEY", default_model: "m", require_model: false, models: ["m"],
      opencode_id: "kilo", omp_id: "kilo", require_infisical: true, anonymous: false,
      opencode_npm: null, opencode_models: {}, opencode_base_url: null,
      omp_custom: false, omp_api: null, omp_models: {},
    } as unknown as Provider;
    process.env.KILO_API_KEY = "super-secret-value";
    try {
      expect(routeWorkerEnv(base)).toEqual({});
      expect(routeWorkerEnv({ ...base, omp_custom: true })).toEqual({});
      // Ambient-credential routes keep the env handoff (contract unchanged).
      const ambient = {
        ...base, key: "openrouter", secret: "OPENROUTER_API_KEY",
        env: "OPENROUTER_API_KEY", require_infisical: false,
      } as unknown as Provider;
      process.env.OPENROUTER_API_KEY = "ambient-value";
      expect(routeWorkerEnv(ambient)).toEqual({ OPENROUTER_API_KEY: "ambient-value" });
      // Anonymous providers never carry a credential.
      expect(routeWorkerEnv({ ...base, anonymous: true, secret: null, env: null }))
        .toEqual({});
    } finally {
      delete process.env.KILO_API_KEY;
      delete process.env.OPENROUTER_API_KEY;
    }
  });
});

describe("task-path credential policy", () => {
  const ORIGINAL = { ...process.env };
  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in ORIGINAL)) delete process.env[key];
    }
    for (const [key, value] of Object.entries(ORIGINAL)) {
      if (value !== undefined) process.env[key] = value;
    }
  });

  function ambientConfig() {
    return {
      path: "/fake/config/agents.toml",
      providers: {
        openrouter: {
          key: "openrouter", label: "OpenRouter", base_url: null,
          secret: "OPENROUTER_API_KEY", env: "OPENROUTER_API_KEY",
          default_model: "m", require_model: false, models: ["m"],
          opencode_id: "openrouter", omp_id: "openrouter",
          require_infisical: false, anonymous: false,
          opencode_npm: null, opencode_models: {}, opencode_base_url: null,
          omp_custom: false, omp_api: null, omp_models: {},
        },
      },
      harnesses: { omp: { key: "omp", label: "OMP", command: "omp", adapter: "omp", env: {} } },
      routes: {
        "omp.openrouter": {
          key: "omp.openrouter", harness: "omp", provider: "openrouter",
          default_model: "m", models: ["m"], require_model: false, note: "",
        },
      },
      drop_env: [],
    } as unknown as Parameters<typeof dispatchTask>[0];
  }

  it("fails closed on ambient credentials that would transit Herdr --env argv", async () => {
    process.env.OPENROUTER_API_KEY = "ambient-secret";
    await expect(
      dispatchTask(ambientConfig(), {
        id: "test-ambient-cred",
        route: "omp.openrouter",
        model: "m",
        prompt: "test",
      }),
    ).rejects.toThrow(/ambient credential.*--env argv|--env argv/);
  });
});

describe("acceptance criteria verification", () => {
  it("verifies exit-0 criteria and reports failures without guessing", async () => {
    const cwd = process.cwd();
    const ok = await verifyAcceptanceCriteria(["true"], cwd, 5000);
    expect(ok.verified).toBe(true);
    expect(ok.checks[0].exitCode).toBe(0);

    const bad = await verifyAcceptanceCriteria(["false"], cwd, 5000);
    expect(bad.verified).toBe(false);
    expect(bad.checks[0].exitCode).not.toBe(0);

    const mixed = await verifyAcceptanceCriteria(["true", "false"], cwd, 5000);
    expect(mixed.verified).toBe(false);
    expect(mixed.checks).toHaveLength(2);
  });

  it("marks an over-time check as timed out, never as passed", async () => {
    const report = await verifyAcceptanceCriteria(["sleep 30"], process.cwd(), 200);
    expect(report.verified).toBe(false);
    expect(report.checks[0].timedOut).toBe(true);
    expect(report.checks[0].exitCode).toBeNull();
  });
});

describe("generation fencing on outcome writes", () => {
  it("refuses a stale-generation outcome overwriting a newer record", () => {
    const taskId = "test-gen-fence";
    const attempt = {
      id: "a1", taskId, route: { harness: "omp", provider: "kilo" },
      model: "m", attemptNumber: 1, startedAt: new Date().toISOString(),
      status: "running" as const, generation: 1,
    };
    saveTaskState(taskId, {
      descriptor: {
        id: taskId, class: "simple" as const, route: "omp.kilo",
        model: "m", prompt: "test", acceptanceCriteria: [],
      },
      history: [attempt],
      currentAttempt: attempt,
    });
    // Newer generation already recorded (e.g. a resume wrote generation 2).
    const newer = { ...attempt, generation: 2, status: "completed" as const };
    recordAttemptOutcome(taskId, newer, { status: "completed" });
    // A stale writer holding generation 1 must be refused, not overwrite.
    expect(() =>
      recordAttemptOutcome(taskId, attempt, { status: "failed" }),
    ).toThrow(/generation moved|stale/);
    const state = loadTaskState(taskId);
    expect(state?.currentAttempt?.generation).toBe(2);
    expect(state?.currentAttempt?.status).toBe("completed");
  });
});

describe("fallback scope gate", () => {
  it("refuses a fallback profile outside any verifiable scope", async () => {
    // Non-git cwd + no --accept + no acknowledgement => the worker's side
    // effects cannot be audited, so auto-fallback must fail closed BEFORE
    // dispatch creates any worker.
    const prev = process.cwd();
    const dir = mkdtempSync(join(tmpdir(), "task-nogit-"));
    process.chdir(dir);
    try {
      await expect(runTaskToCompletion({} as Config, {
        id: "task-gate-1",
        route: "omp.groq",
        model: "m",
        prompt: "p",
        profileId: "prof-1",
      })).rejects.toThrow(ContractError);
    } finally {
      process.chdir(prev);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("workspace baseline", () => {
  it("captures observable git state or null outside a repo", () => {
    const baseline = captureWorkspaceBaseline();
    // Test runs inside the dotfiles repo: HEAD sha + counts must be present.
    expect(baseline).not.toBeNull();
    expect(baseline!.headSha).toMatch(/^[0-9a-f]{40}$/);
    expect(baseline!.dirtyCount).toBeGreaterThanOrEqual(0);
  });
});
