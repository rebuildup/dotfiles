import { describe, expect, test } from "bun:test";
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  rmSync,
  mkdirSync,
  chmodSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  quotaRemaining,
  createRequestGuard as rawRequestGuard,
  observeTranscript,
  prepareFixture,
  gradeFixture,
  fixtureDigest,
  parseEvaluationArgs,
  isolatedEnvironment,
  evaluationMain,
  collectProcessOutput,
} from "./agent-eval";

const createRequestGuard = (options: Parameters<typeof rawRequestGuard>[0]) =>
  rawRequestGuard({ minIntervalMs: 0, ...options });

describe("evaluation safety", () => {
  test("quota requires explicit daily request counters and never infers credits", () => {
    expect(
      quotaRemaining({ data: { limit_remaining: 100, is_free_tier: false } }),
    ).toBeNull();
    expect(
      quotaRemaining({
        data: {
          free_model_daily_requests: { used: 7, limit: 10, remaining: 3 },
        },
      }),
    ).toBe(3);
    expect(
      quotaRemaining({
        data: {
          free_model_daily_requests: { used: 11, limit: 10, remaining: -1 },
        },
      }),
    ).toBe(0);
    expect(
      quotaRemaining({
        data: {
          free_model_daily_requests: { used: 2, limit: 10, remaining: 20 },
        },
      }),
    ).toBeNull();
  });
  test("args reject paid/router models, zero/huge budgets and unknown flags", () => {
    expect(() => parseEvaluationArgs(["pi", "--model", "x/y"])).toThrow();
    expect(() =>
      parseEvaluationArgs(["pi", "--model", "x/y:free", "--max-requests", "0"]),
    ).toThrow();
    expect(() =>
      parseEvaluationArgs([
        "pi",
        "--model",
        "x/y:free",
        "--timeout",
        "Infinity",
      ]),
    ).toThrow();
    expect(() =>
      parseEvaluationArgs(["pi", "--model", "x/y:free", "--oops"]),
    ).toThrow();
    expect(parseEvaluationArgs(["pi", "--model", "x/y:free"]).maxRequests).toBe(
      12,
    );
  });
  test("isolated environment contains no inherited credentials or host config", () => {
    const env = isolatedEnvironment("/tmp/eval-home", {
      PATH: "/bin",
      OPENROUTER_API_KEY: "real",
      GITHUB_TOKEN: "secret",
      NODE_OPTIONS: "evil",
      HOME: "/real",
      AGENT_CONFIG: "/real/config",
    });
    expect(env.OPENROUTER_API_KEY).toBeUndefined();
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env.NODE_OPTIONS).toBeUndefined();
    expect(env.HOME).toBe("/tmp/eval-home");
  });
  test("model evidence is actual assistant model, not system requested model", () => {
    expect(
      observeTranscript(
        "claude",
        JSON.stringify({ type: "system", model: "x/y:free" }),
        "x/y:free",
      ).observedModel,
    ).toBeNull();
    const observed = observeTranscript(
      "pi",
      JSON.stringify({
        type: "message_end",
        message: {
          role: "assistant",
          model: "x/y:free",
          content: [{ type: "toolCall", id: "a", name: "read" }],
        },
      }),
      "x/y:free",
    );
    expect(observed.observedModel).toBe("x/y:free");
    expect(observed.toolCalls).toBe(1);
  });
  test("model mismatch or conflicting transcript cannot certify success", () => {
    const lines = [
      { type: "assistant", message: { model: "x/y:free", content: [] } },
      {
        type: "assistant",
        message: { model: "other/model:free", content: [] },
      },
    ]
      .map(JSON.stringify)
      .join("\n");
    expect(observeTranscript("claude", lines, "x/y:free").modelMismatch).toBe(
      true,
    );
  });
});

describe("hard inference budget guard", () => {
  test("counts failed attempts, blocks after total cap, and pins model/auth", async () => {
    const requests: any[] = [];
    const guard = createRequestGuard({
      model: "x/y:free",
      apiKey: "actual-key",
      maxRequests: 1,
      fetch: async (url, init) => {
        requests.push({ url, init });
        return new Response(JSON.stringify({ model: "x/y:free", choices: [] }));
      },
    });
    try {
      const send = (body: any) =>
        fetch(`${guard.url}/api/v1/chat/completions`, {
          method: "POST",
          headers: {
            authorization: "Bearer dummy",
            "content-type": "application/json",
          },
          body: JSON.stringify(body),
        });
      expect((await send({ model: "paid/model", messages: [] })).status).toBe(
        400,
      );
      expect(
        (
          await send({
            model: "x/y:free",
            messages: [],
            models: ["paid/model"],
          })
        ).status,
      ).toBe(400);
      expect((await send({ model: "x/y:free", messages: [] })).status).toBe(
        200,
      );
      expect((await send({ model: "x/y:free", messages: [] })).status).toBe(
        429,
      );
      expect(requests.length).toBe(1);
      expect(guard.requests).toBe(1);
      expect(new Headers(requests[0].init.headers).get("authorization")).toBe(
        "Bearer actual-key",
      );
      expect(requests[0].url).toBe(
        "https://openrouter.ai/api/v1/chat/completions",
      );
    } finally {
      guard.stop();
    }
  });
  test("upstream 429 latches immediately across later calls", async () => {
    const guard = createRequestGuard({
      model: "x/y:free",
      apiKey: "key",
      maxRequests: 5,
      fetch: async () => new Response("quota", { status: 429 }),
    });
    try {
      const request = () =>
        fetch(`${guard.url}/api/v1/messages`, {
          method: "POST",
          body: JSON.stringify({ model: "x/y:free", messages: [] }),
        });
      expect((await request()).status).toBe(429);
      await request();
      expect(guard.requests).toBe(1);
      expect(guard.failureKind).toBe("quota");
    } finally {
      guard.stop();
    }
  });
});

describe("independent multi-file fixture grading", () => {
  test("initial public regression fails and hidden grading never ships in workspace", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-eval-test-"));
    try {
      const prepared = prepareFixture(dir);
      expect(readFileSync(join(dir, "TASK.md"), "utf8")).not.toContain(
        "hidden",
      );
      expect(fixtureDigest()).toMatch(/^[a-f0-9]{64}$/);
      const grade = await gradeFixture(dir, prepared);
      expect(grade.publicPassed).toBe(false);
      expect(grade.success).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  test("forbidden test tampering is rejected independently of self-report", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-eval-test-"));
    try {
      const prepared = prepareFixture(dir);
      writeFileSync(join(dir, "public.test.ts"), "// all passed");
      const grade = await gradeFixture(dir, prepared);
      expect(grade.integrityPassed).toBe(false);
      expect(grade.success).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

test("external grader accepts a general multi-file solution, catches aggregation cheating", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-eval-solution-"));
  try {
    const before = prepareFixture(dir);
    writeFileSync(
      join(dir, "src/pricing.ts"),
      "export const subtotal=(priceCents:number,quantity:number,discountPercent=0)=>Math.round(priceCents*quantity*(100-discountPercent)/100);",
    );
    writeFileSync(
      join(dir, "src/reserve.ts"),
      `
import type {Inventory} from './catalog';
export function reserve(input:Inventory,lines:Array<{sku:string;quantity:number}>,discount=0){
 if(!Number.isInteger(discount)||discount<0||discount>100)throw Error('discount');
 const quantities:Record<string,number>={};for(const line of lines){if(!Number.isSafeInteger(line.quantity)||line.quantity<1)throw Error('quantity');const sku=line.sku.trim().toLowerCase();quantities[sku]=(quantities[sku]??0)+line.quantity;}
 const inventory=Object.fromEntries(Object.entries(input).map(([sku,item])=>[sku,{...item}]));let total=0;
 for(const [sku,quantity] of Object.entries(quantities)){if(!input[sku]||input[sku].stock<quantity)throw Error('stock');inventory[sku].stock-=quantity;total+=input[sku].priceCents*quantity;}
 return {inventory,totalCents:Math.round(total*(100-discount)/100)};
}`,
    );
    expect((await gradeFixture(dir, before)).success).toBe(true);
    writeFileSync(
      join(dir, "src/reserve.ts"),
      readFileSync(join(dir, "src/reserve.ts"), "utf8").replace(
        "Math.round(total*(100-discount)/100)",
        "total",
      ),
    );
    expect((await gradeFixture(dir, before)).hiddenPassed).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("streaming actual model observations are scoped to each trial and mismatch blocks", async () => {
  const guard = createRequestGuard({
    model: "x/y:free",
    apiKey: "key",
    maxRequests: 3,
    fetch: async () =>
      new Response(
        'data: {"model":"x/y:free","choices":[]}\n\ndata: [DONE]\n',
        { headers: { "content-type": "text/event-stream" } },
      ),
  });
  try {
    await fetch(guard.url + "/api/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({ model: "x/y:free", messages: [] }),
    });
    expect(guard.modelsSince(0)).toEqual(["x/y:free"]);
    expect(guard.modelsSince(1)).toEqual([]);
  } finally {
    guard.stop();
  }
  const mismatch = createRequestGuard({
    model: "x/y:free",
    apiKey: "key",
    maxRequests: 3,
    fetch: async () => Response.json({ model: "wrong/model:free" }),
  });
  try {
    expect(
      (
        await fetch(mismatch.url + "/api/v1/chat/completions", {
          method: "POST",
          body: JSON.stringify({ model: "x/y:free", messages: [] }),
        })
      ).status,
    ).toBe(502);
    expect(mismatch.failureKind).toBe("api");
  } finally {
    mismatch.stop();
  }
});

test("requires observed initial failing public test and a later passing test", () => {
  const messages = [
    {
      type: "message_end",
      message: {
        role: "assistant",
        model: "x/y:free",
        content: [
          {
            type: "toolCall",
            id: "t1",
            name: "bash",
            arguments: { command: "bun test public.test.ts" },
          },
        ],
      },
    },
    {
      type: "tool_execution_end",
      toolCallId: "t1",
      isError: true,
      result: {
        content: [{ type: "text", text: "Command exited with code 1" }],
      },
    },
    {
      type: "message_end",
      message: {
        role: "assistant",
        model: "x/y:free",
        content: [
          {
            type: "toolCall",
            id: "t2",
            name: "bash",
            arguments: { command: "bun test public.test.ts" },
          },
        ],
      },
    },
    {
      type: "tool_execution_end",
      toolCallId: "t2",
      isError: false,
      result: { content: [{ type: "text", text: "3 pass, 0 fail" }] },
    },
    { type: "agent_end" },
  ];
  const observed = observeTranscript(
    "pi",
    messages.map(JSON.stringify).join("\n"),
    "x/y:free",
  );
  expect(observed.debuggedPublicRegression).toBe(true);
  expect(observed.finalTestPassed).toBe(true);
  expect(
    observeTranscript("pi", JSON.stringify(messages[0]), "x/y:free")
      .finalTestPassed,
  ).toBe(false);
});

test("mocked full launcher evaluation isolates credentials, forwards once and persists independently graded evidence", async () => {
  const temp = mkdtempSync(join(tmpdir(), "agent-eval-flow-"));
  const previous = { ...process.env };
  const nativeFetch = globalThis.fetch;
  let inference = 0;
  const model = "mock/coding:free";
  const solution = `import type {Inventory} from './catalog';export function reserve(input:Inventory,lines:Array<{sku:string;quantity:number}>,discount=0){if(!Number.isInteger(discount)||discount<0||discount>100)throw Error('discount');const quantities:Record<string,number>={};for(const line of lines){if(!Number.isSafeInteger(line.quantity)||line.quantity<1)throw Error('quantity');const sku=line.sku.trim().toLowerCase();quantities[sku]=(quantities[sku]??0)+line.quantity;}const inventory=Object.fromEntries(Object.entries(input).map(([sku,item])=>[sku,{...item}]));let total=0;for(const [sku,quantity] of Object.entries(quantities)){if(!input[sku]||input[sku].stock<quantity)throw Error('stock');inventory[sku].stock-=quantity;total+=input[sku].priceCents*quantity;}return {inventory,totalCents:Math.round(total*(100-discount)/100)};}`;
  try {
    const fake = join(
      temp,
      process.platform === "win32" ? "fake-pi.ts" : "fake-pi",
    );
    writeFileSync(
      fake,
      `#!${process.execPath}\nimport {readFileSync,writeFileSync} from 'node:fs';
if(process.argv.includes('--version')){console.log('fake-pi 1.0');process.exit(0);}
if(process.env.OPENROUTER_API_KEY!=='evaluation-dummy'||process.env.GITHUB_TOKEN)throw Error('credential isolation failure');
const config=JSON.parse(readFileSync(process.env.PI_CODING_AGENT_DIR+'/models.json','utf8'));const model='mock/coding:free';
await (await fetch(config.providers.openrouter.baseUrl+'/chat/completions',{method:'POST',body:JSON.stringify({model,messages:[]})})).text();
const emit=(event)=>console.log(JSON.stringify(event));
const call=(id)=>emit({type:'message_end',message:{role:'assistant',model,content:[{type:'toolCall',id,name:'bash',arguments:{command:'bun test public.test.ts'}}]}});
call('first');let result=Bun.spawnSync([process.execPath,'test','public.test.ts']);emit({type:'tool_execution_end',toolCallId:'first',isError:result.exitCode!==0});
writeFileSync('src/pricing.ts','export const subtotal=(p:number,q:number,d=0)=>Math.round(p*q*(100-d)/100);');
writeFileSync('src/reserve.ts',${JSON.stringify(solution)});
call('final');result=Bun.spawnSync([process.execPath,'test','public.test.ts']);emit({type:'tool_execution_end',toolCallId:'final',isError:result.exitCode!==0});emit({type:'agent_end'});
`,
    );
    chmodSync(fake, 0o700);
    const nativeCommand =
      process.platform === "win32" ? join(temp, "fake-pi.cmd") : fake;
    if (process.platform === "win32")
      writeFileSync(
        nativeCommand,
        '@echo off\r\n"' + process.execPath + '" "' + fake + '" %*\r\n',
      );
    const source = readFileSync(
      join(import.meta.dir, "../config/agents.toml"),
      "utf8",
    );
    const config = join(temp, "agents.toml");
    writeFileSync(
      config,
      source.replace(
        /(\[harnesses\.pi\][\s\S]*?command\s*=\s*)"[^"]*"/,
        "$1" + JSON.stringify(nativeCommand),
      ),
    );
    process.env.AGENT_CONFIG = config;
    process.env.AGENT_QUALITY_FILE = join(temp, "quality.json");
    process.env.OPENROUTER_API_KEY = "real-secret";
    process.env.GITHUB_TOKEN = "unrelated-secret";
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      if (url === "https://openrouter.ai/api/v1/key")
        return Response.json({
          data: {
            free_model_daily_requests: { used: 1, limit: 10, remaining: 9 },
          },
        });
      if (url === "https://openrouter.ai/api/v1/models")
        return Response.json({
          data: [
            {
              id: model,
              pricing: { prompt: "0", completion: "0" },
              supported_parameters: ["tools"],
              context_length: 128000,
              architecture: {
                input_modalities: ["text"],
                output_modalities: ["text"],
              },
            },
          ],
        });
      if (url === "https://openrouter.ai/api/v1/chat/completions") {
        inference++;
        expect(new Headers(init?.headers).get("authorization")).toBe(
          "Bearer real-secret",
        );
        return Response.json({ model, choices: [] });
      }
      return nativeFetch(input, init);
    };
    expect(
      await evaluationMain([
        "pi",
        "--model",
        model,
        "--max-requests",
        "2",
        "--timeout",
        "20",
      ]),
    ).toBe(0);
    expect(inference).toBe(1);
    const store = JSON.parse(readFileSync(join(temp, "quality.json"), "utf8"));
    expect(store.evaluations[0].trials[0].success).toBe(true);
    expect(store.evaluations[0].trials[0].tool_failures).toBe(0);
    expect(JSON.stringify(store)).not.toContain("real-secret");
    expect(store.evaluations[0].conditions).toEqual({
      max_requests_per_trial: 2,
      timeout_seconds: 20,
      generation_profile: "isolated-default-v1",
    });
    const goldenHarness = readFileSync(fake, "utf8");
    writeFileSync(
      fake,
      goldenHarness.replace(
        "const emit=",
        `for(let i=0;i<2;i++)await (await fetch(config.providers.openrouter.baseUrl+'/chat/completions',{method:'POST',body:JSON.stringify({model,messages:[]})})).text();\nconst emit=`,
      ),
    );
    expect(
      await evaluationMain([
        "pi",
        "--model",
        model,
        "--max-requests",
        "2",
        "--trials",
        "2",
        "--timeout",
        "20",
      ]),
    ).toBe(1);
    const budgetStore = JSON.parse(
      readFileSync(join(temp, "quality.json"), "utf8"),
    );
    const budgetEvaluation = budgetStore.evaluations.at(-1);
    expect(budgetEvaluation.conditions.max_requests_per_trial).toBe(1);
    expect(budgetEvaluation.trials).toHaveLength(2);
    expect(
      budgetEvaluation.trials.every(
        (trial: any) =>
          trial.failure_kind === "capability" && trial.observed_model === model,
      ),
    ).toBe(true);
    expect(inference).toBe(3);
    writeFileSync(
      fake,
      goldenHarness.replace(
        "const emit=",
        "await Bun.sleep(20000);\nconst emit=",
      ),
    );
    expect(
      await evaluationMain([
        "pi",
        "--model",
        model,
        "--max-requests",
        "1",
        "--timeout",
        "5",
      ]),
    ).toBe(1);
    const timed = JSON.parse(
      readFileSync(join(temp, "quality.json"), "utf8"),
    ).evaluations.at(-1);
    expect(timed.trials[0].failure_kind).toBe("capability");
    expect(timed.trials[0].failure_reason).toContain("timeout");
    writeFileSync(
      fake,
      goldenHarness.replace(
        "await (await fetch",
        "await Bun.sleep(20000);\nawait (await fetch",
      ),
    );
    expect(
      await evaluationMain([
        "pi",
        "--model",
        model,
        "--max-requests",
        "1",
        "--timeout",
        "1",
      ]),
    ).toBe(1);
    const cold = JSON.parse(
      readFileSync(join(temp, "quality.json"), "utf8"),
    ).evaluations.at(-1);
    expect(cold.trials[0].failure_kind).toBe("launcher");
    expect(cold.trials[0].observed_model).toBeNull();
  } finally {
    globalThis.fetch = nativeFetch;
    for (const key of Object.keys(process.env))
      if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
    rmSync(temp, { recursive: true, force: true });
  }
}, 30000);

test("HTTP 200 streaming error stops infrastructure evaluation without model rejection", async () => {
  const guard = createRequestGuard({
    model: "x/y:free",
    apiKey: "key",
    maxRequests: 3,
    fetch: async () =>
      new Response('data: {"error":{"code":429,"message":"exhausted"}}\n\n', {
        headers: { "content-type": "text/event-stream" },
      }),
  });
  try {
    await fetch(guard.url + "/api/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({ model: "x/y:free", messages: [] }),
    });
    expect(guard.failureKind).toBe("quota");
    expect(guard.signal.aborted).toBe(true);
    await fetch(guard.url + "/api/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({ model: "x/y:free", messages: [] }),
    });
    expect(guard.requests).toBe(1);
  } finally {
    guard.stop();
  }
});

test("scheduled inference attempts are spaced and preserve distinct request identities", async () => {
  const times: number[] = [];
  const guard = createRequestGuard({
    model: "x/y:free",
    apiKey: "key",
    maxRequests: 3,
    minIntervalMs: 30,
    fetch: async () => {
      times.push(Date.now());
      return Response.json({ model: "x/y:free" });
    },
  });
  try {
    const request = () =>
      fetch(guard.url + "/api/v1/chat/completions", {
        method: "POST",
        body: JSON.stringify({ model: "x/y:free", messages: [] }),
      });
    await Promise.all([request(), request(), request()]);
    expect(guard.requests).toBe(3);
    expect(times[1] - times[0]).toBeGreaterThanOrEqual(25);
    expect(times[2] - times[1]).toBeGreaterThanOrEqual(25);
    expect(guard.modelsSince(2)).toEqual(["x/y:free"]);
  } finally {
    guard.stop();
  }
});

test("independent grader rejects early process exit even when exit status is zero", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-eval-exit-"));
  try {
    const prepared = prepareFixture(dir);
    writeFileSync(
      join(dir, "src/reserve.ts"),
      "process.exit(0); export function reserve() {}",
    );
    const grade = await gradeFixture(dir, prepared);
    expect(grade.success).toBe(false);
    expect(grade.hiddenPassed).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("echoed test text is not proof of a debug/test tool execution", () => {
  const output = [
    {
      type: "message_end",
      message: {
        role: "assistant",
        model: "x/y:free",
        content: [
          {
            type: "toolCall",
            id: "a",
            name: "bash",
            arguments: { command: "echo bun test public.test.ts; false" },
          },
        ],
      },
    },
    { type: "tool_execution_end", toolCallId: "a", isError: true },
    {
      type: "message_end",
      message: {
        role: "assistant",
        model: "x/y:free",
        content: [
          {
            type: "toolCall",
            id: "b",
            name: "bash",
            arguments: { command: "echo bun test public.test.ts; true" },
          },
        ],
      },
    },
    { type: "tool_execution_end", toolCallId: "b", isError: false },
  ]
    .map(JSON.stringify)
    .join("\n");
  const result = observeTranscript("pi", output, "x/y:free");
  expect(result.debuggedPublicRegression).toBe(false);
  expect(result.finalTestPassed).toBe(false);
  expect(result.toolFailures).toBe(1);
});

test("Pi repeated partial-state telemetry does not consume retained evidence budget", async () => {
  const encoder = new TextEncoder();
  const delta = encoder.encode(
    JSON.stringify({
      type: "message_update",
      assistantMessageEvent: { partial: { content: "x".repeat(100000) } },
    }) + "\n",
  );
  let count = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (count++ < 100) controller.enqueue(delta);
      else {
        controller.enqueue(encoder.encode('{"type":"agent_end"}\n'));
        controller.close();
      }
    },
  });
  const result = await collectProcessOutput(stream, true);
  expect(result.overflow).toBe(false);
  expect(result.output).toBe('{"type":"agent_end"}\n');
  expect(result.rawBytes).toBeGreaterThan(8 * 1024 * 1024);
});

test("collector still rejects excessive final evidence and oversized single lines", async () => {
  const encoder = new TextEncoder();
  let count = 0;
  const line = encoder.encode(
    JSON.stringify({ type: "message_end", text: "x".repeat(1024 * 1024) }) +
      "\n",
  );
  const evidence = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (count++ < 10) controller.enqueue(line);
      else controller.close();
    },
  });
  expect((await collectProcessOutput(evidence, true)).overflow).toBe(true);
  const oversized = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode("x".repeat(9 * 1024 * 1024)));
      controller.close();
    },
  });
  expect((await collectProcessOutput(oversized, true)).overflow).toBe(true);
});

test("upstream quota details are bounded and redact keys before diagnostic persistence", async () => {
  const guard = createRequestGuard({
    model: "x/y:free",
    apiKey: "sensitive-key-value",
    maxRequests: 2,
    minIntervalMs: 0,
    fetch: async () =>
      Response.json(
        {
          error: {
            code: 429,
            message:
              "Rate limit exceeded: free-models-per-min sensitive-key-value Bearer fake-token-0123456789",
            metadata: {
              provider_code: "RATE_LIMIT",
              retry_after: "60",
              headers: { authorization: "never include this" },
            },
          },
        },
        { status: 429 },
      ),
  });
  try {
    await fetch(guard.url + "/api/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({ model: "x/y:free", messages: [] }),
    });
    expect(guard.failureReason).toContain("free-models-per-min");
    expect(guard.failureReason).not.toContain("sensitive-key-value");
    expect(guard.failureReason).not.toContain("fake-token-0123456789");
    expect(guard.failureDetails).toEqual({
      http_status: 429,
      code: 429,
      message:
        "Rate limit exceeded: free-models-per-min [REDACTED] Bearer [REDACTED]",
      provider_code: "RATE_LIMIT",
      retry_after: "60",
    });
    expect(JSON.stringify(guard.failureDetails)).not.toContain("authorization");
  } finally {
    guard.stop();
  }
});

test("trial budgets reset only local stop state and preserve total HTTP cap", async () => {
  const guard = createRequestGuard({
    model: "x/y:free",
    apiKey: "key",
    maxRequests: 2,
    fetch: async () => Response.json({ model: "x/y:free" }),
  });
  try {
    const request = () =>
      fetch(guard.url + "/api/v1/chat/completions", {
        method: "POST",
        body: JSON.stringify({ model: "x/y:free", messages: [] }),
      });
    expect(guard.beginTrial(1)).toBe(true);
    await request();
    expect((await request()).status).toBe(429);
    expect(guard.budgetExhausted).toBe("trial");
    expect(guard.signal.aborted).toBe(true);
    expect(guard.beginTrial(1)).toBe(true);
    expect(guard.signal.aborted).toBe(false);
    await request();
    expect(guard.requests).toBe(2);
    expect(guard.beginTrial(1)).toBe(false);
  } finally {
    guard.stop();
  }
});
