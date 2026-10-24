import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  assessQuality,
  loadQualityStore,
  rankQualified,
  type EvidenceStore,
  type Evaluation,
  type Trial,
} from "./agent-quality";

const now = new Date("2026-10-24T12:00:00Z");
const recent = "2026-10-23T12:00:00Z";
const policy = { fixtureDigest: "sha256:fixture-v1", harnessVersion: "1.0.0" };
function trials(model: string, count = 3): Trial[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `trial-${i}`,
    evaluated_at: recent,
    success: true,
    integrity_passed: true,
    observed_model: model,
    tool_calls: 4,
    tool_failures: 0,
    duration_ms: 1000,
    failure_kind: null,
    failure_reason: null,
  }));
}
function evaluation(model: string): Evaluation {
  return {
    model_id: model,
    provider: "openrouter",
    harness: "pi",
    harness_version: "1.0.0",
    evaluated_at: recent,
    evaluation_version: "agent-e2e-v8",
    fixture_digest: "sha256:fixture-v1",
    conditions: {
      max_requests_per_trial: 24,
      timeout_seconds: 240,
      generation_profile: "isolated-default-v1",
    },
    benchmarks: [],
    trials: trials(model),
  };
}
function store(): EvidenceStore {
  return {
    schema_version: 1,
    evaluation_version: "agent-e2e-v8",
    fixture_digest: "sha256:fixture-v1",
    calibration: {
      calibrated_at: recent,
      rationale:
        "Measured same-fixture baseline; require comparable reliability.",
      baselines: [
        { model_id: "baseline", harness: "pi", evaluated_at: recent },
      ],
    },
    evaluations: [evaluation("baseline"), evaluation("candidate:free")],
  };
}
function assess(data: EvidenceStore) {
  return assessQuality(data, "candidate:free", "pi", now, policy);
}

describe("quality evidence admission", () => {
  test.each([
    {
      max_requests_per_trial: 8,
      timeout_seconds: 240,
      generation_profile: "isolated-default-v1",
    },
    {
      max_requests_per_trial: 24,
      timeout_seconds: 60,
      generation_profile: "isolated-default-v1",
    },
    {
      max_requests_per_trial: 24,
      timeout_seconds: 240,
      generation_profile: "different-generation-v1",
    },
  ])(
    "different evaluation conditions cannot qualify against the baseline: %j",
    (conditions) => {
      const data = store();
      data.evaluations[1].conditions = conditions;
      expect(assess(data).status).toBe("unverified");
      expect(assess(data).reasons.join(" ")).toContain("conditions");
    },
  );
  test.each([
    undefined,
    null,
    {
      max_requests_per_trial: 0,
      timeout_seconds: 240,
      generation_profile: "isolated-default-v1",
    },
    {
      max_requests_per_trial: 24,
      timeout_seconds: -1,
      generation_profile: "isolated-default-v1",
    },
    {
      max_requests_per_trial: 1.5,
      timeout_seconds: 240,
      generation_profile: "isolated-default-v1",
    },
    {
      max_requests_per_trial: 24,
      timeout_seconds: Infinity,
      generation_profile: "isolated-default-v1",
    },
    {
      max_requests_per_trial: 24,
      timeout_seconds: 240,
      generation_profile: "",
    },
  ])("missing or malformed conditions fail closed: %j", (conditions) => {
    const data = store();
    (data.evaluations[1] as unknown as Record<string, unknown>).conditions =
      conditions;
    expect(assess(data).status).toBe("unverified");
    expect(assess(data).reasons.join(" ")).toContain("schema");
  });
  test("cannot cherry-pick matching batches from conflicting fresh candidate profiles", () => {
    const data = store();
    const other = evaluation("candidate:free");
    other.trials = trials(other.model_id).map((t) => ({
      ...t,
      id: `other-${t.id}`,
    }));
    other.conditions = { ...other.conditions, max_requests_per_trial: 8 };
    data.evaluations.push(other);
    expect(assess(data).status).toBe("unverified");
  });
  test("all fresh baseline batches must share the explicitly referenced profile", () => {
    const data = store();
    const other = evaluation("baseline");
    other.evaluated_at = "2026-10-22T12:00:00Z";
    other.trials = trials(other.model_id).map((t) => ({
      ...t,
      id: `other-${t.id}`,
      evaluated_at: other.evaluated_at,
    }));
    other.conditions = { ...other.conditions, timeout_seconds: 60 };
    data.evaluations.push(other);
    expect(assess(data).status).toBe("unverified");
    expect(assess(data).reasons.join(" ")).toContain("conditions");
  });
  test("stale archived condition profiles do not prevent current requalification", () => {
    const data = store();
    for (const model of ["baseline", "candidate:free"]) {
      const archived = evaluation(model);
      archived.evaluated_at = "2026-09-01T12:00:00Z";
      archived.trials = trials(model).map((t) => ({
        ...t,
        evaluated_at: archived.evaluated_at,
      }));
      archived.conditions = {
        ...archived.conditions,
        max_requests_per_trial: 8,
      };
      data.evaluations.push(archived);
    }
    expect(assess(data).status).toBe("qualified");
  });
  test("capability timeouts remain failures alongside earlier successes", () => {
    const data = store();
    data.evaluations[1].trials.push({
      ...trials("candidate:free", 1)[0],
      id: "timed-out",
      success: false,
      duration_ms: 240000,
      failure_kind: "capability",
      failure_reason: "Task did not complete before the deadline",
    });
    const result = assess(data);
    expect(result.status).toBe("rejected");
    expect(result.metrics?.capability_trials).toBe(4);
    expect(result.metrics?.completion_rate).toBe(0.75);
    expect(result.metrics?.infrastructure_failures).toBe(0);
  });
  test("qualifies only measured baseline-comparable model and harness evidence", () => {
    const result = assess(store());
    expect(result.status).toBe("qualified");
    expect(result.metrics?.capability_trials).toBe(3);
    expect(result.metrics?.completion_rate).toBe(1);
    expect(result.metrics?.completion_lower_bound).toBeCloseTo(0.4385, 3);
    expect(result.reasons.join(" ")).toContain("baseline");
  });
  test("new models never inherit another model's evidence", () => {
    expect(assessQuality(store(), "new:free", "pi", now, policy).status).toBe(
      "unverified",
    );
  });
  test("an unevaluated harness never inherits another harness's result", () => {
    expect(
      assessQuality(store(), "candidate:free", "claude", now, policy).status,
    ).toBe("unverified");
  });
  test("one successful trial cannot qualify even if a caller lowers the floor", () => {
    const data = store();
    data.evaluations[1].trials = trials("candidate:free", 1);
    expect(
      assessQuality(data, "candidate:free", "pi", now, {
        ...policy,
        minCapabilityTrials: 1,
      }).status,
    ).toBe("unverified");
  });
  test("uncalibrated data cannot qualify", () => {
    const data = store();
    data.calibration = null;
    expect(assess(data).status).toBe("unverified");
  });
  test("a missing baseline reference cannot fabricate thresholds", () => {
    const data = store();
    data.evaluations.shift();
    expect(assess(data).status).toBe("unverified");
  });
  test("a low-success baseline cannot lower the required development acceptance floor", () => {
    const data = store();
    for (const trial of data.evaluations[0].trials.slice(1)) {
      trial.success = false;
      trial.failure_kind = "capability";
      trial.failure_reason = "Acceptance test failure";
    }
    expect(assess(data).status).toBe("unverified");
  });
  test("all successful graded trials can calibrate despite recovered tool failures", () => {
    const data = store();
    data.evaluations[0].trials[0].tool_calls = 40;
    data.evaluations[0].trials[0].tool_failures = 32;
    expect(assess(data).status).toBe("qualified");
  });
  test("a baseline with no successful tool calls cannot calibrate", () => {
    const data = store();
    for (const trial of data.evaluations[0].trials) {
      trial.tool_calls = 10;
      trial.tool_failures = 10;
    }
    expect(assess(data).status).toBe("unverified");
  });
  test("a baseline with unverified fixture integrity cannot calibrate admission", () => {
    const data = store();
    data.evaluations[0].trials[0].integrity_passed = false;
    expect(assess(data).status).toBe("unverified");
  });
  test("a clean referenced baseline batch cannot hide other fresh baseline failures", () => {
    const data = store();
    const failed = evaluation("baseline");
    failed.evaluated_at = "2026-10-22T12:00:00Z";
    failed.trials = [
      {
        ...trials("baseline", 1)[0],
        id: "baseline-failure",
        evaluated_at: failed.evaluated_at,
        success: false,
        failure_kind: "capability",
        failure_reason: "Failed acceptance tests",
      },
    ];
    data.evaluations.push(failed);
    expect(assess(data).status).toBe("unverified");
  });
  test("a stale baseline blocks a fresh candidate", () => {
    const data = store();
    data.evaluations[0].evaluated_at = "2026-10-01T12:00:00Z";
    data.evaluations[0].trials.forEach((t) => {
      t.evaluated_at = "2026-10-01T12:00:00Z";
    });
    data.calibration!.baselines[0].evaluated_at =
      data.evaluations[0].evaluated_at;
    expect(assess(data).status).toBe("unverified");
  });
  test.each(["2026-10-01T12:00:00Z", "2026-10-25T12:00:00Z", "invalid"])(
    "fails closed on noncurrent candidate timestamp %s",
    (timestamp) => {
      const data = store();
      data.evaluations[1].evaluated_at = timestamp;
      expect(assess(data).status).not.toBe("qualified");
    },
  );
  test("stale individual trials do not hide under a refreshed evaluation timestamp", () => {
    const data = store();
    data.evaluations[1].trials[0].evaluated_at = "2026-10-01T12:00:00Z";
    expect(assess(data).status).not.toBe("qualified");
  });
  test.each(["evaluation_version", "fixture_digest", "harness_version"])(
    "rejects mismatched %s",
    (key) => {
      const data = store();
      (data.evaluations[1] as unknown as Record<string, unknown>)[key] =
        "different";
      expect(assess(data).status).not.toBe("qualified");
    },
  );
  test("rejects a store with an unsupported evaluation version", () => {
    const data = store();
    data.evaluation_version = "unsupported";
    data.evaluations.forEach((e) => {
      e.evaluation_version = "unsupported";
    });
    expect(assess(data).status).not.toBe("qualified");
  });
  test("does not accept an obsolete fixture merely because its internal references agree", () => {
    const data = store();
    data.fixture_digest = "old";
    data.evaluations.forEach((e) => {
      e.fixture_digest = "old";
    });
    expect(assess(data).status).not.toBe("qualified");
  });
  test.each([null, "other-model"])(
    "requires actual observed model identity (%s)",
    (observed) => {
      const data = store();
      data.evaluations[1].trials[0].observed_model = observed;
      expect(assess(data).status).not.toBe("qualified");
    },
  );
  test("unverified tool traces cannot qualify a successful task", () => {
    const data = store();
    data.evaluations[1].trials[0].tool_calls = 0;
    expect(assess(data).status).not.toBe("qualified");
  });
  test("tampered fixture integrity cannot qualify", () => {
    const data = store();
    data.evaluations[1].trials[0].integrity_passed = false;
    expect(assess(data).status).not.toBe("qualified");
  });
  test.each([NaN, Infinity, -1])(
    "rejects malformed numeric evidence %s",
    (duration) => {
      const data = store();
      data.evaluations[1].trials[0].duration_ms = duration;
      expect(assess(data).status).not.toBe("qualified");
    },
  );
  test("duplicate trial identities cannot inflate repeatability", () => {
    const data = store();
    data.evaluations[1].trials[1].id = "trial-0";
    expect(assess(data).status).not.toBe("qualified");
  });
  test("all quota failures remain unverified, rather than capability failures", () => {
    const data = store();
    data.evaluations[1].trials = trials("candidate:free").map((t) => ({
      ...t,
      success: false,
      integrity_passed: false,
      observed_model: null,
      tool_calls: 0,
      failure_kind: "quota",
      failure_reason: "HTTP 429",
    }));
    const result = assess(data);
    expect(result.status).toBe("unverified");
    expect(result.metrics?.capability_trials).toBe(0);
    expect(result.metrics?.infrastructure_failures).toBe(3);
  });
  test("a quota interruption is recorded separately from measured task completion", () => {
    const data = store();
    data.evaluations[1].trials.push({
      ...trials("candidate:free", 1)[0],
      id: "quota",
      success: false,
      integrity_passed: false,
      observed_model: null,
      tool_calls: 0,
      failure_kind: "quota",
      failure_reason: "HTTP 429",
    });
    const result = assess(data);
    expect(result.metrics?.capability_trials).toBe(3);
    expect(result.metrics?.infrastructure_failures).toBe(1);
    expect(result.metrics?.completion_rate).toBe(1);
  });
  test("cannot cherry-pick a later all-success batch over an earlier capability failure", () => {
    const data = store();
    const failed = evaluation("candidate:free");
    failed.evaluated_at = "2026-10-22T12:00:00Z";
    failed.trials = [
      {
        ...trials("candidate:free", 1)[0],
        id: "failed",
        evaluated_at: failed.evaluated_at,
        success: false,
        failure_kind: "capability",
        failure_reason: "Task failed",
      },
    ];
    data.evaluations.push(failed);
    expect(assess(data).status).toBe("rejected");
    expect(assess(data).metrics?.completion_rate).toBe(0.75);
  });
  test("stale historical harness evidence cannot permanently block requalification", () => {
    const data = store();
    const archived = evaluation("candidate:free");
    archived.harness_version = "0.9.0";
    archived.evaluated_at = "2026-09-01T12:00:00Z";
    archived.trials = [
      {
        ...trials("candidate:free", 1)[0],
        id: "archived-failure",
        evaluated_at: archived.evaluated_at,
        success: false,
        failure_kind: "capability",
        failure_reason: "Old harness failed",
      },
    ];
    data.evaluations.push(archived);
    expect(assess(data).status).toBe("qualified");
    expect(assess(data).metrics?.capability_trials).toBe(3);
  });
  test.each(["evaluation_version", "fixture_digest", "harness_version"])(
    "archived %s failures do not taint the current evaluated artifact",
    (key) => {
      const data = store();
      for (const model of ["candidate:free", "baseline"]) {
        const archived = evaluation(model);
        (archived as unknown as Record<string, unknown>)[key] = "previous";
        archived.trials = [
          {
            ...trials(model, 1)[0],
            id: "archived-failure",
            success: false,
            failure_kind: "capability",
            failure_reason: "Previous artifact failed",
          },
        ];
        data.evaluations.push(archived);
      }
      expect(assess(data).status).toBe("qualified");
      expect(assess(data).metrics?.capability_trials).toBe(3);
    },
  );
  test("the caller cannot omit the current harness version and silently mix fresh harnesses", () => {
    const data = store();
    const other = evaluation("candidate:free");
    other.harness_version = "0.9.0";
    other.trials = trials(other.model_id).map((t) => ({
      ...t,
      id: `other-${t.id}`,
    }));
    data.evaluations.push(other);
    expect(
      assessQuality(data, "candidate:free", "pi", now, {
        fixtureDigest: policy.fixtureDigest,
      }).status,
    ).toBe("unverified");
  });
  test("baseline-equivalent completion still rejects unreliable tools", () => {
    const data = store();
    data.evaluations[1].trials.forEach((t) => {
      t.tool_failures = 1;
    });
    expect(assess(data).status).toBe("rejected");
  });
  test("public benchmark scores never compensate for failed actual tasks", () => {
    const data = store();
    data.evaluations[1].benchmarks.push({
      name: "Coding",
      version: "1",
      conditions: "public run",
      source_url: "https://example.org/benchmark",
      updated_at: recent,
      metric: "score",
      value: 999,
    });
    data.evaluations[1].trials[0].success = false;
    data.evaluations[1].trials[0].failure_kind = "capability";
    data.evaluations[1].trials[0].failure_reason = "Failed test";
    expect(assess(data).status).toBe("rejected");
  });
});

test("rank prioritizes completion over speed and excludes rejected candidates", () => {
  const data = store();
  const good = evaluation("slower:free");
  good.trials = trials(good.model_id, 8).map((t) => ({
    ...t,
    duration_ms: 5000,
  }));
  const fast = evaluation("fast:free");
  fast.trials.forEach((t) => {
    t.duration_ms = 1;
  });
  const poor = evaluation("poor:free");
  poor.trials[0].success = false;
  poor.trials[0].failure_kind = "capability";
  poor.trials[0].failure_reason = "Failed tests";
  data.evaluations.push(good, fast, poor);
  const ranked = rankQualified(
    [good, fast, poor].map((e) =>
      assessQuality(data, e.model_id, "pi", now, policy),
    ),
  );
  expect(ranked.map((r) => r.model_id)).toEqual(["slower:free", "fast:free"]);
});

test("loader refuses missing, corrupt and structurally invalid evidence", async () => {
  const directory = mkdtempSync(join(tmpdir(), "agent-quality-"));
  try {
    await expect(
      loadQualityStore(join(directory, "missing.json")),
    ).rejects.toThrow();
    const path = join(directory, "quality.json");
    for (const value of [
      "{",
      "null",
      "{}",
      JSON.stringify({ ...store(), schema_version: 2 }),
    ]) {
      writeFileSync(path, value);
      await expect(loadQualityStore(path)).rejects.toThrow();
    }
    writeFileSync(path, JSON.stringify(store()));
    expect((await loadQualityStore(path)).evaluations).toHaveLength(2);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("loader rejects nonexistent calendar dates instead of normalizing them", async () => {
  const directory = mkdtempSync(join(tmpdir(), "agent-quality-date-"));
  try {
    const data = store();
    data.evaluations[1].evaluated_at = "2026-02-30T12:00:00Z";
    const path = join(directory, "quality.json");
    writeFileSync(path, JSON.stringify(data));
    await expect(loadQualityStore(path)).rejects.toThrow();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
