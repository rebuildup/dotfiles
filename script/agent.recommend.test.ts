/**
 * Recommendation tests for script/agent/recommend.ts (issue #94, T008).
 *
 * ALL tests in this file are OFFLINE: pure functions over injected fixtures
 * (catalog objects, ledger records, probe reports, quota observations) plus
 * one integration test over the REAL committed config/agents.toml catalog
 * (loaded from disk, no network, no secrets, no harness binaries). There
 * are no live-provider tests here — real E2E verification is the probe
 * layer's job (script/agent.probe.test.ts); mock results are never
 * presented as real evidence.
 *
 * Run: bun test script/agent.recommend.test.ts
 */

import { describe, test, expect } from "bun:test";
import { realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  recommend,
  recommendJson,
  RECOMMEND_KNOWN_LIMITATIONS,
  type Recommendation,
  type RouteRecommendation,
} from "./agent/recommend";
import { loadCatalog, type Catalog, type ProviderCatalogEntry } from "./agent/catalog";
import { ContractError, type Evidence, type Provenance, type VerificationStatus } from "./agent/contract";

const REPO = dirname(dirname(realpathSync(import.meta.path)));
const REAL_CONFIG = join(REPO, "config", "agents.toml");

/** Reference clock: fresh for every fixture evidence date. */
const NOW = Date.parse("2026-11-06T12:00:00Z");

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

interface AttOpts {
  status?: VerificationStatus;
  provenance?: Provenance;
  at?: string | null;
  source?: Evidence["source"];
  note?: string;
}

function att<T>(value: T | null, opts: AttOpts = {}) {
  const out: Record<string, unknown> = {
    value,
    status: opts.status ?? "verified-live",
    provenance: opts.provenance ?? "measured",
    evidence:
      opts.at === null
        ? null
        : { at: opts.at ?? "2026-11-01T00:00:00Z", source: opts.source ?? "live-e2e" },
  };
  if (opts.note !== undefined) out.note = opts.note;
  return out;
}

function provider(over: Partial<ProviderCatalogEntry> = {}): ProviderCatalogEntry {
  return {
    billing: "metered",
    terms: null,
    quota: { kind: "account", id: "shared" },
    rate_limits: null,
    restriction: null,
    models: {},
    ...over,
  };
}

/** Two-provider baseline: `h.cheap` (weak/cheap) vs `h.pro` (strong/costly). */
function baseCatalog(): Catalog {
  return {
    path: "fixture",
    providers: {
      cheap: provider({
        models: {
          "m-cheap": {
            tool_call: att(true),
            context_window: att(128_000),
            recommended_for: null,
            discouraged_reason: null,
            pricing: {
              kind: "metered",
              currency: "USD",
              input_per_mtok: att(0.1, { status: "configured", provenance: "official", source: "provider-catalog" }),
              output_per_mtok: att(0.4, { status: "configured", provenance: "official", source: "provider-catalog" }),
            },
          },
        },
      }),
      pro: provider({
        quota: { kind: "account", id: "pro" },
        models: {
          "m-pro": {
            tool_call: att(true),
            context_window: att(400_000),
            recommended_for: null,
            discouraged_reason: null,
            pricing: {
              kind: "metered",
              currency: "USD",
              input_per_mtok: att(2, { status: "configured", provenance: "official", source: "provider-catalog" }),
              output_per_mtok: att(8, { status: "configured", provenance: "official", source: "provider-catalog" }),
            },
          },
        },
      }),
    },
    routes: {
      "h.cheap": { quota: null, rate_limits: null, concurrency: null, e2e: null, restriction: null },
      "h.pro": { quota: null, rate_limits: null, concurrency: null, e2e: null, restriction: null },
    },
  };
}

let nonce = 0;

interface RecOpts {
  route: string;
  model: string;
  task?: string | null;
  outcome?: "success" | "failure" | "killed";
  verification?: "pass" | "fail" | "skipped";
  cost?: { amount: number; currency?: string; basis?: "billed" | "estimated" } | null;
  usage?: { prompt: number; output: number; cache_read: number; cache_write: number } | null;
  wall?: number | null;
  started?: string;
}

function rec(opts: RecOpts): unknown {
  nonce++;
  return {
    contract_version: "1.0.0",
    attempt: `${opts.route}#${opts.model}#mach1#a${String(nonce).padStart(4, "0")}`,
    task: opts.task ?? null,
    outcome: opts.outcome ?? "success",
    verification: opts.verification ?? "pass",
    retry_of: null,
    usage: opts.usage ?? null,
    cost:
      opts.cost === undefined
        ? null
        : { amount: opts.cost.amount, currency: opts.cost.currency ?? "USD", basis: opts.cost.basis ?? "billed" },
    wall_time_ms: opts.wall ?? null,
    tool_calls: null,
    retries: null,
    started_at: opts.started ?? "2026-11-05T10:00:00Z",
    ended_at: "2026-11-05T10:05:00Z",
  };
}

function probeReport(
  route: string,
  model: string,
  layers: Array<{ layer: string; status: string; failure?: string }>,
  time = "2026-11-06T11:55:00Z", // inside the 15-min probe TTL relative to NOW
): unknown {
  return {
    contract_version: "1.0.0",
    route,
    model,
    mode: "live",
    transport: "mock",
    time,
    duration_ms: 5,
    quota_scope: null,
    layers: layers.map((l) => ({ layer: l.layer, status: l.status, failure: l.failure, evidence: null })),
    cached: false,
  };
}

function task(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "task-fix-1",
    requiresToolCall: false,
    contextTokens: null,
    complexity: "standard",
    budgetUsd: null,
    workers: 1,
    fixedRoute: null,
    ...over,
  };
}

function run(over: {
  task?: Record<string, unknown>;
  catalog?: Catalog;
  records?: unknown[];
  probes?: unknown[];
  live?: unknown[];
  now?: number;
  maxAgeMs?: number;
}): Recommendation {
  return recommend({
    task: task(over.task),
    catalog: over.catalog ?? baseCatalog(),
    records: over.records ?? [],
    probes: over.probes ?? [],
    live: over.live ?? [],
    now: over.now ?? NOW,
    maxAgeMs: over.maxAgeMs,
  });
}

function byRoute(result: Recommendation, routeId: string): RouteRecommendation {
  const r = result.routes.find((x) => x.routeId === routeId);
  if (!r) throw new Error(`route ${routeId} missing from result`);
  return r;
}

// ---------------------------------------------------------------------------
// Input validation (fail closed)
// ---------------------------------------------------------------------------

describe("input validation", () => {
  test("rejects NaN/Infinity/negative/huge contextTokens", () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -1, 0, 1.5, 2e9]) {
      expect(() => run({ task: { contextTokens: bad } })).toThrow(ContractError);
    }
  });

  test("rejects malformed budget", () => {
    for (const bad of [Number.NaN, Number.NEGATIVE_INFINITY, -0.01, 2e9, "10"]) {
      expect(() => run({ task: { budgetUsd: bad } })).toThrow(ContractError);
    }
  });

  test("rejects bad workers, complexity, requiresToolCall", () => {
    expect(() => run({ task: { workers: 0 } })).toThrow(ContractError);
    expect(() => run({ task: { workers: 2000 } })).toThrow(ContractError);
    expect(() => run({ task: { complexity: "extreme" } })).toThrow(ContractError);
    expect(() => run({ task: { requiresToolCall: "yes" } })).toThrow(ContractError);
  });

  test("rejects empty, whitespace, oversize and secret-shaped task ids", () => {
    expect(() => run({ task: { id: "" } })).toThrow(ContractError);
    expect(() => run({ task: { id: "   " } })).toThrow(ContractError);
    expect(() => run({ task: { id: "x".repeat(129) } })).toThrow(ContractError);
    expect(() => run({ task: { id: "sk-abcdefghijklmnop" } })).toThrow(ContractError);
  });

  test("rejects malformed fixedRoute", () => {
    expect(() => run({ task: { fixedRoute: "no-dot" } })).toThrow(ContractError);
    expect(() => run({ task: { fixedRoute: "" } })).toThrow(ContractError);
    expect(() => run({ task: { fixedRoute: 42 } })).toThrow(ContractError);
  });

  test("rejects unknown task fields and non-table task", () => {
    expect(() => run({ task: { evil: 1 } })).toThrow(ContractError);
    expect(() => recommend({ task: "x" as never, catalog: baseCatalog() })).toThrow(ContractError);
  });

  test("rejects malformed ledger records (hostile input never silently narrows)", () => {
    expect(() => run({ records: [{ attempt: "garbage" }] })).toThrow(ContractError);
    expect(() =>
      run({ records: [rec({ route: "h.cheap", model: "m-cheap", outcome: "bogus" as never })] }),
    ).toThrow(ContractError);
  });

  test("rejects malformed probe reports", () => {
    expect(() => run({ probes: [{ route: "h.cheap" }] })).toThrow(ContractError);
    expect(() =>
      run({
        probes: [
          probeReport("h.cheap", "m-cheap", [{ layer: "credential", status: "bogus" }]),
        ],
      }),
    ).toThrow(ContractError);
    expect(() =>
      run({ probes: [probeReport("h.cheap", "m-cheap", [{ layer: "credential", status: "pass" }], "not-a-date")] }),
    ).toThrow(ContractError);
  });

  test("rejects non-finite now and non-positive maxAgeMs", () => {
    expect(() => run({ now: Number.NaN })).toThrow(ContractError);
    expect(() => run({ now: -1 })).toThrow(ContractError);
    expect(() => run({ maxAgeMs: 0 })).toThrow(ContractError);
  });
});

// ---------------------------------------------------------------------------
// Explainable ranking (acceptance: low-complexity / architecture / budget)
// ---------------------------------------------------------------------------

describe("task-aware ranking", () => {
  const records = (task: string | null) => [
    // cheap: 3/5 measured successes (60%), $0.02/task, 60s
    rec({ route: "h.cheap", model: "m-cheap", task, cost: { amount: 0.02 }, usage: { prompt: 10_000, output: 5_000, cache_read: 0, cache_write: 0 }, wall: 60_000 }),
    rec({ route: "h.cheap", model: "m-cheap", task, cost: { amount: 0.02 }, usage: { prompt: 10_000, output: 5_000, cache_read: 0, cache_write: 0 }, wall: 60_000 }),
    rec({ route: "h.cheap", model: "m-cheap", task, cost: { amount: 0.02 }, usage: { prompt: 10_000, output: 5_000, cache_read: 0, cache_write: 0 }, wall: 60_000 }),
    rec({ route: "h.cheap", model: "m-cheap", task, outcome: "failure" as const, cost: { amount: 0.02 }, usage: { prompt: 10_000, output: 5_000, cache_read: 0, cache_write: 0 }, wall: 60_000 }),
    rec({ route: "h.cheap", model: "m-cheap", task, outcome: "failure" as const, cost: { amount: 0.02 }, usage: { prompt: 10_000, output: 5_000, cache_read: 0, cache_write: 0 }, wall: 60_000 }),
    // pro: 5/5 measured successes, $0.20/task, 120s
    rec({ route: "h.pro", model: "m-pro", task, cost: { amount: 0.2 }, usage: { prompt: 20_000, output: 10_000, cache_read: 0, cache_write: 0 }, wall: 120_000 }),
    rec({ route: "h.pro", model: "m-pro", task, cost: { amount: 0.2 }, usage: { prompt: 20_000, output: 10_000, cache_read: 0, cache_write: 0 }, wall: 120_000 }),
    rec({ route: "h.pro", model: "m-pro", task, cost: { amount: 0.2 }, usage: { prompt: 20_000, output: 10_000, cache_read: 0, cache_write: 0 }, wall: 120_000 }),
    rec({ route: "h.pro", model: "m-pro", task, cost: { amount: 0.2 }, usage: { prompt: 20_000, output: 10_000, cache_read: 0, cache_write: 0 }, wall: 120_000 }),
    rec({ route: "h.pro", model: "m-pro", task, cost: { amount: 0.2 }, usage: { prompt: 20_000, output: 10_000, cache_read: 0, cache_write: 0 }, wall: 120_000 }),
  ];

  test("low-complexity task on a low budget: cheap route wins", () => {
    const result = run({
      task: { complexity: "low", budgetUsd: 0.05 },
      records: records("task-fix-1"),
    });
    expect(result.routes[0].routeId).toBe("h.cheap");
    expect(result.routes[0].verdict).toBe("recommended");
    expect(result.routes[0].score).not.toBeNull();
    // The costly route stays usable but is ranked and flagged.
    const pro = byRoute(result, "h.pro");
    expect(pro.verdict).not.toBe("recommended");
    expect(pro.alternatives).toContain("h.cheap");
  });

  test("architecture (high complexity): quality dominates cost", () => {
    const result = run({ task: { complexity: "high" }, records: records("task-fix-1") });
    expect(result.routes[0].routeId).toBe("h.pro");
    expect(result.routes[0].verdict).toBe("recommended");
  });

  test("low budget excludes routes whose measured cost exceeds it", () => {
    const result = run({ task: { budgetUsd: 0.05 }, records: records("task-fix-1") });
    const pro = byRoute(result, "h.pro");
    expect(pro.verdict).toBe("unavailable");
    expect(pro.reasons.some((r) => r.kind === "budget" && r.impact === "blocking" && r.provenance === "measured")).toBe(true);
  });

  test("quality reasons cite measured provenance with sample size", () => {
    const result = run({ records: records("task-fix-1") });
    const cheap = byRoute(result, "h.cheap");
    const q = cheap.reasons.find((r) => r.kind === "quality" && r.impact === "positive");
    expect(q?.provenance).toBe("measured");
    expect(q?.detail).toContain("3/5");
    expect(cheap.sampleSize).toBe(5);
    expect(cheap.confidence).toBe("medium"); // 5 decided => medium (low is <5)
  });
});

// ---------------------------------------------------------------------------
// Negative tests (acceptance: measured mismatch, unknown quota, 0 samples,
// cached tokens, pinned route)
// ---------------------------------------------------------------------------

describe("fail-closed negative tests", () => {
  test("0 samples: never recommended, confidence none", () => {
    const result = run({}); // no records at all
    for (const r of result.routes) {
      expect(r.verdict).not.toBe("recommended");
      expect(r.sampleSize).toBe(0);
      expect(r.confidence).toBe("none");
      expect(r.reasons.some((x) => x.kind === "quality" && /never assumed healthy/.test(x.detail))).toBe(true);
    }
  });

  test("unknown quota state caps at conditional", () => {
    // Route known only through measured records; catalog silent on quota.
    const catalog = baseCatalog();
    delete (catalog.providers.cheap as { quota?: unknown }).quota;
    const result = run({
      catalog,
      records: [rec({ route: "h.cheap", model: "m-cheap", task: "task-fix-1", cost: { amount: 0.02 } })],
    });
    const cheap = byRoute(result, "h.cheap");
    expect(cheap.verdict).toBe("conditional");
    expect(cheap.reasons.some((r) => r.kind === "quota" && /unknown/.test(r.detail))).toBe(true);
  });

  test("measured condition mismatch: failing success rate deprecates the route", () => {
    const recs = [
      rec({ route: "h.cheap", model: "m-cheap", task: "task-fix-1", outcome: "failure" }),
      rec({ route: "h.cheap", model: "m-cheap", task: "task-fix-1", outcome: "failure" }),
      rec({ route: "h.cheap", model: "m-cheap", task: "task-fix-1", outcome: "failure" }),
      rec({ route: "h.cheap", model: "m-cheap", task: "task-fix-1", outcome: "success" }),
    ];
    const result = run({ records: recs });
    const cheap = byRoute(result, "h.cheap");
    expect(cheap.verdict).toBe("deprecated");
    expect(cheap.reasons.some((r) => r.kind === "quality" && r.impact === "negative")).toBe(true);
  });

  test("unverified successes never count as success (telemetry semantics)", () => {
    const recs = [
      rec({ route: "h.cheap", model: "m-cheap", task: "task-fix-1", verification: "skipped" }),
      rec({ route: "h.cheap", model: "m-cheap", task: "task-fix-1", verification: "skipped" }),
    ];
    const result = run({ records: recs });
    const cheap = byRoute(result, "h.cheap");
    expect(cheap.verdict).toBe("deprecated");
    expect(cheap.reasons.some((r) => r.kind === "quality" && r.impact === "negative")).toBe(true);
  });

  test("high cached-token ratio does not rescue a bad effective cost", () => {
    // h.cheap: cache_read 90% yet still $0.90/task billed; h.pro: $0.05/task.
    const recs = [
      rec({ route: "h.cheap", model: "m-cheap", task: "task-fix-1", cost: { amount: 0.9 }, usage: { prompt: 1_000_000, output: 100_000, cache_read: 900_000, cache_write: 0 } }),
      rec({ route: "h.pro", model: "m-pro", task: "task-fix-1", cost: { amount: 0.05 }, usage: { prompt: 40_000, output: 10_000, cache_read: 0, cache_write: 0 } }),
    ];
    const result = run({ records: recs });
    const cheap = byRoute(result, "h.cheap");
    const pro = byRoute(result, "h.pro");
    // The cache ratio never enters the cost basis: billed cost is what
    // counts, so the high-cache route is capped and ranked below.
    expect(cheap.verdict).not.toBe("recommended");
    expect(cheap.reasons.some((r) => r.kind === "cost" && r.impact === "negative" && r.provenance === "measured")).toBe(true);
    expect(pro.verdict).toBe("recommended");
    expect(result.routes[0].routeId).toBe("h.pro");
  });

  test("explicitly pinned route: evaluated alone, verdict never upgraded", () => {
    const result = run({
      task: { fixedRoute: "h.pro", budgetUsd: 0.05 },
      records: [
        rec({ route: "h.pro", model: "m-pro", task: "task-fix-1", cost: { amount: 0.2 } }),
        rec({ route: "h.cheap", model: "m-cheap", task: "task-fix-1", cost: { amount: 0.02 } }),
      ],
    });
    expect(result.routes.map((r) => r.routeId)).toEqual(["h.pro"]);
    expect(result.routes[0].verdict).toBe("unavailable");
    expect(result.routes[0].alternatives).toEqual([]);
    expect(result.routes[0].reasons.some((r) => r.kind === "pin")).toBe(true);
  });

  test("explicitly pinned healthy route keeps an honest verdict", () => {
    const result = run({
      task: { fixedRoute: "h.cheap" },
      records: [rec({ route: "h.cheap", model: "m-cheap", task: "task-fix-1", cost: { amount: 0.02 } })],
    });
    expect(result.routes).toHaveLength(1);
    expect(result.routes[0].verdict).toBe("recommended");
  });

  test("stale capability evidence is treated as unknown (never healthy)", () => {
    const catalog = baseCatalog();
    catalog.providers.cheap.models["m-cheap"].tool_call = att(true, { at: "2026-10-01T00:00:00Z" });
    const result = run({
      catalog,
      task: { requiresToolCall: true },
      records: [rec({ route: "h.cheap", model: "m-cheap", task: "task-fix-1" })],
    });
    expect(byRoute(result, "h.cheap").verdict).toBe("conditional");
    // The stale fact must be reported as stale, not as missing-model.
    expect(
      byRoute(result, "h.cheap").reasons.some((r) => /unknown or stale/.test(r.detail)),
    ).toBe(true);
  });

  test("stale observed restriction is dropped fail-closed, not enforced forever", () => {
    const catalog = baseCatalog();
    catalog.providers.cheap.restriction = att(null, {
      status: "restricted",
      provenance: "measured",
      at: "2026-10-01T00:00:00Z",
      note: "HTTP 402 observed (stale)",
    });
    const result = run({ catalog });
    // Stale block dropped (fail-closed expiry), but quota state is then
    // unknown -> conditional, never recommended.
    expect(byRoute(result, "h.cheap").verdict).toBe("conditional");
  });
});

// ---------------------------------------------------------------------------
// Capacity vs quality (402/429 never a model-quality signal)
// ---------------------------------------------------------------------------

describe("capacity failures are availability, never quality", () => {
  test("live quota exhaustion (429-style) -> unavailable with reset time", () => {
    const result = run({
      live: [
        {
          window: "day",
          metric: "requests",
          limit: 1000,
          remaining: 0,
          used: 1000,
          resetAt: "2026-11-06T18:00:00Z",
          provenance: "measured",
          evidence: { at: "2026-11-06T11:55:00Z", source: "probe" }, // inside the 10-min live window
        },
      ],
      records: [rec({ route: "h.cheap", model: "m-cheap", task: "task-fix-1", cost: { amount: 0.02 } })],
    });
    const cheap = byRoute(result, "h.cheap");
    expect(cheap.verdict).toBe("unavailable");
    const q = cheap.reasons.find((r) => r.kind === "quota" && r.impact === "blocking");
    expect(q?.detail).toContain("capacity, not model quality");
    expect(q?.detail).toContain("resets 2026-11-06T18:00:00Z");
  });

  test("observed 402 payment restriction -> unavailable, quality untouched", () => {
    const catalog = baseCatalog();
    catalog.providers.cheap.restriction = att(null, {
      status: "restricted",
      provenance: "measured",
      note: "HTTP 402 payment required from this account",
    });
    const result = run({
      catalog,
      records: [rec({ route: "h.cheap", model: "m-cheap", task: "task-fix-1", cost: { amount: 0.02 } })],
    });
    const cheap = byRoute(result, "h.cheap");
    expect(cheap.verdict).toBe("unavailable");
    expect(cheap.reasons.some((r) => r.kind === "quota" && r.impact === "blocking")).toBe(true);
    // No quality reason is generated for a capacity block: quality stays "no
    // measured outcomes"-shaped only when there are truly no samples.
  });

  test("probe auth failure blocks availability and cites the layer", () => {
    const result = run({
      probes: [
        probeReport("h.cheap", "m-cheap", [
          { layer: "credential", status: "pass" },
          { layer: "wire", status: "fail", failure: "auth" },
        ]),
      ],
    });
    const cheap = byRoute(result, "h.cheap");
    expect(cheap.verdict).toBe("unavailable");
    const p = cheap.reasons.find((r) => r.kind === "probe" && r.impact === "blocking");
    expect(p?.detail).toContain("auth");
    expect(p?.detail).toContain("not model quality");
  });

  test("stale probe evidence -> conditional (state unknown), never recommended", () => {
    const result = run({
      probes: [probeReport("h.cheap", "m-cheap", [{ layer: "credential", status: "pass" }], "2026-11-05T00:00:00Z")],
      records: [rec({ route: "h.cheap", model: "m-cheap", task: "task-fix-1", cost: { amount: 0.02 } })],
      maxAgeMs: 60 * 60 * 1000, // probe report is >1h old relative to NOW
    });
    expect(byRoute(result, "h.cheap").verdict).toBe("conditional");
  });
});

// ---------------------------------------------------------------------------
// Capability and budget gates
// ---------------------------------------------------------------------------

describe("capability and budget gates", () => {
  test("large context: too-small enforced window blocks; unknown window caps", () => {
    const small = run({
      task: { contextTokens: 200_000 },
      records: [rec({ route: "h.cheap", model: "m-cheap", task: "task-fix-1" }), rec({ route: "h.pro", model: "m-pro", task: "task-fix-1" })],
    });
    expect(byRoute(small, "h.cheap").verdict).toBe("unavailable");
    expect(byRoute(small, "h.cheap").reasons.some((r) => r.kind === "capability" && r.impact === "blocking")).toBe(true);
    expect(byRoute(small, "h.pro").verdict).toBe("recommended");

    const unknownCatalog = baseCatalog();
    unknownCatalog.providers.cheap.models["m-cheap"].context_window = null;
    const unknown = run({
      catalog: unknownCatalog,
      task: { contextTokens: 200_000 },
      records: [rec({ route: "h.cheap", model: "m-cheap", task: "task-fix-1" })],
    });
    expect(byRoute(unknown, "h.cheap").verdict).toBe("conditional");
  });

  test("tool-call required: unsupported blocks, unverified caps", () => {
    const noTool = baseCatalog();
    noTool.providers.cheap.models["m-cheap"].tool_call = att(false);
    const blocked = run({
      catalog: noTool,
      task: { requiresToolCall: true },
      records: [rec({ route: "h.cheap", model: "m-cheap", task: "task-fix-1" })],
    });
    expect(byRoute(blocked, "h.cheap").verdict).toBe("unavailable");

    const unknownTool = baseCatalog();
    unknownTool.providers.cheap.models["m-cheap"].tool_call = null;
    const capped = run({
      catalog: unknownTool,
      task: { requiresToolCall: true },
      records: [rec({ route: "h.cheap", model: "m-cheap", task: "task-fix-1" })],
    });
    expect(byRoute(capped, "h.cheap").verdict).toBe("conditional");
  });

  test("documented concurrency below requested workers caps at conditional", () => {
    const catalog = baseCatalog();
    catalog.routes["h.cheap"] = {
      quota: null,
      rate_limits: null,
      concurrency: att(2, { status: "configured", provenance: "official", source: "provider-docs" }),
      e2e: null,
      restriction: null,
    };
    const result = run({ catalog, task: { workers: 4 } });
    const cheap = byRoute(result, "h.cheap");
    expect(cheap.verdict).toBe("conditional");
    expect(cheap.reasons.some((r) => r.kind === "concurrency")).toBe(true);
  });

  test("non-USD measured costs are never converted; affordability caps at conditional", () => {
    const result = run({
      task: { budgetUsd: 1 },
      records: [rec({ route: "h.cheap", model: "m-cheap", task: "task-fix-1", cost: { amount: 5, currency: "EUR" } })],
    });
    const cheap = byRoute(result, "h.cheap");
    expect(cheap.verdict).toBe("conditional");
    expect(cheap.reasons.some((r) => r.kind === "budget" && /never converted/.test(r.detail))).toBe(true);
  });

  test("estimated catalog cost over budget blocks, citing estimated provenance", () => {
    const result = run({
      task: { budgetUsd: 0.001 },
      records: [rec({ route: "h.cheap", model: "m-cheap", task: "task-fix-1", usage: { prompt: 1_000_000, output: 1_000_000, cache_read: 0, cache_write: 0 } })],
    });
    const cheap = byRoute(result, "h.cheap");
    expect(cheap.verdict).toBe("unavailable");
    const b = cheap.reasons.find((r) => r.kind === "budget");
    expect(b?.provenance).toBe("estimated");
  });
});

// ---------------------------------------------------------------------------
// Output shape / machine readability
// ---------------------------------------------------------------------------

describe("machine-readable output", () => {
  test("ranking order, ranks and alternatives are consistent", () => {
    const result = run({
      records: [
        rec({ route: "h.cheap", model: "m-cheap", task: "task-fix-1", outcome: "failure" }),
        rec({ route: "h.cheap", model: "m-cheap", task: "task-fix-1", outcome: "failure" }),
        rec({ route: "h.pro", model: "m-pro", task: "task-fix-1", cost: { amount: 0.2 } }),
      ],
    });
    const order = { recommended: 0, conditional: 1, deprecated: 2, unavailable: 3 };
    const verdicts = result.routes.map((r) => order[r.verdict]);
    expect([...verdicts].sort((a, b) => a - b)).toEqual(verdicts);
    result.routes.forEach((r, i) => expect(r.rank).toBe(i + 1));
    const dep = result.routes.find((r) => r.verdict === "deprecated");
    expect(dep?.alternatives).toContain("h.pro");
  });

  test("recommendJson emits redacted, parseable JSON with known limitations echoed", () => {
    const result = run({ records: [rec({ route: "h.cheap", model: "m-cheap", task: "task-fix-1", cost: { amount: 0.02 } })] });
    const parsed = JSON.parse(recommendJson(result));
    expect(parsed.task.id).toBe("task-fix-1");
    expect(parsed.routes.length).toBeGreaterThan(0);
    expect(parsed.knownLimitations).toEqual([...RECOMMEND_KNOWN_LIMITATIONS]);
    expect(parsed.generatedAt).toBe("2026-11-06T12:00:00.000Z");
  });

  test("task-matched records are preferred over route-wide fallback, and the fallback is disclosed", () => {
    const matched = run({
      records: [rec({ route: "h.cheap", model: "m-cheap", task: "task-fix-1", outcome: "failure" })],
    });
    expect(matched.routes[0].reasons.some((r) => /route-wide/.test(r.detail))).toBe(false);

    const fallback = run({
      records: [rec({ route: "h.cheap", model: "m-cheap", task: "other-task", outcome: "failure" })],
    });
    expect(byRoute(fallback, "h.cheap").reasons.some((r) => /route-wide/.test(r.detail))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Real committed catalog (integration, offline)
// ---------------------------------------------------------------------------

describe("real config/agents.toml catalog", () => {
  // The committed zen restriction evidence (2026-10-16) is older than the
  // 7-day contract default; widen the window so the OBSERVED block is still
  // enforceable for this test. No network, no secrets.
  const catalog = loadCatalog(REAL_CONFIG);
  const result = recommend({
    task: {
      id: "smoke-low",
      requiresToolCall: false,
      contextTokens: null,
      complexity: "low",
      budgetUsd: null,
      workers: 1,
      fixedRoute: null,
    },
    catalog,
    now: NOW,
    maxAgeMs: 60 * 24 * 60 * 60 * 1000,
  });

  test("client-bound zen provider is unavailable from the observed restriction", () => {
    // zen has no route-level catalog entry; a measured record makes it a
    // candidate, and the provider-level observed 403 block must exclude it.
    const withZen = recommend({
      task: {
        id: "smoke-low",
        requiresToolCall: false,
        contextTokens: null,
        complexity: "low",
        budgetUsd: null,
        workers: 1,
        fixedRoute: null,
      },
      catalog,
      records: [
        {
          contract_version: "1.0.0",
          attempt: "opencode.zen#zen-model#mach1#a1",
          task: "smoke-low",
          outcome: "success",
          verification: "pass",
          retry_of: null,
          usage: null,
          cost: null,
          wall_time_ms: null,
          tool_calls: null,
          retries: null,
          started_at: "2026-11-05T10:00:00Z",
          ended_at: "2026-11-05T10:05:00Z",
        },
      ],
      now: NOW,
      maxAgeMs: 60 * 24 * 60 * 60 * 1000,
    });
    const zen = byRoute(withZen, "opencode.zen");
    expect(zen.verdict).toBe("unavailable");
    expect(zen.reasons.some((r) => r.kind === "quota" && r.impact === "blocking" && /403/.test(r.detail))).toBe(true);
  });

  test("measured free route with documented quota ranks first", () => {
    const withRecord = recommend({
      task: {
        id: "smoke-low",
        requiresToolCall: false,
        contextTokens: null,
        complexity: "low",
        budgetUsd: null,
        workers: 1,
        fixedRoute: null,
      },
      catalog,
      records: [
        {
          contract_version: "1.0.0",
          attempt: "claude.openrouter-free#nvidia/nemotron-3-ultra-550b-a55b:free#mach1#a1",
          task: "smoke-low",
          outcome: "success",
          verification: "pass",
          retry_of: null,
          usage: { prompt: 10_000, output: 5_000, cache_read: 0, cache_write: 0 },
          cost: { amount: 0, currency: "USD", basis: "billed" },
          wall_time_ms: 45_000,
          tool_calls: 1,
          retries: 0,
          started_at: "2026-11-05T10:00:00Z",
          ended_at: "2026-11-05T10:05:00Z",
        },
      ],
      now: NOW,
      maxAgeMs: 60 * 24 * 60 * 60 * 1000,
    });
    expect(withRecord.routes[0].routeId).toBe("claude.openrouter-free");
    expect(withRecord.routes[0].verdict).toBe("recommended");
    // Routes without any measured record stay capped (0 samples everywhere
    // else — honest, fail-closed).
    expect(withRecord.routes.slice(1).every((r) => r.verdict !== "recommended")).toBe(true);
    expect(withRecord.routes[0].confidence).toBe("low");
  });

  test("every verdict carries its evidence or an explicit unknown-fact reason", () => {
    for (const r of result.routes) {
      expect(r.reasons.length).toBeGreaterThan(0);
      for (const reason of r.reasons) {
        if (reason.provenance !== null) {
          expect(["measured", "estimated", "official"]).toContain(reason.provenance);
        }
      }
    }
  });
});
