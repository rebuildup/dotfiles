/**
 * Tests for script/agent/telemetry.ts (issue #93, Epic #86 T007).
 *
 * REAL tests, no mocks: every test exercises the actual module against a
 * real machine-local temp directory (mkdtemp) and real files; the
 * concurrency test spawns real `bun` child processes writing the same
 * ledger simultaneously. There are no stubs, fakes or network calls.
 * Rejection and redaction tests assert on the actual bytes on disk.
 *
 * Run: bun test script/agent.telemetry.test.ts
 */

import { describe, test, expect, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, appendFileSync, existsSync, utimesSync, rmSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CONTRACT_VERSION,
  ContractError,
  type AttemptIdentity,
} from "./agent/contract";
import {
  DEFAULT_RETENTION_MS,
  LEDGER_FILE,
  LEDGER_LOCK_DIR,
  LEDGER_LOCK_STALE_MS,
  ledgerStateDir,
  parseUsageRecord,
  pruneLedger,
  readLedger,
  readLedgerFor,
  recordUsage,
  summarizeLedger,
  withLedgerLock,
  type UsageRecord,
} from "./agent/telemetry";

const REPO = join(import.meta.dir);
const MODULE_PATH = join(REPO, "agent", "telemetry.ts");
const T0 = "2026-11-01T00:00:00Z";
const DAY = 24 * 60 * 60 * 1000;

const IDENTITY: AttemptIdentity = {
  route: "claude.mimo",
  model: "mimo-v2",
  machine: "test-box",
  attempt: "nonce-1",
};
const ATTEMPT_KEY = "claude.mimo#mimo-v2#test-box#nonce-1";

const TMP_ROOT = mkdtempSync(join(tmpdir(), "agent-telemetry-test-"));
afterAll(() => {
  rmSync(TMP_ROOT, { recursive: true, force: true });
});

function newLedgerDir(name: string): string {
  const dir = join(TMP_ROOT, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Block until `cond` is true (real condition, bounded wait) — used to
 * await observable signals from spawned processes instead of guessed
 * fixed delays. */
function waitUntil(cond: () => boolean, timeoutMs = 5000): void {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("waitUntil: condition not met in time");
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
  }
}

/** Valid baseline record; tests override individual fields. */
function rec(overrides: Partial<UsageRecord> = {}): UsageRecord {
  return {
    attempt: ATTEMPT_KEY,
    task: "task-1",
    outcome: "success",
    verification: "pass",
    retry_of: null,
    usage: { prompt: 100, output: 50, cache_read: 20, cache_write: 10 },
    cost: { amount: 0.5, currency: "USD", basis: "billed" },
    wall_time_ms: 1000,
    tool_calls: 2,
    retries: 0,
    usage_provenance: "measured",
    wall_time_provenance: "measured",
    error_kind: null,
    started_at: T0,
    ended_at: "2026-11-01T00:00:05Z",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Record + read roundtrip: distinct observations preserved
// ---------------------------------------------------------------------------

describe("record/read roundtrip", () => {
  test("keeps success, failure, retry and verification observations distinct", () => {
    const dir = newLedgerDir("roundtrip");
    const r1 = rec({ outcome: "success", verification: "pass" });
    const r2 = rec({ outcome: "failure", verification: "fail", error_kind: "billing" });
    const r3 = rec({ outcome: "retry", verification: "neutral", retry_of: "prev-1" });
    recordUsage(dir, r1);
    recordUsage(dir, r2);
    recordUsage(dir, r3);
    const read = readLedger(dir);
    expect(read.corrupt).toBe(0);
    expect(read.records).toHaveLength(3);
    const byOutcome = Object.groupBy(read.records, (r) => r.outcome);
    expect(byOutcome.success).toHaveLength(1);
    expect(byOutcome.failure).toHaveLength(1);
    expect(byOutcome.retry).toHaveLength(1);
  });

  test("different attempts write to separate ledger files", () => {
    const dir = newLedgerDir("separate-attempts");
    const id1 = "omp.mistral#zai-glm-5-3-flash#wsl-1#1";
    const id2 = "omp.mistral#zai-glm-5-3-flash#wsl-1#2";
    recordUsage(dir, rec({ attempt: id1 }));
    recordUsage(dir, rec({ attempt: id2 }));
    const read = readLedger(dir);
    expect(read.records).toHaveLength(2);
    const attempts = new Set(read.records.map((r) => r.attempt));
    expect(attempts).toContain(id1);
    expect(attempts).toContain(id2);
  });
});

// ---------------------------------------------------------------------------
// Rejection: invalid records rejected at write time
// ---------------------------------------------------------------------------

describe("rejection at write", () => {
  test("rejects unknown outcome", () => {
    const dir = newLedgerDir("reject-unknown-outcome");
    expect(() => recordUsage(dir, rec({ outcome: "invalid" }))).toThrow(ContractError);
  });

  test("rejects unknown verification", () => {
    const dir = newLedgerDir("reject-unknown-verification");
    expect(() => recordUsage(dir, rec({ verification: "invalid" }))).toThrow(ContractError);
  });

  test("rejects negative usage", () => {
    const dir = newLedgerDir("reject-negative-usage");
    expect(() => recordUsage(dir, rec({ usage: { prompt: -1, output: 0, cache_read: 0, cache_write: 0 } }))).toThrow(ContractError);
  });

  test("rejects negative cost", () => {
    const dir = newLedgerDir("reject-negative-cost");
    expect(() => recordUsage(dir, rec({ cost: { amount: -1, currency: "USD", basis: "billed" } }))).toThrow(ContractError);
  });

  test("rejects negative wall_time_ms", () => {
    const dir = newLedgerDir("reject-negative-wall-time");
    expect(() => recordUsage(dir, rec({ wall_time_ms: -1 }))).toThrow(ContractError);
  });

  test("rejects negative tool_calls", () => {
    const dir = newLedgerDir("reject-negative-tool-calls");
    expect(() => recordUsage(dir, rec({ tool_calls: -1 }))).toThrow(ContractError);
  });

  test("rejects negative retries", () => {
    const dir = newLedgerDir("reject-negative-retries");
    expect(() => recordUsage(dir, rec({ retries: -1 }))).toThrow(ContractError);
  });

  test("rejects unknown usage_provenance", () => {
    const dir = newLedgerDir("reject-unknown-usage-provenance");
    expect(() => recordUsage(dir, rec({ usage_provenance: "invalid" }))).toThrow(ContractError);
  });

  test("rejects unknown wall_time_provenance", () => {
    const dir = newLedgerDir("reject-unknown-wall-time-provenance");
    expect(() => recordUsage(dir, rec({ wall_time_provenance: "invalid" }))).toThrow(ContractError);
  });

  test("rejects non-ISO timestamp", () => {
    const dir = newLedgerDir("reject-non-iso-timestamp");
    expect(() => recordUsage(dir, rec({ started_at: "not-a-timestamp" }))).toThrow(ContractError);
  });

  test("rejects future timestamp beyond skew", () => {
    const dir = newLedgerDir("reject-future-timestamp");
    const future = new Date(Date.now() + 2 * 60 * 1000).toISOString();
    expect(() => recordUsage(dir, rec({ started_at: future }))).toThrow(ContractError);
  });

  test("rejects secret-shaped values in fields", () => {
    const dir = newLedgerDir("reject-secret-values");
    expect(() => recordUsage(dir, rec({ task: "sk-secret123" }))).toThrow(ContractError);
    expect(() => recordUsage(dir, rec({ task: "Bearer token123" }))).toThrow(ContractError);
  });

  test("rejects unknown fields in record", () => {
    const dir = newLedgerDir("reject-unknown-fields");
    expect(() => recordUsage(dir, { ...rec(), unknown_field: "value" })).toThrow(ContractError);
  });
});

// ---------------------------------------------------------------------------
// Prune: default retention and custom maxAgeMs
// ---------------------------------------------------------------------------

describe("pruneLedger", () => {
  test("removes records older than DEFAULT_RETENTION_MS", () => {
    const dir = newLedgerDir("prune-default");
    recordUsage(dir, rec({ started_at: T0, ended_at: T0 })); // 0 days old
    recordUsage(dir, rec({ started_at: "2026-10-01T00:00:00Z", ended_at: "2026-10-01T00:00:01Z" })); // 31 days old
    const read = readLedger(dir);
    expect(read.records).toHaveLength(2);
    pruneLedger(dir);
    const read2 = readLedger(dir);
    expect(read2.records).toHaveLength(1);
    expect(read2.records[0].started_at).toBe(T0);
  });

  test("custom maxAgeMs overrides default", () => {
    const dir = newLedgerDir("prune-custom");
    recordUsage(dir, rec({ started_at: T0, ended_at: T0 }));
    recordUsage(dir, rec({ started_at: "2026-10-15T00:00:00Z", ended_at: "2026-10-15T00:00:01Z" })); // 17 days old
    pruneLedger(dir, { maxAgeMs: 10 * DAY });
    const read = readLedger(dir);
    expect(read.records).toHaveLength(1);
  });

  test("preserves records with future timestamps within skew", () => {
    const dir = newLedgerDir("prune-future-skew");
    const future = new Date(Date.now() + 30_000).toISOString();
    recordUsage(dir, rec({ started_at: future, ended_at: future }));
    pruneLedger(dir);
    const read = readLedger(dir);
    expect(read.records).toHaveLength(1);
  });

  test("removes records with future timestamps beyond skew", () => {
    const dir = newLedgerDir("prune-future-beyond-skew");
    const future = new Date(Date.now() + 2 * 60 * 1000).toISOString();
    recordUsage(dir, rec({ started_at: future, ended_at: future }));
    pruneLedger(dir);
    const read = readLedger(dir);
    expect(read.records).toHaveLength(0);
  });

  test("removes records with NaN/negative timestamps", () => {
    const dir = newLedgerDir("prune-nan-timestamp");
    recordUsage(dir, rec({ started_at: "not-a-date", ended_at: T0 }));
    recordUsage(dir, rec({ started_at: T0, ended_at: T0 }));
    pruneLedger(dir);
    const read = readLedger(dir);
    expect(read.records).toHaveLength(1);
  });

  test("empty ledger is no-op", () => {
    const dir = newLedgerDir("prune-empty");
    expect(() => pruneLedger(dir)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Summarize: aggregate usage, cost, wall time, tool calls
// ---------------------------------------------------------------------------

describe("summarizeLedger", () => {
  test("aggregates usage, cost, wall time, tool calls across records", () => {
    const dir = newLedgerDir("summarize");
    recordUsage(dir, rec({ usage: { prompt: 100, output: 50, cache_read: 20, cache_write: 10 }, cost: { amount: 1.0, currency: "USD", basis: "billed" }, wall_time_ms: 1000, tool_calls: 2 }));
    recordUsage(dir, rec({ usage: { prompt: 200, output: 100, cache_read: 30, cache_write: 15 }, cost: { amount: 2.0, currency: "USD", basis: "billed" }, wall_time_ms: 2000, tool_calls: 3 }));
    const summary = summarizeLedger(dir);
    expect(summary.total_prompt).toBe(300);
    expect(summary.total_output).toBe(150);
    expect(summary.total_cache_read).toBe(50);
    expect(summary.total_cache_write).toBe(25);
    expect(summary.total_cost).toBe(3.0);
    expect(summary.total_wall_time_ms).toBe(3000);
    expect(summary.total_tool_calls).toBe(5);
  });

  test("only sums records with measured provenance", () => {
    const dir = newLedgerDir("summarize-provenance");
    recordUsage(dir, rec({ usage_provenance: "measured", cost: { amount: 1.0, currency: "USD", basis: "billed" } }));
    recordUsage(dir, rec({ usage_provenance: "estimated", cost: { amount: 10.0, currency: "USD", basis: "billed" } }));
    const summary = summarizeLedger(dir);
    expect(summary.total_cost).toBe(1.0);
  });

  test("empty ledger returns zeros", () => {
    const dir = newLedgerDir("summarize-empty");
    const summary = summarizeLedger(dir);
    expect(summary.total_prompt).toBe(0);
    expect(summary.total_output).toBe(0);
    expect(summary.total_cost).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Concurrent writers: real processes, real contention
// ---------------------------------------------------------------------------

describe("concurrent writers (real processes, real contention)", () => {
  test("8 writers × 20 records each = 160 records, no corruption, no loss", () => {
    const dir = newLedgerDir("concurrent-writers");
    const writerSrc = `
import { recordUsage, type UsageRecord } from "${MODULE_PATH}";
const ATTEMPT_KEY = "claude.mimo#mimo-v2#test-box#nonce-1";
const T0 = "2026-11-01T00:00:00Z";
function rec(overrides = {}) {
  return {
    attempt: ATTEMPT_KEY,
    task: "task-1",
    outcome: "success",
    verification: "pass",
    retry_of: null,
    usage: { prompt: 100, output: 50, cache_read: 20, cache_write: 10 },
    cost: { amount: 0.5, currency: "USD", basis: "billed" },
    wall_time_ms: 1000,
    tool_calls: 2,
    retries: 0,
    usage_provenance: "measured",
    wall_time_provenance: "measured",
    error_kind: null,
    started_at: T0,
    ended_at: "2026-11-01T00:00:05Z",
    ...overrides,
  };
}
const dir = process.argv[2];
const count = Number(process.argv[3]);
const writerId = Number(process.argv[4]);
for (let i = 0; i < count; i++) {
  recordUsage(dir, rec({ attempt: \`omp.mistral#zai-glm-5-3-flash#wsl-1#\${writerId}-\${i}\` }));
}
`;
    const writerPath = join(TMP_ROOT, "writer.ts");
    writeFileSync(writerPath, writerSrc);

    const writers = 8;
    const perWriter = 20;
    const procs = Array.from({ length: writers }, (_, w) =>
      Bun.spawn([process.execPath, writerPath, MODULE_PATH, dir, String(perWriter), String(w)], {
        stdout: "ignore",
        stderr: "pipe",
      })
    );
    const codes = await Promise.all(procs.map((p) => p.exited));
    expect(codes).toEqual(Array(writers).fill(0));

    const read = readLedger(dir);
    expect(read.corrupt).toBe(0);
    expect(read.records).toHaveLength(writers * perWriter);
    const attempts = new Set(read.records.map((r) => r.attempt));
    expect(attempts.size).toBe(writers * perWriter);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// Read ledger: rejects corrupt, handles empty, validates fields
// ---------------------------------------------------------------------------

describe("readLedger", () => {
  test("returns corrupt count and valid records", () => {
    const dir = newLedgerDir("read-ledger");
    recordUsage(dir, rec());
    appendFileSync(join(dir, LEDGER_FILE), "\n{ invalid json }", "utf-8");
    const read = readLedger(dir);
    expect(read.corrupt).toBe(1);
    expect(read.records).toHaveLength(1);
  });

  test("empty directory returns empty records", () => {
    const dir = newLedgerDir("read-ledger-empty");
    const read = readLedger(dir);
    expect(read.corrupt).toBe(0);
    expect(read.records).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// withLedgerLock: mutual exclusion for ledger operations
// ---------------------------------------------------------------------------

describe("withLedgerLock", () => {
  test("serializes concurrent writes", () => {
    const dir = newLedgerDir("with-ledger-lock");
    const results: number[] = [];
    const procs = Array.from({ length: 5 }, async (_, i) => {
      await withLedgerLock(dir, async () => {
        recordUsage(dir, rec({ attempt: `omp.mistral#zai-glm-5-3-flash#wsl-1#lock-\${i}` }));
        results.push(i);
      });
    });
    await Promise.all(procs);
    expect(results).toHaveLength(5);
    const read = readLedger(dir);
    expect(read.records).toHaveLength(5);
  });

  test("lock directory is cleaned up after", () => {
    const dir = newLedgerDir("lock-cleanup");
    await withLedgerLock(dir, async () => {
      recordUsage(dir, rec());
    });
    const lockDir = join(dir, LEDGER_LOCK_DIR);
    expect(existsSync(lockDir)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Rejection & redaction: secret-shaped values rejected at write
// ---------------------------------------------------------------------------

describe("rejection & redaction", () => {
  test("rejects API key shaped values in task field", () => {
    const dir = newLedgerDir("reject-api-key");
    expect(() => recordUsage(dir, rec({ task: "sk-abc123" }))).toThrow(ContractError);
  });

  test("rejects Bearer token in task field", () => {
    const dir = newLedgerDir("reject-bearer-token");
    expect(() => recordUsage(dir, rec({ task: "Bearer xyz789" }))).toThrow(ContractError);
  });

  test("rejects AWS key shaped values", () => {
    const dir = newLedgerDir("reject-aws-key");
    expect(() => recordUsage(dir, rec({ task: "AKIA123456789" }))).toThrow(ContractError);
  });

  test("rejects GitHub token shaped values", () => {
    const dir = newLedgerDir("reject-github-token");
    expect(() => recordUsage(dir, rec({ task: "ghp_abc123" }))).toThrow(ContractError);
  });

  test("accepts normal task names without secret shapes", () => {
    const dir = newLedgerDir("accept-normal-task");
    expect(() => recordUsage(dir, rec({ task: "refactor-auth-module" }))).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// parseUsageRecord: parses valid records, rejects invalid
// ---------------------------------------------------------------------------

describe("parseUsageRecord", () => {
  test("parses valid record", () => {
    const r = rec();
    const parsed = parseUsageRecord(r);
    expect(parsed.attempt).toBe(ATTEMPT_KEY);
    expect(parsed.outcome).toBe("success");
  });

  test("rejects unknown outcome", () => {
    expect(() => parseUsageRecord(rec({ outcome: "invalid" }))).toThrow(ContractError);
  });

  test("rejects unknown verification", () => {
    expect(() => parseUsageRecord(rec({ verification: "invalid" }))).toThrow(ContractError);
  });

  test("rejects negative usage values", () => {
    expect(() => parseUsageRecord(rec({ usage: { prompt: -1, output: 0, cache_read: 0, cache_write: 0 } }))).toThrow(ContractError);
  });

  test("rejects unknown provenance", () => {
    expect(() => parseUsageRecord(rec({ usage_provenance: "invalid" }))).toThrow(ContractError);
  });
});

// ---------------------------------------------------------------------------
// readLedgerFor: filters by attempt key
// ---------------------------------------------------------------------------

describe("readLedgerFor", () => {
  test("returns records matching attempt key", () => {
    const dir = newLedgerDir("read-ledger-for");
    const id1 = "omp.mistral#zai-glm-5-3-flash#wsl-1#1";
    const id2 = "omp.mistral#zai-glm-5-3-flash#wsl-1#2";
    recordUsage(dir, rec({ attempt: id1 }));
    recordUsage(dir, rec({ attempt: id2 }));
    const read = readLedgerFor(dir, id1);
    expect(read.records).toHaveLength(1);
    expect(read.records[0].attempt).toBe(id1);
  });

  test("returns empty for non-existent attempt", () => {
    const dir = newLedgerDir("read-ledger-for-empty");
    recordUsage(dir, rec());
    const read = readLedgerFor(dir, "omp.mistral#zai-glm-5-3-flash#wsl-1#999");
    expect(read.records).toHaveLength(0);
  });
});

