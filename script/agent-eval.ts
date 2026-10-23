#!/usr/bin/env bun
/** Explicit, slow evaluator. No evaluation traffic or transport runs on ordinary launch. */
import { createHash, randomUUID } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { normalizeCatalog, freeIneligibleReason } from "./agent-catalog";
import { parseHarnessVersion } from "./agent-harness-version";
import { dirname, join, resolve } from "node:path";
import {
  EVALUATION_FIXTURE,
  EVALUATION_VERSION,
  evaluationFixtureDigest,
} from "./agent-eval-fixture";
export { EVALUATION_VERSION };
export const fixtureDigest = evaluationFixtureDigest;
const MAX_OUTPUT = 8 * 1024 * 1024;
const ALLOWED = new Set(["src/catalog.ts", "src/pricing.ts", "src/reserve.ts"]);
type FailureKind = "capability" | "api" | "quota" | "auth" | "launcher";
export function quotaRemaining(body: any): number | null {
  const q = body?.data?.free_model_daily_requests;
  if (
    !q ||
    ![q.used, q.limit, q.remaining].every(Number.isSafeInteger) ||
    q.used < 0 ||
    q.limit < 0 ||
    q.remaining !== q.limit - q.used
  )
    return null;
  return Math.max(0, q.remaining);
}
export function parseEvaluationArgs(args: string[]) {
  const harness = args[0];
  if (!["quota", "claude", "pi", "opencode"].includes(harness))
    throw new Error(
      "evaluate requires quota or claude|pi|opencode --model <id:free>",
    );
  const result = {
    harness,
    model: "",
    trials: 1,
    maxRequests: 12,
    timeout: 180,
  };
  const seen = new Set<string>();
  for (let i = 1; i < args.length; i += 2) {
    const key = args[i],
      value = args[i + 1];
    if (seen.has(key) || value === undefined)
      throw new Error(`invalid evaluation option ${key}`);
    seen.add(key);
    if (key === "--model") result.model = value;
    else {
      const field = (
        {
          "--trials": "trials",
          "--max-requests": "maxRequests",
          "--timeout": "timeout",
        } as const
      )[key];
      if (!field) throw new Error(`unknown evaluation option ${key}`);
      const n = Number(value);
      const max =
        field === "trials" ? 10 : field === "maxRequests" ? 100 : 1800;
      if (!Number.isSafeInteger(n) || n < 1 || n > max)
        throw new Error(`invalid ${key}`);
      result[field] = n;
    }
  }
  if (
    harness !== "quota" &&
    !/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.:/-]+:free$/.test(result.model)
  )
    throw new Error(
      "evaluation requires an explicit provider/model:free ID; routers and paid models are excluded",
    );
  if (result.maxRequests < result.trials)
    throw new Error(
      "--max-requests must permit at least one request per trial",
    );
  return result;
}
export function isolatedEnvironment(
  home: string,
  source: Record<string, string | undefined> = process.env,
): Record<string, string> {
  const env: Record<string, string> = {
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_CACHE_HOME: join(home, ".cache"),
    XDG_DATA_HOME: join(home, ".local/share"),
    XDG_STATE_HOME: join(home, ".local/state"),
    PI_CODING_AGENT_DIR: join(home, ".pi/agent"),
    PI_OFFLINE: "1",
    PI_TELEMETRY: "0",
    CLAUDE_CONFIG_DIR: join(home, ".claude"),
    CLAUDE_CODE_MAX_RETRIES: "0",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    DO_NOT_TRACK: "1",
    NO_COLOR: "1",
  };
  for (const key of [
    "PATH",
    "SystemRoot",
    "SYSTEMROOT",
    "COMSPEC",
    "PATHEXT",
    "TEMP",
    "TMP",
    "LANG",
  ])
    if (source[key]) env[key] = source[key]!;
  return env;
}
function snapshot(root: string, prefix = ""): Record<string, string> {
  const found: Record<string, string> = {};
  for (const entry of readdirSync(join(root, prefix), {
    withFileTypes: true,
  })) {
    const name = prefix + entry.name;
    const path = join(root, name);
    if (entry.isSymbolicLink()) found[name] = "SYMLINK";
    else if (entry.isDirectory()) {
      found[name + "/"] = "DIR";
      Object.assign(found, snapshot(root, name + "/"));
    } else if (entry.isFile())
      found[name] = createHash("sha256")
        .update(readFileSync(path))
        .digest("hex");
    else found[name] = "SPECIAL";
  }
  return found;
}
export function prepareFixture(root: string) {
  cpSync(join(EVALUATION_FIXTURE, "workspace"), root, { recursive: true });
  renameSync(
    join(root, "public.test.ts.template"),
    join(root, "public.test.ts"),
  );
  return snapshot(root);
}
/** Drop Pi's repeated partial message snapshots as they arrive, keeping final evidence. */
export async function collectProcessOutput(
  stream: ReadableStream<Uint8Array>,
  eventStream = false,
  onOverflow?: () => void,
) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let output = "",
    pending = "",
    rawBytes = 0,
    retainedBytes = 0,
    overflow = false;
  const retain = (line: string) => {
    if (eventStream) {
      try {
        const event = JSON.parse(line);
        if (["message_update", "tool_execution_update"].includes(event.type))
          return;
      } catch {}
    }
    retainedBytes += Buffer.byteLength(line);
    if (retainedBytes > MAX_OUTPUT) {
      overflow = true;
      return;
    }
    output += line;
  };
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    rawBytes += value.length;
    if (rawBytes > (eventStream ? 128 * 1024 * 1024 : MAX_OUTPUT)) {
      overflow = true;
      break;
    }
    const text = decoder.decode(value, { stream: true });
    if (!eventStream) retain(text);
    else {
      pending += text;
      let end: number;
      while ((end = pending.indexOf("\n")) !== -1) {
        retain(pending.slice(0, end + 1));
        pending = pending.slice(end + 1);
        if (overflow) break;
      }
      if (Buffer.byteLength(pending) > MAX_OUTPUT) overflow = true;
    }
    if (overflow) break;
  }
  if (!overflow) {
    pending += decoder.decode();
    if (pending) retain(pending);
  }
  if (overflow) {
    onOverflow?.();
    await reader.cancel();
  }
  return { output, overflow, rawBytes };
}
async function boundedProcess(
  command: string[],
  cwd: string,
  env: Record<string, string>,
  timeout: number,
  signal?: AbortSignal,
  eventStream = false,
) {
  const child = Bun.spawn(command, {
    cwd,
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    detached: process.platform !== "win32",
  });
  let timedOut = false,
    overflow = false;
  const kill = () => {
    try {
      if (process.platform === "win32")
        Bun.spawn(["taskkill", "/PID", String(child.pid), "/T", "/F"], {
          stdout: "ignore",
          stderr: "ignore",
        });
      else process.kill(-child.pid, "SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
  };
  const timer = setTimeout(() => {
    timedOut = true;
    kill();
  }, timeout * 1000);
  signal?.addEventListener("abort", kill, { once: true });
  if (signal?.aborted) kill();
  async function read(stream: ReadableStream<Uint8Array>, events = false) {
    const result = await collectProcessOutput(stream, events, () => {
      overflow = true;
      kill();
    });
    return result.output;
  }
  try {
    const [stdout, stderr, code] = await Promise.all([
      read(child.stdout, eventStream),
      read(child.stderr),
      child.exited,
    ]);
    return { stdout, stderr, code, timedOut, overflow };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", kill);
  }
}
export async function gradeFixture(
  root: string,
  before: Record<string, string>,
) {
  const after = snapshot(root);
  const integrityPassed = Object.keys({ ...before, ...after }).every((path) =>
    ALLOWED.has(path)
      ? after[path] !== undefined &&
        !["SYMLINK", "SPECIAL", "DIR"].includes(after[path])
      : before[path] === after[path],
  );
  if (!integrityPassed)
    return {
      integrityPassed: false,
      publicPassed: false,
      hiddenPassed: false,
      success: false,
    };
  const env = isolatedEnvironment(join(root, "..", "grade-home"));
  const publicResult = await boundedProcess(
    [process.execPath, "test", "public.test.ts"],
    root,
    env,
    20,
  );
  const nonce = randomUUID();
  env.AGENT_EVAL_GRADE_NONCE = nonce;
  const hiddenResult = await boundedProcess(
    [process.execPath, join(EVALUATION_FIXTURE, "grade.ts"), root],
    root,
    env,
    20,
  );
  const publicPassed =
    publicResult.code === 0 &&
    !publicResult.timedOut &&
    !publicResult.overflow &&
    /(?:^|\n)\s*3 pass\s*(?:\n)/.test(publicResult.stderr) &&
    /(?:^|\n)\s*0 fail\s*(?:\n)/.test(publicResult.stderr);
  const hiddenPassed =
    hiddenResult.code === 0 &&
    !hiddenResult.timedOut &&
    !hiddenResult.overflow &&
    hiddenResult.stdout.trim() === nonce + ":external-checks-passed";
  return {
    integrityPassed,
    publicPassed,
    hiddenPassed,
    success: publicPassed && hiddenPassed,
  };
}
export function observeTranscript(
  harness: string,
  output: string,
  expected: string,
) {
  const models = new Set<string>();
  const calls = new Set<string>();
  const tests = new Set<string>();
  let toolFailures = 0;
  let completed = false;
  let debuggedPublicRegression = false;
  let finalTestPassed = false;
  const testResult = (id: string, error: boolean) => {
    if (tests.has(id)) {
      if (error && !debuggedPublicRegression) {
        debuggedPublicRegression = true;
        toolFailures = Math.max(0, toolFailures - 1);
      }
      finalTestPassed = !error;
    }
  };
  for (const line of output.split("\n")) {
    let event: any;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    const message = event.message;
    if (message?.role === "assistant" || event.type === "assistant") {
      if (typeof message?.model === "string") models.add(message.model);
      for (const content of message?.content ?? [])
        if (["tool_use", "toolCall"].includes(content.type)) {
          const id = content.id ?? JSON.stringify(content);
          calls.add(id);
          const command = (content.input ?? content.arguments)?.command;
          if (
            ["Bash", "bash"].includes(content.name) &&
            typeof command === "string" &&
            /^bun\s+test(?:\s+public\.test\.ts)?$/.test(command.trim())
          )
            tests.add(id);
        }
    }
    if (event.type === "tool_execution_start")
      calls.add(event.toolCallId ?? JSON.stringify(event));
    if (event.type === "tool_use") {
      const id = event.part?.callID ?? JSON.stringify(event);
      calls.add(id);
      const state = event.part?.state;
      if (
        event.part?.tool === "bash" &&
        /^bun\s+test(?:\s+public\.test\.ts)?$/.test(
          (state?.input?.command ?? "").trim(),
        )
      )
        tests.add(id);
      if (state?.status === "error") toolFailures++;
      if (["error", "completed"].includes(state?.status))
        testResult(
          id,
          state.status === "error" || (state.metadata?.exit ?? 0) !== 0,
        );
    }
    if (event.type === "tool_execution_end") {
      if (event.isError) toolFailures++;
      testResult(event.toolCallId, event.isError === true);
    }

    if (event.type === "user")
      for (const part of message?.content ?? [])
        if (part.type === "tool_result") {
          if (part.is_error) toolFailures++;
          testResult(part.tool_use_id, part.is_error === true);
        }
    if (
      (harness === "claude" &&
        event.type === "result" &&
        event.subtype === "success") ||
      (harness === "pi" && event.type === "agent_end") ||
      (harness === "opencode" && event.type === "step_finish")
    )
      completed = true;
  }
  return {
    observedModel: models.size === 1 ? [...models][0] : null,
    modelMismatch: [...models].some((model) => model !== expected),
    toolCalls: calls.size,
    toolFailures,
    completed,
    debuggedPublicRegression,
    finalTestPassed,
  };
}
async function limitedResponseText(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const decoder = new TextDecoder();
  let size = 0,
    output = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > MAX_OUTPUT) {
      await reader.cancel();
      throw new Error("response too large");
    }
    output += decoder.decode(value, { stream: true });
  }
  return output + decoder.decode();
}
interface GuardOptions {
  model: string;
  apiKey: string;
  maxRequests: number;
  fetch?: typeof fetch;
  catalog?: unknown;
  minIntervalMs?: number;
}
export function createRequestGuard(options: GuardOptions) {
  let controller = new AbortController();
  let nextRequestAt = Date.now() + (options.minIntervalMs ?? 3100);
  let requests = 0;
  let trialRequests = 0;
  let trialBudget = options.maxRequests;
  let budgetExhausted: "trial" | "aggregate" | null = null;
  const modelObservations: Array<{ request: number; model: string }> = [];
  let failureKind: FailureKind | null = null;
  let failureReason: string | null = null;
  let failureDetails: Record<string, unknown> | null = null;
  const diagnostic = (value: unknown, max: number): string | null =>
    typeof value === "string"
      ? redactedLog(value.split(options.apiKey).join("[REDACTED]")).slice(
          0,
          max,
        )
      : null;
  const apiError = (status: number, error: any, retryAfter: string | null) => {
    const scalar = (value: unknown, max: number) =>
      typeof value === "number" && Number.isFinite(value)
        ? value
        : diagnostic(value, max);
    failureDetails = {
      http_status: status,
      code: scalar(error?.code ?? error?.status, 40),
      message: diagnostic(error?.message, 400),
      provider_code: scalar(error?.metadata?.provider_code, 80),
      retry_after: scalar(error?.metadata?.retry_after ?? retryAfter, 40),
    };
    failureReason = (
      "OpenRouter API error: " + JSON.stringify(failureDetails)
    ).slice(0, 800);
  };
  const observedModels = new Set<string>();
  const fail = (kind: FailureKind, reason: string, status = 429) => {
    failureKind ??= kind;
    failureReason ??= reason;
    controller.abort();
    return Response.json(
      { error: { message: reason, type: "evaluation_guard" } },
      { status },
    );
  };
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 255,
    maxRequestBodySize: MAX_OUTPUT,
    async fetch(request) {
      const url = new URL(request.url);
      if (
        request.method === "GET" &&
        url.pathname === "/api/v1/models" &&
        options.catalog
      )
        return Response.json(options.catalog);
      if (
        request.method !== "POST" ||
        !["/api/v1/messages", "/api/v1/chat/completions"].includes(url.pathname)
      )
        return fail("launcher", "unsupported evaluation endpoint", 400);
      if (failureKind) return fail(failureKind, failureReason!);
      let body: any;
      try {
        body = await request.json();
      } catch {
        return fail("launcher", "invalid request JSON", 400);
      }
      if (
        body.model !== options.model ||
        "models" in body ||
        "route" in body ||
        "plugins" in body ||
        (body.tools !== undefined && !Array.isArray(body.tools)) ||
        body.tools?.some(
          (tool: any) => !["function", "custom", undefined].includes(tool.type),
        )
      ) {
        return Response.json(
          {
            error: {
              message:
                "evaluation model and ordinary coding tools must remain pinned",
            },
          },
          { status: 400 },
        );
      }
      if (requests >= options.maxRequests) {
        budgetExhausted = "aggregate";
        return fail(
          "launcher",
          "evaluation aggregate request budget exhausted",
        );
      }
      if (trialRequests >= trialBudget) {
        budgetExhausted = "trial";
        return fail(
          "launcher",
          "evaluation per-trial request budget exhausted",
        );
      }
      requests++;
      trialRequests++;
      const requestNo = requests;
      const requestController = controller;
      const scheduledAt = Math.max(Date.now(), nextRequestAt);
      nextRequestAt = scheduledAt + (options.minIntervalMs ?? 3100);
      const delay = scheduledAt - Date.now();
      if (delay > 0)
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, delay);
          requestController.signal.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              resolve();
            },
            { once: true },
          );
        });
      if (requestController.signal.aborted)
        return Response.json(
          { error: { message: "evaluation trial cancelled" } },
          { status: 499 },
        );
      if (controller.signal.aborted)
        return fail(
          failureKind ?? "launcher",
          failureReason ?? "evaluation stopped",
        );
      // Fix provider routing as well: no fallback to another model/provider path and no paid add-ons.
      body.provider = { ...(body.provider ?? {}), allow_fallbacks: false };
      const headers = new Headers({
        "content-type": "application/json",
        authorization: `Bearer ${options.apiKey}`,
      });
      for (const name of ["anthropic-version", "anthropic-beta", "accept"]) {
        const value = request.headers.get(name);
        if (value) headers.set(name, value);
      }
      try {
        const response = await (options.fetch ?? fetch)(
          `https://openrouter.ai${url.pathname}`,
          {
            method: "POST",
            headers,
            body: JSON.stringify(body),
            redirect: "error",
            signal: AbortSignal.any([
              requestController.signal,
              AbortSignal.timeout(180000),
            ]),
          },
        );
        if ([401, 403, 429].includes(response.status)) {
          failureKind = response.status === 429 ? "quota" : "auth";
          failureReason = `OpenRouter HTTP ${response.status}; evaluation stopped`;
        } else if (!response.ok) {
          failureKind = "api";
          failureReason = `OpenRouter HTTP ${response.status}; evaluation stopped`;
        }
        const raw = await limitedResponseText(response);
        if (raw.length > MAX_OUTPUT)
          return fail(
            "api",
            "upstream response exceeded evaluation limit",
            502,
          );
        const records = [
          raw,
          ...raw
            .split("\n")
            .map((line) => (line.startsWith("data: ") ? line.slice(6) : line)),
        ];
        for (const record of records) {
          try {
            const parsed = JSON.parse(record);
            if (parsed.error) {
              const code = parsed.error.code ?? parsed.error.status;
              failureKind =
                Number(code) === 429
                  ? "quota"
                  : [401, 403].includes(Number(code))
                    ? "auth"
                    : "api";
              apiError(
                response.status,
                parsed.error,
                response.headers.get("retry-after"),
              );
              controller.abort();
            }
            for (const model of [parsed.model, parsed.message?.model])
              if (typeof model === "string") {
                observedModels.add(model);
                modelObservations.push({ request: requestNo, model });
              }
          } catch {}
        }
        if (failureKind) {
          if (!failureDetails)
            apiError(
              response.status,
              null,
              response.headers.get("retry-after"),
            );
          controller.abort();
        }
        if ([...observedModels].some((model) => model !== options.model))
          return fail(
            "api",
            "actual API model differed from requested model",
            502,
          );
        return new Response(raw.split(options.apiKey).join("[REDACTED]"), {
          status: response.status,
          headers: {
            "content-type":
              response.headers.get("content-type") ?? "application/json",
          },
        });
      } catch {
        if (requestController.signal.aborted)
          return Response.json(
            { error: { message: "evaluation trial cancelled" } },
            { status: 499 },
          );
        return fail(
          "api",
          "OpenRouter transport failed; evaluation stopped",
          502,
        );
      }
    },
  });
  return {
    get signal() {
      return controller.signal;
    },
    beginTrial(budget: number) {
      if (!Number.isSafeInteger(budget) || budget < 1)
        throw new Error("invalid per-trial request budget");
      if (
        requests >= options.maxRequests ||
        (failureKind !== null && budgetExhausted === null)
      )
        return false;
      controller.abort();
      trialBudget = budget;
      trialRequests = 0;
      budgetExhausted = null;
      failureKind = null;
      failureReason = null;
      failureDetails = null;
      controller = new AbortController();
      return true;
    },
    get budgetExhausted() {
      return budgetExhausted;
    },
    url: `http://127.0.0.1:${server.port}`,
    get requests() {
      return requests;
    },
    get failureKind() {
      return failureKind;
    },
    get failureReason() {
      return failureReason;
    },
    get failureDetails() {
      return failureDetails;
    },
    get observedModels() {
      return [...observedModels];
    },
    modelsSince(request: number) {
      return [
        ...new Set(
          modelObservations
            .filter((observation) => observation.request > request)
            .map((observation) => observation.model),
        ),
      ];
    },
    endTrial() {
      controller.abort();
    },
    stop() {
      controller.abort();
      server.stop(true);
    },
  };
}

async function currentQuota(apiKey: string) {
  const response = await fetch("https://openrouter.ai/api/v1/key", {
    headers: { authorization: `Bearer ${apiKey}` },
    redirect: "error",
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok)
    throw new Error(`quota preflight failed: HTTP ${response.status}`);
  const remaining = quotaRemaining(await response.json());
  if (remaining === null)
    throw new Error(
      "quota preflight has no valid daily request counters; refusing inference",
    );
  return remaining;
}
async function availableCatalog(model: string) {
  const response = await fetch("https://openrouter.ai/api/v1/models", {
    redirect: "error",
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`official catalog HTTP ${response.status}`);
  const catalog: any = await response.json();
  const entry = normalizeCatalog(catalog.data).find(
    (entry) => entry.id === model,
  );
  const reason = entry
    ? freeIneligibleReason(entry, { min_context: 128000 }, Date.now())
    : "model absent from current catalog";
  if (reason)
    throw new Error("explicit evaluation model failed availability: " + reason);
  return catalog;
}
export function evaluationEvidencePath() {
  if (process.env.AGENT_QUALITY_FILE) return process.env.AGENT_QUALITY_FILE;
  const configPath =
    process.env.AGENT_CONFIG ??
    join(dirname(import.meta.dir), "config/agents.toml");
  const config = Bun.TOML.parse(readFileSync(configPath, "utf8")) as any;
  const configured = config.providers?.["openrouter-free"]?.quality_file;
  if (configured) return resolve(dirname(configPath), configured);
  const base =
    process.env.AGENT_CACHE_DIR ??
    join(
      process.platform === "win32"
        ? (process.env.LOCALAPPDATA ?? join(homedir(), "AppData/Local"))
        : (process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache")),
      "dotfiles-agent",
    );
  return join(base, "openrouter-free-quality.json");
}
function writePrivate(path: string, content: string) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, content, { mode: 0o600 });
}
function writeHarnessConfig(
  home: string,
  harness: string,
  baseUrl: string,
  model: string,
  catalog: any,
  env: Record<string, string>,
) {
  if (harness === "pi") {
    const entry = catalog.data.find((entry: any) => entry.id === model);
    writePrivate(
      join(home, ".pi/agent/models.json"),
      JSON.stringify({
        providers: {
          openrouter: {
            baseUrl: baseUrl + "/v1",
            api: "openai-completions",
            apiKey: "OPENROUTER_API_KEY",
            models: [
              {
                id: model,
                name: model,
                reasoning: false,
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: entry.context_length,
                maxTokens: Math.min(
                  entry.top_provider?.max_completion_tokens ?? 8192,
                  8192,
                ),
              },
            ],
          },
        },
      }),
    );
    writePrivate(
      join(home, ".pi/agent/settings.json"),
      JSON.stringify({
        retry: { enabled: false, maxRetries: 0, provider: { maxRetries: 0 } },
        compaction: { enabled: false },
        enableSkillCommands: false,
      }),
    );
  }
  if (harness === "opencode")
    env.OPENCODE_CONFIG_CONTENT = JSON.stringify({
      provider: {
        openrouter: {
          options: { baseURL: baseUrl + "/v1", apiKey: "evaluation-dummy" },
        },
      },
      plugin: [],
      mcp: {},
      autoupdate: false,
    });
}
function harnessArguments(harness: string, prompt: string): string[] {
  if (harness === "claude")
    return [
      "--bare",
      "--safe-mode",
      "--strict-mcp-config",
      "--mcp-config",
      '{"mcpServers":{}}',
      "--setting-sources",
      "",
      "--no-session-persistence",
      "--disable-slash-commands",
      "--no-chrome",
      "--tools",
      "Read,Edit,Write,Bash,Grep,Glob",
      "--allowedTools",
      "Read,Edit,Write,Bash,Grep,Glob",
      "--permission-mode",
      "bypassPermissions",
      "-p",
      prompt,
      "--output-format",
      "stream-json",
      "--verbose",
    ];
  if (harness === "pi")
    return [
      "--no-extensions",
      "--no-skills",
      "--no-prompt-templates",
      "--no-themes",
      "--no-context-files",
      "--offline",
      "--no-session",
      "--mode",
      "json",
      "--print",
      prompt,
    ];
  return ["run", "--standalone", "--format", "json", "--auto", prompt];
}
function publicBenchmarks(
  model: string,
): import("./agent-quality").Benchmark[] {
  const path = join(
    dirname(import.meta.dir),
    "config/openrouter-benchmarks.json",
  );
  if (!existsSync(path)) return [];
  const data = JSON.parse(readFileSync(path, "utf8"));
  return (data.benchmarks ?? [])
    .filter((entry: any) => entry.model_id === model)
    .map(({ model_id, ...entry }: any) => entry);
}
function redactedLog(text: string): string {
  for (const [name, value] of Object.entries(process.env))
    if (
      value &&
      value.length >= 4 &&
      /(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i.test(name)
    )
      text = text.split(value).join("[REDACTED]");
  return text
    .replace(/Bearer\s+[^\s"\\]+/gi, "Bearer [REDACTED]")
    .replace(/\bsk-[a-zA-Z0-9_-]{12,}/g, "[REDACTED]");
}
export async function evaluationMain(args: string[]): Promise<number> {
  try {
    if (args.length === 0 || ["help", "--help", "-h"].includes(args[0])) {
      console.log(
        "usage: agent evaluate quota | <claude|pi|opencode> --model <id:free> [--trials 1..10] [--max-requests 1..100] [--timeout seconds]\nDefault: 1 trial, 12 total HTTP inference attempts, 180 seconds per trial. No paid/router models, retry/fallback or parallel evaluation.",
      );
      return 0;
    }
    const options = parseEvaluationArgs(args);
    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) {
      const root = dirname(import.meta.dir);
      const wrapper =
        process.env.AGENT_WITH_SECRETS ??
        join(
          root,
          "script",
          process.platform === "win32" ? "with-secrets.ps1" : "with-secrets",
        );
      const cmd =
        process.platform === "win32"
          ? [
              "powershell.exe",
              "-NoProfile",
              "-File",
              wrapper,
              process.execPath,
              import.meta.path,
              "__injected",
              ...args,
            ]
          : [
              wrapper,
              process.execPath,
              import.meta.path,
              "__injected",
              ...args,
            ];
      const child = Bun.spawn(cmd, {
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
      });
      return await child.exited;
    }
    const evidencePath = evaluationEvidencePath();
    let lock: string | null = null;
    if (options.harness !== "quota") {
      lock = evidencePath + ".lock";
      mkdirSync(dirname(lock), { recursive: true, mode: 0o700 });
      try {
        mkdirSync(lock, { mode: 0o700 });
      } catch {
        throw new Error(
          "evaluation evidence is locked; another evaluation may be running (inspect before removing stale lock)",
        );
      }
    }
    try {
      const { loadQualityStore } = await import("./agent-quality");
      const existingStore =
        options.harness !== "quota" && existsSync(evidencePath)
          ? await loadQualityStore(evidencePath)
          : null;
      const quotaBefore = await currentQuota(apiKey);
      if (options.harness === "quota") {
        console.log(
          JSON.stringify({
            daily_requests_remaining: quotaBefore,
            inference_requests: 0,
          }),
        );
        return quotaBefore > 0 ? 0 : 1;
      }
      if (quotaBefore === 0) {
        console.log(
          JSON.stringify({
            status: "skipped",
            reason: "quota exhausted",
            daily_requests_remaining: 0,
            inference_requests: 0,
          }),
        );
        return 1;
      }
      const catalog = await availableCatalog(options.model);
      const guard = createRequestGuard({
        model: options.model,
        apiKey,
        maxRequests: Math.min(options.maxRequests, quotaBefore),
        catalog,
      });
      const perTrialBudget = Math.floor(options.maxRequests / options.trials);
      const root = dirname(import.meta.dir);
      const temp = mkdtempSync(join(tmpdir(), "dotfiles-agent-eval-"));
      const trials: import("./agent-quality").Trial[] = [];
      let harnessVersion = "unknown";
      try {
        const sourceConfig =
          process.env.AGENT_CONFIG ?? join(root, "config/agents.toml");
        const toml = readFileSync(sourceConfig, "utf8");
        const config = join(temp, "agents.toml");
        const replaced = toml
          .replace(
            /(\[providers\.openrouter-free\][\s\S]*?\bbase_url\s*=\s*)"[^"]*"/,
            "$1" + JSON.stringify(guard.url + "/api"),
          )
          .replace(
            /CLAUDE_CODE_MAX_RETRIES\s*=\s*"\d+"/g,
            'CLAUDE_CODE_MAX_RETRIES = "0"',
          );
        if (replaced === toml)
          throw new Error(
            "evaluation could not bind temporary provider endpoint",
          );
        writePrivate(config, replaced);
        for (let trialIndex = 0; trialIndex < options.trials; trialIndex++) {
          if (!guard.beginTrial(perTrialBudget)) break;
          const trialRoot = join(temp, `trial-${trialIndex}`);
          const home = join(trialRoot, "home");
          const cwd = join(trialRoot, "workspace");
          mkdirSync(home, { recursive: true, mode: 0o700 });
          mkdirSync(cwd, { recursive: true, mode: 0o700 });
          const before = prepareFixture(cwd);
          const env = isolatedEnvironment(home);
          env.OPENROUTER_API_KEY = "evaluation-dummy";
          env.AGENT_CONFIG = config;
          env.AGENT_CATALOG_URL = guard.url + "/api/v1/models";
          env.AGENT_CACHE_DIR = join(home, ".cache/catalog");
          writeHarnessConfig(
            home,
            options.harness,
            guard.url + "/api",
            options.model,
            catalog,
            env,
          );
          const version = await boundedProcess(
            [
              process.execPath,
              join(root, "script/agent.ts"),
              options.harness,
              "--",
              "--version",
            ],
            cwd,
            env,
            10,
          );
          if (version.code !== 0)
            throw new Error("harness version unavailable");
          const parsedVersion = parseHarnessVersion(
            version.stdout,
            version.stderr,
          );
          if (!parsedVersion)
            throw new Error(
              "harness printed no valid version; refusing inference",
            );
          harnessVersion = parsedVersion;
          const requestsBefore = guard.requests;
          const started = performance.now();
          const result = await boundedProcess(
            [
              process.execPath,
              join(root, "script/agent.ts"),
              options.harness,
              "openrouter-free",
              "--model",
              options.model,
              "--allow-unverified",
              "--",
              ...harnessArguments(
                options.harness,
                "Read TASK.md in the working directory and complete its requirements, including initial and final tests.",
              ),
            ],
            cwd,
            env,
            options.timeout,
            guard.signal,
            true,
          );
          guard.endTrial();
          const transcript = observeTranscript(
            options.harness,
            result.stdout,
            options.model,
          );
          const responseModels = guard.modelsSince(requestsBefore);
          const observed =
            responseModels.length === 1 ? responseModels[0] : null;
          const grade = await gradeFixture(cwd, before);
          const healthyModel =
            guard.requests > requestsBefore &&
            responseModels.length === 1 &&
            observed === options.model &&
            !transcript.modelMismatch;
          let failureKind: FailureKind | null = guard.failureKind;
          let failureReason = guard.failureReason;
          if (
            (!failureKind || guard.budgetExhausted) &&
            (result.timedOut || result.overflow || guard.budgetExhausted)
          ) {
            failureKind = result.overflow
              ? "launcher"
              : healthyModel
                ? "capability"
                : "launcher";
            failureReason = result.overflow
              ? "harness output exceeded limit"
              : result.timedOut
                ? "evaluation task timeout"
                : `evaluation request budget exhausted (${perTrialBudget} per trial)`;
          }
          if (
            !failureKind &&
            (guard.requests <= requestsBefore ||
              responseModels.length !== 1 ||
              transcript.modelMismatch ||
              observed !== options.model)
          ) {
            failureKind = "launcher";
            failureReason =
              "actual requested model was not independently observed";
          }
          if (!failureKind && result.code !== 0) {
            failureKind = "launcher";
            failureReason = "harness exited unsuccessfully";
          }
          if (
            !failureKind &&
            (!grade.success ||
              !transcript.completed ||
              transcript.toolCalls === 0 ||
              !transcript.debuggedPublicRegression ||
              !transcript.finalTestPassed)
          ) {
            failureKind = "capability";
            failureReason = !grade.integrityPassed
              ? "forbidden fixture modification"
              : !grade.publicPassed
                ? "public regression failed"
                : !grade.hiddenPassed
                  ? "independent grading failed"
                  : !transcript.completed
                    ? "no final harness completion event"
                    : !transcript.toolCalls
                      ? "no tool calls observed"
                      : !transcript.debuggedPublicRegression
                        ? "initial public regression was not debugged through tools"
                        : "no final passing test command observed";
          }
          const trialId = randomUUID();
          const logPath = join(
            dirname(evidencePath),
            "evaluation-runs",
            trialId + ".json",
          );
          const log = redactedLog(
            JSON.stringify(
              {
                model_id: options.model,
                harness: options.harness,
                stdout: result.stdout.slice(0, 1000000),
                stderr: result.stderr.slice(0, 1000000),
                grade,
                inference_requests: guard.requests - requestsBefore,
                upstream_error: guard.failureDetails,
              },
              null,
              2,
            ),
          );
          writePrivate(logPath, log);
          trials.push({
            id: trialId,
            evaluated_at: new Date().toISOString(),
            success: failureKind === null,
            integrity_passed: grade.integrityPassed,
            observed_model: observed,
            tool_calls: transcript.toolCalls,
            tool_failures: Math.min(
              transcript.toolFailures,
              transcript.toolCalls,
            ),
            duration_ms: Math.round(performance.now() - started),
            failure_kind: failureKind,
            failure_reason: failureReason,
          });
          Object.assign(trials[trials.length - 1], {
            log_path: logPath,
            log_sha256: createHash("sha256").update(log).digest("hex"),
            upstream_error: guard.failureDetails,
          });
          if (failureKind && failureKind !== "capability") break;
        }
      } finally {
        guard.stop();
        rmSync(temp, { recursive: true, force: true });
      }
      const path = evidencePath;
      const store: import("./agent-quality").EvidenceStore = existingStore ?? {
        schema_version: 1,
        evaluation_version: EVALUATION_VERSION,
        fixture_digest: fixtureDigest(),
        calibration: null,
        evaluations: [],
      };
      const evaluation: import("./agent-quality").Evaluation = {
        model_id: options.model,
        provider: "openrouter",
        harness: options.harness,
        harness_version: harnessVersion,
        evaluated_at: new Date().toISOString(),
        evaluation_version: EVALUATION_VERSION,
        fixture_digest: fixtureDigest(),
        benchmarks: publicBenchmarks(options.model),
        trials,
        conditions: {
          max_requests_per_trial: perTrialBudget,
          timeout_seconds: options.timeout,
          generation_profile: "isolated-default-v1",
        },
      };
      if (
        store.evaluation_version !== EVALUATION_VERSION ||
        store.fixture_digest !== fixtureDigest()
      )
        store.calibration = null;
      store.evaluation_version = EVALUATION_VERSION;
      store.fixture_digest = fixtureDigest();
      store.evaluations.push(evaluation);
      const pending = path + "." + randomUUID() + ".tmp";
      writePrivate(pending, JSON.stringify(store, null, 2) + "\n");
      renameSync(pending, path);
      let quotaAfter: number | null = null;
      try {
        quotaAfter = await currentQuota(apiKey);
      } catch {
        /* Existing sanitized inference evidence survives a failed postflight. */
      }
      console.log(
        JSON.stringify({
          evaluation,
          evidence_file: path,
          inference_requests: guard.requests,
          daily_requests_before: quotaBefore,
          daily_requests_after: quotaAfter,
        }),
      );
      return trials.length === options.trials &&
        trials.every((trial) => trial.success)
        ? 0
        : 1;
    } finally {
      if (lock) rmSync(lock, { recursive: true, force: true });
    }
  } catch (error) {
    console.error(
      `agent evaluate: ${error instanceof Error ? error.message : "evaluation failed"}`,
    );
    return 1;
  }
}
if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args[0] === "__injected") {
    args.shift();
    if (!process.env.OPENROUTER_API_KEY) {
      console.error(
        "agent evaluate: Infisical did not inject OPENROUTER_API_KEY",
      );
      process.exit(1);
    }
  }
  process.exitCode = await evaluationMain(args);
}
