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

function sessionFile(events: object[], sessionCwd = cwd): string {
  const dir = join(root, "proj");
  mkdirSync(dir, { recursive: true });
  const lines = [
    JSON.stringify({ type: "session", version: 3, id: "s1", timestamp: "2026-11-18T13:00:01.000Z", cwd: sessionCwd }),
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
      provider: provider(), cwd, sinceMs: SINCE, sessionsRoot: root,
    });
    expect(signal?.httpStatus).toBe(401);
    expect(signal?.exitCode).toBeNull();
    expect(signal?.failureKind).toBeNull();
  });

  it("returns 429 evidence for a real rate-limit response", () => {
    sessionFile([errorEvent(SINCE + 1000, 429)]);
    const signal = extractProviderFailureEvidence({
      provider: provider(), cwd, sinceMs: SINCE, sessionsRoot: root,
    });
    expect(signal?.httpStatus).toBe(429);
  });

  it("ignores events older than the execution window", () => {
    sessionFile([errorEvent(SINCE - 60_000, 401)]);
    expect(extractProviderFailureEvidence({
      provider: provider(), cwd, sinceMs: SINCE, sessionsRoot: root,
    })).toBeNull();
  });

  it("ignores errors from a different provider id", () => {
    sessionFile([errorEvent(SINCE + 1000, 401, "kilo")]);
    expect(extractProviderFailureEvidence({
      provider: provider(), cwd, sinceMs: SINCE, sessionsRoot: root,
    })).toBeNull();
  });

  it("ignores sessions from a different working directory", () => {
    sessionFile([errorEvent(SINCE + 1000, 401)], "/some/other/cwd");
    expect(extractProviderFailureEvidence({
      provider: provider(), cwd, sinceMs: SINCE, sessionsRoot: root,
    })).toBeNull();
  });

  it("ignores non-error stop reasons and missing errorStatus", () => {
    sessionFile([
      { type: "message_end", message: { stopReason: "stop", provider: "groq", timestamp: SINCE + 1 } },
      { type: "message_end", message: { stopReason: "error", provider: "groq", timestamp: SINCE + 2 } },
    ]);
    expect(extractProviderFailureEvidence({
      provider: provider(), cwd, sinceMs: SINCE, sessionsRoot: root,
    })).toBeNull();
  });

  it("picks the newest qualifying error across events", () => {
    sessionFile([
      errorEvent(SINCE + 1000, 500),
      errorEvent(SINCE + 2000, 429),
    ]);
    const signal = extractProviderFailureEvidence({
      provider: provider(), cwd, sinceMs: SINCE, sessionsRoot: root,
    });
    expect(signal?.httpStatus).toBe(429);
  });

  it("returns null when the sessions root does not exist", () => {
    expect(extractProviderFailureEvidence({
      provider: provider(), cwd, sinceMs: SINCE,
      sessionsRoot: join(root, "nonexistent"),
    })).toBeNull();
  });
});
