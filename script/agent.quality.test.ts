/**
 * Tests for the SHA-pinned quality gate and independent review (Epic #86,
 * T016 / issue #102).
 *
 * These are REAL tests of the decision logic; every record/attestation used
 * is synthetic MOCK EVIDENCE (no CI run, no harness, no network is involved
 * or claimed). The only real validation of this change is running `bun test`
 * itself — reported as such in the PR.
 *
 * Negative acceptance tests (issue #102):
 *   - old-SHA green, skipped CI, WSL-Linux-misreported-as-Windows-native,
 *     reviewer=self, failing gates all FAIL CLOSED;
 *   - only required gates are demanded (no over-verification of low-risk work);
 *   - hostile inputs (NaN, Infinity, negative, epoch-vs-ISO, huge values,
 *     secret-shaped ids, path traversal, empty strings) throw, never decide.
 */

import { describe, expect, test } from "bun:test";
import {
  evaluateQualityGate,
  parseEnvironment,
  parseGateRule,
  parseValidationRecord,
  resolveRequiredGates,
  type GateRule,
  type QualityGateInput,
  type ValidationRecord,
} from "./agent/quality.ts";
import {
  buildReviewInput,
  evaluateReview,
  parseReviewRecord,
  type ReviewRecord,
} from "./agent/review.ts";
import { ContractError } from "./agent/contract.ts";
import type { MachineOS } from "./agent/machines.ts";
import type { RequiredGate } from "./agent/quality.ts";
import type { TaskClass } from "./agent/preflight.ts";

const NOW = Date.parse("2026-11-06T00:00:00Z");
const FRESH_AT = "2026-11-05T23:00:00Z";
const OLD_AT = "2026-10-01T00:00:00Z";
const SHA = "a".repeat(40);
const OLD_SHA = "b".repeat(40);

/** The evaluating host: a WSL Linux machine (this repo's workstation). */
const WSL_LINUX = { os: "linux" as const, wsl: true };
const WINDOWS_NATIVE = { os: "windows" as const, wsl: false };

/** Mock gate matrix mirroring this repo's CI steps (data, not policy). */
const RULES: GateRule[] = [
  { kind: "unit", name: "bun-test-agent-router", os: null, native: false, triggers: null },
  {
    kind: "smoke",
    name: "agent-launcher-check",
    os: null,
    native: false,
    triggers: ["script/agent", "config/agents.toml"],
  },
  { kind: "integration", name: "script-test", os: null, native: false, triggers: ["script/", "home/"] },
  {
    kind: "native",
    name: "windows-agent-tests",
    os: "windows",
    native: true,
    triggers: ["script/agent.windows", "script/agent.entrypoint.windows"],
  },
];

const PATHS = ["script/agent/quality.ts", "script/agent/review.ts", "script/agent.quality.test.ts"];

/** Mock validation record (synthetic evidence, clearly labelled). */
function record(overrides: Partial<ValidationRecord> = {}): ValidationRecord {
  return {
    name: "bun-test-agent-router",
    sha: SHA,
    status: "pass",
    source: "ci",
    environment: { os: "linux", wsl: false },
    at: FRESH_AT,
    note: null,
    ...overrides,
  };
}

/** Wrap a record in the contract envelope, as persisted state looks. */
function envelope(rec: unknown): Record<string, unknown> {
  return { contract_version: "1.0.0", ...(rec as object) };
}

function gate(overrides: Partial<QualityGateInput> = {}): QualityGateInput {
  return {
    currentSha: SHA,
    now: NOW,
    localEnvironment: WSL_LINUX,
    sourceMutated: false,
    required: [{ kind: "unit", name: "bun-test-agent-router", os: null, native: false }],
    records: [envelope(record())],
    ...overrides,
  };
}

// -- resolveRequiredGates ----------------------------------------------------

describe("resolveRequiredGates", () => {
  test("mechanical work is never over-verified: unit gates only", () => {
    const required = resolveRequiredGates(RULES, PATHS, "mechanical");
    expect(required.map((g) => g.name)).toEqual(["bun-test-agent-router"]);
  });

  test("localized work adds smoke but not integration/native", () => {
    const required = resolveRequiredGates(RULES, PATHS, "localized");
    expect(required.map((g) => g.name)).toEqual(["bun-test-agent-router", "agent-launcher-check"]);
  });

  test("cross-boundary work resolves the full triggered matrix", () => {
    const required = resolveRequiredGates(RULES, PATHS, "cross-boundary");
    expect(required.map((g) => g.name)).toEqual([
      "bun-test-agent-router",
      "agent-launcher-check",
      "script-test",
    ]);
  });

  test("windows-native gate is required only when a windows surface changed", () => {
    const required = resolveRequiredGates(
      RULES,
      ["script/agent.windows.test.ts"],
      "cross-boundary",
    );
    expect(required.map((g) => g.name)).toContain("windows-agent-tests");
    expect(required.find((g) => g.name === "windows-agent-tests")?.native).toBe(true);
  });

  test("always-on gates survive an unrelated change surface", () => {
    const required = resolveRequiredGates(RULES, ["docs/adr/new.md"], "localized");
    expect(required.map((g) => g.name)).toEqual(["bun-test-agent-router"]);
  });

  test("empty change surface fails closed", () => {
    expect(() => resolveRequiredGates(RULES, [], "cross-boundary")).toThrow(ContractError);
  });

  test("unknown taskClass throws ContractError, never a raw TypeError", () => {
    expect(() => resolveRequiredGates(RULES, PATHS, "vibes" as TaskClass)).toThrow(ContractError);
  });

  test("duplicate gate names are ambiguous and throw", () => {
    const dupe = [...RULES, { ...RULES[0] }];
    expect(() => resolveRequiredGates(dupe, PATHS, "cross-boundary")).toThrow(ContractError);
  });

  test("malformed rules throw: unknown kind, bad name, traversal trigger", () => {
    expect(() => parseGateRule({ ...RULES[0], kind: "vibes" }, "r")).toThrow(ContractError);
    expect(() => parseGateRule({ ...RULES[0], name: "../evil" }, "r")).toThrow(ContractError);
    expect(() => parseGateRule({ ...RULES[0], name: "OK" }, "r")).toThrow(ContractError);
    expect(() =>
      parseGateRule({ ...RULES[0], triggers: ["/etc"] }, "r"),
    ).toThrow(ContractError);
    expect(() => parseGateRule({ ...RULES[0], triggers: ["../../etc"] }, "r")).toThrow(ContractError);
    // Secret-shaped gate names are refused, never stored.
    expect(() => parseGateRule({ ...RULES[0], name: "sk-ant-api-key" }, "r")).toThrow(ContractError);
  });
});

// -- parseValidationRecord ---------------------------------------------------

describe("parseValidationRecord", () => {
  test("accepts a well-formed record", () => {
    const parsed = parseValidationRecord(envelope(record()), "t");
    expect(parsed.status).toBe("pass");
    expect(parsed.environment).toEqual({ os: "linux", wsl: false });
  });

  test("rejects unknown and missing fields", () => {
    expect(() => parseValidationRecord({ ...envelope(record()), extra: 1 }, "t")).toThrow(
      ContractError,
    );
    const missing = envelope(record());
    delete missing["status"];
    expect(() => parseValidationRecord(missing, "t")).toThrow(ContractError);
  });

  test("rejects hostile SHAs: branch names, uppercase, wrong length", () => {
    for (const sha of ["main", SHA.toUpperCase(), "a".repeat(41), "", "a".repeat(40) + "\n"]) {
      expect(() => parseValidationRecord(envelope(record({ sha })), "t")).toThrow(ContractError);
    }
  });

  test("rejects epoch numbers where an ISO time is required, and bad times", () => {
    expect(() => parseValidationRecord(envelope(record({ at: NOW })), "t")).toThrow(ContractError);
    expect(() => parseValidationRecord(envelope(record({ at: "2026-11-05" })), "t")).toThrow(
      ContractError,
    );
    expect(() => parseValidationRecord(envelope(record({ at: "not-a-time" })), "t")).toThrow(
      ContractError,
    );
  });

  test("rejects the WSL-as-Windows misreport at parse time", () => {
    expect(() =>
      parseValidationRecord(envelope(record({ environment: { os: "windows", wsl: true } })), "t"),
    ).toThrow(ContractError);
    expect(() => parseEnvironment({ os: "windows", wsl: true }, "t")).toThrow(ContractError);
  });

  test("skipped/neutral/fail are parsed as what they are, never as success aliases", () => {
    for (const status of ["pass", "fail", "skipped", "neutral"] as const) {
      expect(parseValidationRecord(envelope(record({ status })), "t").status).toBe(status);
    }
    for (const impostor of ["green", "success", "done", "PASS", ""]) {
      expect(() => parseValidationRecord(envelope(record({ status: impostor })), "t")).toThrow(
        ContractError,
      );
    }
  });

  test("worker self-reports and herdr markers are never validation sources", () => {
    for (const source of ["worker-report", "herdr-done", "self", "claim", ""]) {
      expect(() => parseValidationRecord(envelope(record({ source })), "t")).toThrow(ContractError);
    }
  });

  test("rejects secret-shaped notes", () => {
    expect(() =>
      parseValidationRecord(envelope(record({ note: "Bearer abc.def.ghi" })), "t"),
    ).toThrow(ContractError);
  });
});

// -- evaluateQualityGate (negative acceptance tests) --------------------------

describe("evaluateQualityGate", () => {
  test("passes when every required gate has a fresh passing current-SHA record", () => {
    const d = evaluateQualityGate(gate());
    expect(d.passed).toBe(true);
    expect(d.satisfied).toEqual(["bun-test-agent-router"]);
    expect(d.failures).toEqual([]);
  });

  test("old-SHA green is NOT current-SHA green", () => {
    const d = evaluateQualityGate(gate({ records: [envelope(record({ sha: OLD_SHA }))] }));
    expect(d.passed).toBe(false);
    expect(d.failures[0]?.reason).toContain("pinned to the current SHA");
  });

  test("skipped CI never passes the gate", () => {
    const d = evaluateQualityGate(
      gate({ records: [envelope(record({ status: "skipped", source: "ci" }))] }),
    );
    expect(d.passed).toBe(false);
    expect(d.failures[0]?.reason).toContain("skipped");
  });

  test("neutral results never pass the gate", () => {
    const d = evaluateQualityGate(gate({ records: [envelope(record({ status: "neutral" }))] }));
    expect(d.passed).toBe(false);
  });

  test("a failing gate fails the decision", () => {
    const d = evaluateQualityGate(gate({ records: [envelope(record({ status: "fail" }))] }));
    expect(d.passed).toBe(false);
    expect(d.failures[0]?.reason).toBe("gate failed on the current SHA");
  });

  test("a failing run cannot be cherry-picked around by a later pass", () => {
    const d = evaluateQualityGate(
      gate({
        records: [envelope(record({ status: "fail" })), envelope(record({ at: FRESH_AT }))],
      }),
    );
    expect(d.passed).toBe(false);
  });

  test("missing evidence fails closed", () => {
    const d = evaluateQualityGate(gate({ records: [] }));
    expect(d.passed).toBe(false);
    expect(d.failures[0]?.reason).toContain("missing");
  });

  test("stale evidence fails closed; future-dated evidence is invalid, never fresh", () => {
    const stale = evaluateQualityGate(gate({ records: [envelope(record({ at: OLD_AT }))] }));
    expect(stale.passed).toBe(false);
    const future = evaluateQualityGate(
      gate({ records: [envelope(record({ at: "2027-01-01T00:00:00Z" }))] }),
    );
    expect(future.passed).toBe(false);
  });

  test("WSL Linux misreported as Windows native fails closed", () => {
    // Honest WSL record can never satisfy a windows-native gate...
    const honest = evaluateQualityGate(
      gate({
        required: [{ kind: "native", name: "windows-agent-tests", os: "windows", native: true }],
        records: [envelope(record({ name: "windows-agent-tests", environment: WSL_LINUX }))],
      }),
    );
    expect(honest.passed).toBe(false);
    // ...and a local-run record claiming windows on a WSL host is a detected
    // misreport (claimed environment != attested local environment).
    const misreported = evaluateQualityGate(
      gate({
        required: [{ kind: "native", name: "windows-agent-tests", os: "windows", native: true }],
        records: [
          envelope(record({ name: "windows-agent-tests", source: "local-run", environment: WINDOWS_NATIVE })),
        ],
      }),
    );
    expect(misreported.passed).toBe(false);
  });

  test("a self-reported or herdr-reported success never validates anything", () => {
    for (const source of ["worker-report", "herdr-done"]) {
      expect(() =>
        evaluateQualityGate(gate({ records: [envelope(record({ source }))] })),
      ).toThrow(ContractError);
    }
  });

  test("source mutation voids ALL validation, whatever the records say", () => {
    const d = evaluateQualityGate(gate({ sourceMutated: true }));
    expect(d.passed).toBe(false);
    expect(d.failures).toHaveLength(1);
    expect(d.failures[0]?.reason).toContain("source mutated");
  });

  test("non-required gates are not demanded (no over-verification)", () => {
    const d = evaluateQualityGate(
      gate({
        records: [
          envelope(record()), // record for the required gate
          envelope(record({ name: "script-test" })), // record for an UNrequired gate: ignored, not demanded
        ],
      }),
    );
    expect(d.passed).toBe(true);
    expect(d.satisfied).toEqual(["bun-test-agent-router"]);
  });

  test("CI evidence may come from a different host than the evaluator; local-run may not", () => {
    // CI ran on a GitHub linux runner (wsl=false) while we evaluate on WSL:
    // fine for an OS-agnostic gate.
    expect(evaluateQualityGate(gate()).passed).toBe(true);
    // A claimed LOCAL run must have run on THIS host.
    const d = evaluateQualityGate(
      gate({ records: [envelope(record({ source: "local-run", environment: { os: "linux", wsl: false } }))] }),
    );
    expect(d.passed).toBe(false);
  });

  test("hostile gate input throws instead of deciding", () => {
    expect(() => evaluateQualityGate(gate({ currentSha: "main" }))).toThrow(ContractError);
    expect(() => evaluateQualityGate(gate({ currentSha: SHA.toUpperCase() }))).toThrow(ContractError);
    expect(() => evaluateQualityGate(gate({ now: Number.NaN }))).toThrow(ContractError);
    expect(() => evaluateQualityGate(gate({ now: Number.POSITIVE_INFINITY }))).toThrow(ContractError);
    expect(() => evaluateQualityGate(gate({ now: -1 }))).toThrow(ContractError);
    expect(() => evaluateQualityGate(gate({ maxEvidenceAgeMs: 0 }))).toThrow(ContractError);
    expect(() => evaluateQualityGate(gate({ maxEvidenceAgeMs: -5 }))).toThrow(ContractError);
    expect(() =>
      evaluateQualityGate(
        gate({
          required: [
            { kind: "unit", name: "g", os: null, native: false },
            { kind: "unit", name: "g", os: null, native: false },
          ],
        }),
      ),
    ).toThrow(ContractError);
    expect(() => evaluateQualityGate(gate({ records: "all-pass-i-promise" }))).toThrow(ContractError);
    // An unknown os in a required gate is a schema violation, not a string.
    expect(() =>
      evaluateQualityGate({
        ...gate(),
        required: [
          { kind: "unit", name: "g", os: "android", native: false } as unknown as RequiredGate,
        ],
      }),
    ).toThrow(ContractError);
    // A malformed record never produces a decision (fail closed, not ignored).
    expect(() => evaluateQualityGate(gate({ records: [{ name: "junk" }] }))).toThrow(ContractError);
    expect(() => evaluateQualityGate(null)).toThrow(ContractError);
  });
});

// -- independent review --------------------------------------------------------

const DIFF_FP = "c".repeat(64);

/** Mock review record (synthetic evidence, clearly labelled). */
function review(overrides: Partial<ReviewRecord> = {}): ReviewRecord {
  return {
    reviewer: "cold-reviewer-1",
    sha: SHA,
    verdict: "approve",
    diffFingerprint: DIFF_FP,
    findings: [],
    snapshotClean: true,
    at: FRESH_AT,
    summary: "The diff matches the described change and introduces no new findings.",
    ...overrides,
  };
}

function reviewInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    taskClass: "cross-boundary",
    builder: "worker-1",
    candidateSha: SHA,
    diffFingerprint: DIFF_FP,
    now: NOW,
    record: envelope(review()),
    ...overrides,
  };
}

describe("buildReviewInput", () => {
  test("the reviewer channel carries ONLY the SHA, changed paths, and diff identity", () => {
    const input = buildReviewInput(SHA, PATHS, DIFF_FP);
    expect(Object.keys(input).sort()).toEqual(["diffFingerprint", "filesChanged", "sha"]);
    expect(input.sha).toBe(SHA);
    expect(input.diffFingerprint).toBe(DIFF_FP);
  });

  test("hostile change surfaces and diff identities fail closed", () => {
    expect(() => buildReviewInput(SHA, PATHS, "not-a-fingerprint")).toThrow(ContractError);
    expect(() => buildReviewInput(SHA, PATHS, "c".repeat(63))).toThrow(ContractError);
    expect(() => buildReviewInput(SHA, PATHS, "C".repeat(64))).toThrow(ContractError);
    expect(() => buildReviewInput(SHA, [], DIFF_FP)).toThrow(ContractError);
    expect(() => buildReviewInput(SHA, [""])).toThrow(ContractError);
    expect(() => buildReviewInput(SHA, ["../../etc/passwd"])).toThrow(ContractError);
    expect(() => buildReviewInput(SHA, ["/etc/passwd"])).toThrow(ContractError);
    expect(() => buildReviewInput(SHA, ["Bearer abc.def.ghi"])).toThrow(ContractError);
    expect(() => buildReviewInput("main", PATHS)).toThrow(ContractError);
  });
});

describe("parseReviewRecord", () => {
  test("accepts a well-formed record and rejects unknown fields", () => {
    expect(parseReviewRecord(envelope(review()), "t").verdict).toBe("approve");
    expect(() => parseReviewRecord({ ...envelope(review()), builderNote: "psst" }, "t")).toThrow(
      ContractError,
    );
  });

  test("unknown/missing verdicts fail closed", () => {
    for (const verdict of ["LGTM", "approved", "looks-good", ""]) {
      expect(() => parseReviewRecord(envelope(review({ verdict })), "t")).toThrow(ContractError);
    }
    const missing = envelope(review());
    delete missing["verdict"];
    expect(() => parseReviewRecord(missing, "t")).toThrow(ContractError);
  });

  test("malformed reviewer identities fail closed", () => {
    expect(() => parseReviewRecord(envelope(review({ reviewer: "" })), "t")).toThrow(ContractError);
    expect(() => parseReviewRecord(envelope(review({ reviewer: "sk-ant-api-key" })), "t")).toThrow(
      ContractError,
    );
    expect(() => parseReviewRecord(envelope(review({ at: OLD_AT.slice(0, 10) })), "t")).toThrow(
      ContractError,
    );
  });
});

describe("evaluateReview", () => {
  test("a BARE approve — no diff identity, no findings, no rationale — fails closed", () => {
    const bare = {
      contract_version: "1.0.0",
      reviewer: "cold-reviewer-1",
      sha: SHA,
      verdict: "approve",
      snapshotClean: true,
      at: FRESH_AT,
    };
    expect(() => parseReviewRecord(bare, "t")).toThrow(ContractError);
    expect(() => evaluateReview(reviewInput({ record: bare }))).toThrow(ContractError);
  });

  test("a review whose diff identity mismatches the candidate fails closed", () => {
    const d = evaluateReview(
      reviewInput({ record: envelope(review({ diffFingerprint: "d".repeat(64) })) }),
    );
    expect(d.passed).toBe(false);
    expect(d.reasons.join(" ")).toContain("diff identity");
  });

  test("a missing or malformed diff identity fails closed on both sides", () => {
    const noRecordFp = envelope(review());
    delete noRecordFp["diffFingerprint"];
    expect(() => parseReviewRecord(noRecordFp, "t")).toThrow(ContractError);
    expect(() => parseReviewRecord(envelope(review({ diffFingerprint: "deadbeef" })), "t")).toThrow(
      ContractError,
    );
    // The candidate's actual diff identity is a required gate input too.
    expect(() => evaluateReview(reviewInput({ diffFingerprint: undefined }))).toThrow(ContractError);
    expect(() => evaluateReview(reviewInput({ diffFingerprint: "main..HEAD" }))).toThrow(ContractError);
  });

  test("findings must be explicit: absent throws, explicit empty list is accepted", () => {
    const noFindings = envelope(review());
    delete noFindings["findings"];
    expect(() => parseReviewRecord(noFindings, "t")).toThrow(ContractError);
    expect(parseReviewRecord(envelope(review({ findings: [] })), "t").findings).toEqual([]);
    expect(parseReviewRecord(envelope(review({ findings: ["quality.ts leaks error text"] })), "t").findings).toEqual([
      "quality.ts leaks error text",
    ]);
    expect(() =>
      parseReviewRecord(envelope(review({ findings: [""] })), "t"),
    ).toThrow(ContractError);
  });

  test("an empty or missing rationale fails closed", () => {
    expect(() => parseReviewRecord(envelope(review({ summary: "" })), "t")).toThrow(ContractError);
    const noSummary = envelope(review());
    delete noSummary["summary"];
    expect(() => parseReviewRecord(noSummary, "t")).toThrow(ContractError);
    // A secret-shaped rationale is refused, not stored.
    expect(() =>
      parseReviewRecord(envelope(review({ summary: "key is sk-ant-api-key-123" })), "t"),
    ).toThrow(ContractError);
  });

  test("degenerate repetitive rationales fail closed (documented heuristic)", () => {
    // "APPROVED APPROVED ..." loop: 10 tokens, 1 distinct, 100% dominance.
    const loop = evaluateReview(
      reviewInput({ record: envelope(review({ summary: "APPROVED ".repeat(10) })) }),
    );
    expect(loop.passed).toBe(false);
    expect(loop.reasons.join(" ")).toContain("degenerate");
    // One-word sign-off: below the distinct-token floor.
    const terse = evaluateReview(
      reviewInput({ record: envelope(review({ summary: "Looks good." })) }),
    );
    expect(terse.passed).toBe(false);
    // An ordinary sentence passes the heuristic.
    const real = evaluateReview(reviewInput());
    expect(real.passed).toBe(true);
  });

  test("a valid independent approval passes a cross-boundary candidate", () => {
    const d = evaluateReview(reviewInput());
    expect(d.required).toBe(true);
    expect(d.passed).toBe(true);
    expect(d.reviewer).toBe("cold-reviewer-1");
  });

  test("reviewer=self is never independent", () => {
    const d = evaluateReview(reviewInput({ record: envelope(review({ reviewer: "worker-1" })) }));
    expect(d.passed).toBe(false);
    expect(d.reasons.join(" ")).toContain("self-review");
  });

  test("case variants of the builder are not distinct reviewers", () => {
    const d = evaluateReview(
      reviewInput({ builder: "Worker-1", record: envelope(review({ reviewer: "WORKER-1" })) }),
    );
    expect(d.passed).toBe(false);
  });

  test("ambiguous self-references fail closed even with a different builder", () => {
    for (const reviewer of ["self", "me", "same", "builder", "author", "Self"]) {
      const d = evaluateReview(
        reviewInput({ record: envelope(review({ reviewer })), builder: "worker-2" }),
      );
      expect(d.passed).toBe(false);
      expect(d.reasons.join(" ")).toContain("ambiguous self-reference");
    }
  });

  test("a review pinned to another SHA is never reused", () => {
    const d = evaluateReview(
      reviewInput({ record: envelope(review({ sha: OLD_SHA })), candidateSha: SHA }),
    );
    expect(d.passed).toBe(false);
    expect(d.reasons.join(" ")).toContain("never reused");
  });

  test("non-approve verdicts fail closed; unknown verdicts throw", () => {
    const changes = evaluateReview(
      reviewInput({ record: envelope(review({ verdict: "request-changes" })) }),
    );
    expect(changes.passed).toBe(false);
    const rejected = evaluateReview(
      reviewInput({ record: envelope(review({ verdict: "reject" })) }),
    );
    expect(rejected.passed).toBe(false);
    expect(() => evaluateReview(reviewInput({ record: envelope(review({ verdict: "LGTM" })) }))).toThrow(
      ContractError,
    );
  });

  test("a review of a mutated snapshot fails closed", () => {
    const d = evaluateReview(reviewInput({ record: envelope(review({ snapshotClean: false })) }));
    expect(d.passed).toBe(false);
    expect(d.reasons.join(" ")).toContain("clean candidate snapshot");
  });

  test("missing review fails closed", () => {
    const d = evaluateReview(reviewInput({ record: null }));
    expect(d.required).toBe(true);
    expect(d.passed).toBe(false);
    expect(d.reasons.join(" ")).toContain("missing");
  });

  test("stale review evidence fails closed", () => {
    const d = evaluateReview(reviewInput({ record: envelope(review({ at: OLD_AT })) }));
    expect(d.passed).toBe(false);
  });

  test("mechanical/localized work is not over-reviewed", () => {
    for (const taskClass of ["mechanical", "localized"] as const) {
      const d = evaluateReview(reviewInput({ taskClass, record: null }));
      expect(d.required).toBe(false);
      expect(d.passed).toBe(true);
    }
    // ...but judgment-heavy always requires the cold reviewer.
    const d = evaluateReview(reviewInput({ taskClass: "judgment-heavy", record: null }));
    expect(d.required).toBe(true);
    expect(d.passed).toBe(false);
  });

  test("hostile input throws instead of deciding", () => {
    expect(() => evaluateReview(reviewInput({ taskClass: "vibes" }))).toThrow(ContractError);
    expect(() => evaluateReview(reviewInput({ builder: "" }))).toThrow(ContractError);
    expect(() => evaluateReview(reviewInput({ builder: "worker-1\nroot" }))).toThrow(ContractError);
    expect(() => evaluateReview(reviewInput({ candidateSha: "release-0-4-0" }))).toThrow(ContractError);
    expect(() => evaluateReview(reviewInput({ now: Number.NaN }))).toThrow(ContractError);
    expect(() => evaluateReview(reviewInput({ now: Number.POSITIVE_INFINITY }))).toThrow(ContractError);
    expect(() => evaluateReview(reviewInput({ maxAgeMs: -1 }))).toThrow(ContractError);
    expect(() => evaluateReview(null)).toThrow(ContractError);
    expect(() => evaluateReview(reviewInput({ record: "reviewer-said-ok" }))).toThrow(ContractError);
  });
});
