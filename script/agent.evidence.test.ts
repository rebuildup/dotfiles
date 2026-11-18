import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractProviderFailureEvidence } from "./agent/evidence.ts";
import type { Provider } from "./agent/config.ts";

function provider(overrides: Partial<Provider> = {}): Provider {
  return {
    key: "groq", label: "Groq", base_url: null, secret: "GROQ_API_KEY",
    env: "GROQ_API_KEY", default_model: "m", require_model: false,
    models: ["m"], opencode_id: "groq", omp_id: "groq",
    require_infisical: true, anonymous: false,
    opencode_npm: null, opencode_models: {}, opencode_base_url: null,
    omp_custom: false, omp_api: null, omp_models: {},
    ...overrides,
  } as Provider;
}

let root: string;
let cwd: string;
const SINCE = Date.parse("2026-11-18T13:00:00.000Z");

const PROMPT = "fix the failing test";

function userEvent(ts: number, text = PROMPT): object {
  return {
    type: "message_end",
    message: { role: "user", content: [{ type: "text", text }], timestamp: ts },
  };
}

function successEvent(ts: number): object {
  return {
    type: "message_end",
    message: { role: "assistant", stopReason: "stop", provider: "groq", timestamp: ts },
  };
}

function sessionFile(events: object[], sessionCwd = cwd, prompt = PROMPT): string {
  const dir = join(root, "proj");
  mkdirSync(dir, { recursive: true });
  const lines = [
    JSON.stringify({ type: "session", version: 3, id: "s1", timestamp: "2026-11-18T13:00:01.000Z", cwd: sessionCwd }),
    JSON.stringify(userEvent(SINCE + 500, prompt)),
    ...events.map((e) => JSON.stringify(e)),
  ];
  const path = join(dir, `2026-11-18T13-00-01-000Z_s1.jsonl`);
  writeFileSync(path, lines.join("\n") + "\n");
  return path;
}

function errorEvent(ts: number, status: number, prov = "groq"): object {
  return {
    type: "message_end",
    message: {
      role: "assistant", stopReason: "error", errorStatus: status,
      errorMessage: `${status} provider error`, provider: prov,
      model: "llama-3.3-70b-versatile", timestamp: ts,
    },
  };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "evidence-"));
  cwd = mkdtempSync(join(tmpdir(), "evidence-cwd-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("extractProviderFailureEvidence", () => {
  it("returns the real HTTP status from a qualifying provider error event", () => {
    sessionFile([errorEvent(SINCE + 1000, 401)]);
    const signal = extractProviderFailureEvidence({
      provider: provider(), cwd, sinceMs: SINCE, sessionsRoot: root, prompt: PROMPT,
    });
    expect(signal?.httpStatus).toBe(401);
    expect(signal?.exitCode).toBeNull();
    expect(signal?.failureKind).toBeNull();
  });

  it("returns 429 evidence for a real rate-limit response", () => {
    sessionFile([errorEvent(SINCE + 1000, 429)]);
    const signal = extractProviderFailureEvidence({
      provider: provider(), cwd, sinceMs: SINCE, sessionsRoot: root, prompt: PROMPT,
    });
    expect(signal?.httpStatus).toBe(429);
  });

  it("ignores events older than the execution window", () => {
    sessionFile([errorEvent(SINCE - 60_000, 401)]);
    expect(extractProviderFailureEvidence({
      provider: provider(), cwd, sinceMs: SINCE, sessionsRoot: root, prompt: PROMPT,
    })).toBeNull();
  });

  it("ignores errors from a different provider id", () => {
    sessionFile([errorEvent(SINCE + 1000, 401, "kilo")]);
    expect(extractProviderFailureEvidence({
      provider: provider(), cwd, sinceMs: SINCE, sessionsRoot: root, prompt: PROMPT,
    })).toBeNull();
  });

  it("ignores sessions from a different working directory", () => {
    sessionFile([errorEvent(SINCE + 1000, 401)], "/some/other/cwd");
    expect(extractProviderFailureEvidence({
      provider: provider(), cwd, sinceMs: SINCE, sessionsRoot: root, prompt: PROMPT,
    })).toBeNull();
  });

  it("ignores non-error stop reasons and missing errorStatus", () => {
    sessionFile([
      { type: "message_end", message: { stopReason: "stop", provider: "groq", timestamp: SINCE + 1 } },
      { type: "message_end", message: { stopReason: "error", provider: "groq", timestamp: SINCE + 2 } },
    ]);
    expect(extractProviderFailureEvidence({
      provider: provider(), cwd, sinceMs: SINCE, sessionsRoot: root, prompt: PROMPT,
    })).toBeNull();
  });

  it("picks the newest qualifying error across events", () => {
    sessionFile([
      errorEvent(SINCE + 1000, 500),
      errorEvent(SINCE + 2000, 429),
    ]);
    const signal = extractProviderFailureEvidence({
      provider: provider(), cwd, sinceMs: SINCE, sessionsRoot: root, prompt: PROMPT,
    });
    expect(signal?.httpStatus).toBe(429);
  });

  it("rejects evidence when the session holds a DIFFERENT prompt (concurrent worker)", () => {
    sessionFile([errorEvent(SINCE + 1000, 401)], cwd, "a different task entirely");
    expect(extractProviderFailureEvidence({
      provider: provider(), cwd, sinceMs: SINCE, sessionsRoot: root, prompt: PROMPT,
    })).toBeNull();
  });

  it("treats an error followed by a successful outcome as recovered, not failure", () => {
    sessionFile([
      errorEvent(SINCE + 1000, 429),
      successEvent(SINCE + 2000),
    ]);
    expect(extractProviderFailureEvidence({
      provider: provider(), cwd, sinceMs: SINCE, sessionsRoot: root, prompt: PROMPT,
    })).toBeNull();
  });

  it("still reports an error that is the final outcome after earlier successes", () => {
    sessionFile([
      successEvent(SINCE + 500),
      errorEvent(SINCE + 1000, 402),
    ]);
    const signal = extractProviderFailureEvidence({
      provider: provider(), cwd, sinceMs: SINCE, sessionsRoot: root, prompt: PROMPT,
    });
    expect(signal?.httpStatus).toBe(402);
  });

  it("ignores error outcomes from turns BEFORE the prompt in the same session", () => {
    // Same session, earlier turn failed — but THIS prompt never produced
    // an outcome, so there is no evidence for this attempt.
    const dir = join(root, "proj");
    mkdirSync(dir, { recursive: true });
    const lines = [
      JSON.stringify({ type: "session", version: 3, id: "s2", timestamp: "2026-11-18T13:00:01.000Z", cwd }),
      JSON.stringify(userEvent(SINCE + 100, "an earlier unrelated prompt")),
      JSON.stringify(errorEvent(SINCE + 200, 401)),
      JSON.stringify(userEvent(SINCE + 900)),
    ];
    writeFileSync(join(dir, "2026-11-18T13-00-02-000Z_s2.jsonl"), lines.join("\n") + "\n");
    expect(extractProviderFailureEvidence({
      provider: provider(), cwd, sinceMs: SINCE, sessionsRoot: root, prompt: PROMPT,
    })).toBeNull();
  });

  it("returns null when the sessions root does not exist", () => {
    expect(extractProviderFailureEvidence({
      provider: provider(), cwd, sinceMs: SINCE,
      sessionsRoot: join(root, "nonexistent"), prompt: PROMPT,
    })).toBeNull();
  });
});
