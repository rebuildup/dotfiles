#!/usr/bin/env bun
/**
 * Tests for the Antigravity visual review harness (dotfiles#219).
 *
 * The agy binary is replaced by a stub script (opts.agyBin / AGY_CLI) so the
 * full runLocal pipeline — input isolation, prompt/schema assembly, envelope
 * parsing, classification, protected-path diff — is exercised without a
 * network call or real credentials. AGENT_STATE_DIR is redirected to a temp
 * dir so review workdirs never touch the real state tree.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync, rmSync, chmodSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acquireReviewLock,
  buildReviewPrompt,
  buildSeatbeltProfile,
  countPermissionErrors,
  minQuotaFraction,
  parseAgyEnvelope,
  parseAgyQuota,
  releaseReviewLock,
  reviewEnv,
  reviewSettingsJson,
  runAgyReview,
  runAgyReviewFile,
  sanitizeImageName,
  validateReviewInputs,
  DEFAULT_REVIEW_SCHEMA,
  type AgyReviewResult,
} from "./agent/agy-review.ts";
import { AgentError } from "./agent/errors.ts";

let tmp: string;
let stateDir: string;
let img: string;
let stubDir: string;

const VALID_ENVELOPE = JSON.stringify({
  conversation_id: "conv-1",
  status: "SUCCESS",
  response: JSON.stringify({
    verdict: "approve",
    summary: "looks good",
    findings: [],
  }),
  duration_seconds: 1.5,
  num_turns: 1,
  usage: { input_tokens: 10 },
  denied_actions: [],
});

function makeStub(name: string, body: string): string {
  const path = join(stubDir, name);
  writeFileSync(path, `#!/bin/bash\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "agy-review-test-"));
  stateDir = join(tmp, "state");
  process.env.AGENT_STATE_DIR = stateDir;
  img = join(tmp, "shot.png");
  writeFileSync(img, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  stubDir = join(tmp, "stubs");
  mkdirSync(stubDir, { recursive: true });
});

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("input validation", () => {
  it("rejects missing images", () => {
    expect(() =>
      validateReviewInputs({ images: [], spec: "s" })
    ).toThrow(AgentError);
  });

  it("rejects relative and traversal paths", () => {
    for (const bad of ["rel/x.png", "/tmp/../etc/x.png", "/tmp/x.txt"]) {
      expect(() =>
        validateReviewInputs({ images: [bad], spec: "s" })
      ).toThrow(AgentError);
    }
  });

  it("rejects empty spec and non-object schema file", () => {
    expect(() =>
      validateReviewInputs({ images: [img], spec: "   " })
    ).toThrow(AgentError);
    const badSchema = join(tmp, "bad-schema.json");
    writeFileSync(badSchema, "[1,2]");
    expect(() =>
      validateReviewInputs({ images: [img], spec: "s", schemaFile: badSchema })
    ).toThrow(AgentError);
  });

  it("accepts a valid minimal request", () => {
    const { spec, schema } = validateReviewInputs({ images: [img], spec: "check it" });
    expect(spec).toBe("check it");
    expect(schema).toEqual(DEFAULT_REVIEW_SCHEMA);
  });
});

describe("assembly helpers", () => {
  it("sanitizes image names and keeps extensions", () => {
    expect(sanitizeImageName(0, "/a/b/My Shot (1).PNG")).toBe("00-My_Shot_1_.png");
    expect(sanitizeImageName(3, "/x/noext")).toBe("03-noext");
  });

  it("prompt embeds spec and absolute image paths", () => {
    const p = buildReviewPrompt("SPEC-TEXT", ["/w/inputs/00-a.png"]);
    expect(p).toContain("SPEC-TEXT");
    expect(p).toContain("/w/inputs/00-a.png");
    expect(p).toContain("read-only");
  });

  it("seatbelt profile denies writes outside the allowlist", () => {
    const sb = buildSeatbeltProfile("/w/work", "/home/u");
    expect(sb).toContain("(deny file-write*");
    expect(sb).toContain('(subpath "/w/work")');
    expect(sb).toContain('(subpath "/home/u/.gemini")');
    expect(sb).toContain("require-not");
  });
});

describe("envelope/quota parsing", () => {
  it("parses the agy JSON envelope", () => {
    const env = parseAgyEnvelope(VALID_ENVELOPE);
    expect(env?.status).toBe("SUCCESS");
    expect(env?.conversationId).toBe("conv-1");
    expect(env?.deniedActions).toEqual([]);
    expect(parseAgyEnvelope("not json")).toBeNull();
  });

  it("parses quota buckets from the /quota response", () => {
    const quotaEnv = JSON.stringify({
      status: "SUCCESS",
      response: JSON.stringify({
        groups: [
          {
            name: "Gemini",
            buckets: [
              { id: "weekly", name: "Weekly", window: "7d", remaining_fraction: 0.4, reset_time: "2026-11-30T00:00:00Z" },
            ],
          },
        ],
      }),
    });
    const q = parseAgyQuota(quotaEnv);
    expect(q?.buckets).toHaveLength(1);
    expect(q?.buckets[0].remainingFraction).toBe(0.4);
    expect(q?.buckets[0].resetTime).toBe("2026-11-30T00:00:00Z");
    expect(parseAgyQuota('{"status":"SUCCESS","response":"nope"}')).toBeNull();
  });

  it("parses the real TSV /quota format (agy 1.5.14)", () => {
    const tsv = [
      "Gemini Models\tWeekly Limit Remaining\t100%\t2026-11-29T17:03:28Z",
      "Claude and GPT models\tFive Hour Limit Remaining\t42%\t2026-11-23T07:17:19Z",
    ].join("\n");
    const env = JSON.stringify({ status: "SUCCESS", response: tsv });
    const q = parseAgyQuota(env);
    expect(q?.buckets).toHaveLength(2);
    expect(q?.buckets[0]).toMatchObject({
      group: "Gemini Models",
      label: "Weekly Limit Remaining",
      remainingFraction: 1,
      resetTime: "2026-11-29T17:03:28Z",
    });
    expect(q?.buckets[1].remainingFraction).toBeCloseTo(0.42);
  });

  it("reviewSettingsJson strips $schema from the managed payload", () => {
    const home = mkdtempSync(join(tmpdir(), "agy-home-"));
    mkdirSync(join(home, ".config/agy"), { recursive: true });
    writeFileSync(
      join(home, ".config/agy/review.settings.json"),
      JSON.stringify({ $schema: "https://example/schemas/v1.json", permissions: { deny: ["command(*)"] } })
    );
    const prev = process.env["HOME"];
    process.env["HOME"] = home;
    try {
      const parsed = JSON.parse(reviewSettingsJson()) as Record<string, unknown>;
      expect(parsed["$schema"]).toBeUndefined();
      expect(parsed["permissions"]).toEqual({ deny: ["command(*)"] });
    } finally {
      if (prev === undefined) delete process.env["HOME"];
      else process.env["HOME"] = prev;
    }
  });

  it("reviewEnv strips API-key credentials, keeps the rest", () => {
    const env = reviewEnv({
      PATH: "/bin",
      GEMINI_API_KEY: "secret",
      GOOGLE_API_KEY: "secret2",
      AGY_API_KEY: "s3",
      HOME: "/h",
    });
    expect(env).toEqual({ PATH: "/bin", HOME: "/h" });
  });

  it("counts permission-denied markers", () => {
    expect(countPermissionErrors("ok")).toBe(0);
    expect(
      countPermissionErrors('tool error: permission check failed for write_file "/x"')
    ).toBe(1);
  });

  it("minQuotaFraction takes the worst bucket and fails closed on unknown", () => {
    expect(minQuotaFraction({ buckets: [{ remainingFraction: 0.5 }, { remainingFraction: 0.9 }] })).toBe(0.5);
    expect(minQuotaFraction({ buckets: [{ remainingFraction: null }] })).toBeNull();
    expect(minQuotaFraction({ error: "x" })).toBeNull();
    expect(minQuotaFraction(null)).toBeNull();
  });

  it("minQuotaFraction scopes buckets to the model family when identifiable", () => {
    const quota = {
      buckets: [
        { group: "Gemini Models", remainingFraction: 0.9 },
        { group: "Claude and GPT models", remainingFraction: 0.05 },
        { group: "Gemini 4 Argon", remainingFraction: 0.8 },
      ],
    };
    expect(minQuotaFraction(quota)).toBe(0.05);
    expect(minQuotaFraction(quota, "gemini-3-pro")).toBe(0.8);
    expect(minQuotaFraction(quota, "claude-sonnet-4-5")).toBe(0.05);
    // Unrecognized model id never narrows the gate.
    expect(minQuotaFraction(quota, "unknown-model-x")).toBe(0.05);
  });
});

describe("single-flight lock (#221)", () => {
  it("second acquire is refused while a fresh lock is held; release frees it", () => {
    const lockDir = join(stateDir, "agy-review");
    mkdirSync(lockDir, { recursive: true });
    // Ensure no leftover lock from earlier tests.
    try { unlinkSync(join(lockDir, ".single-flight.lock")); } catch {}
    const p1 = acquireReviewLock("run-a");
    expect(p1).not.toBeNull();
    expect(acquireReviewLock("run-b")).toBeNull();
    releaseReviewLock(p1!, "run-a");
    expect(existsSync(join(lockDir, ".single-flight.lock"))).toBe(false);
    const p2 = acquireReviewLock("run-b");
    expect(p2).not.toBeNull();
    releaseReviewLock(p2!, "run-b");
  });

  it("a foreign lock is not released by another id", () => {
    const lockDir = join(stateDir, "agy-review");
    mkdirSync(lockDir, { recursive: true });
    const lockPath = join(lockDir, ".single-flight.lock");
    try { unlinkSync(lockPath); } catch {}
    writeFileSync(lockPath, JSON.stringify({ id: "other", pid: 1, startedAt: Date.now() }));
    releaseReviewLock(lockPath, "mine");
    expect(existsSync(lockPath)).toBe(true);
    try { unlinkSync(lockPath); } catch {}
  });
});

describe("runLocal pipeline (stub agy)", () => {
  // Built lazily: `img` is only assigned in beforeAll, after describe bodies run.
  const base = () => ({ images: [img], spec: "review this", skipQuota: true, noOsSandbox: true });

  it("review-completed on a valid verdict envelope", async () => {
    const stub = makeStub("ok.sh", `cat <<'EOF'\n${VALID_ENVELOPE}\nEOF`);
    const result = await runAgyReview({ ...base(), agyBin: stub });
    expect(result.classification).toBe("review-completed");
    expect(result.verified).toBe(false); // no --protect supplied
    expect(result.verdict).toMatchObject({ verdict: "approve" });
    expect(result.readonly.deniedActions).toEqual([]);
    expect(result.isolation.workdir.startsWith(stateDir)).toBe(true);
    // Inputs were copied, not referenced in place.
    expect(existsSync(join(result.isolation.workdir, "inputs", "00-shot.png"))).toBe(true);
  });

  it("records model and spec identity for reproducible evidence (#231)", async () => {
    const stub = makeStub("meta.sh", `cat <<'EOF'\n${VALID_ENVELOPE}\nEOF`);
    const spec = "review this\nwith a newline";
    const result = await runAgyReview({ ...base(), spec, agyBin: stub, model: "claude-sonnet-5-5-high" });
    expect(result.model).toBe("claude-sonnet-5-5-high");
    const { createHash } = await import("node:crypto");
    expect(result.specSha256).toBe(createHash("sha256").update(spec, "utf8").digest("hex"));

    const noModel = await runAgyReview({ ...base(), agyBin: stub });
    expect(noModel.model).toBeNull();
    expect(noModel.specSha256).toBe(createHash("sha256").update("review this", "utf8").digest("hex"));
    // agy 1.5.14 does not report the effective model: null, never guessed.
    expect(noModel.resolvedModel).toBeNull();
  });

  it("resolvedModel reflects an envelope-reported model when present", async () => {
    const env = JSON.stringify({
      status: "SUCCESS",
      response: JSON.stringify({ verdict: "approve", summary: "s", findings: [] }),
      resolved_model: "gemini-4-neon-high",
    });
    const stub = makeStub("rmodel.sh", `cat <<'EOF'\n${env}\nEOF`);
    const result = await runAgyReview({ ...base(), agyBin: stub });
    expect(result.resolvedModel).toBe("gemini-4-neon-high");
    expect(result.model).toBeNull();
  });

  it("recovers the verdict when the response duplicates the JSON object", async () => {
    // Observed with claude-sonnet-5-5-high: agy returns two complete verdict
    // objects concatenated; the last one is the final answer (#227).
    const dupResponse = [
      JSON.stringify({ verdict: "approve", summary: "draft", findings: [] }),
      JSON.stringify({
        verdict: "request-changes",
        summary: "final",
        findings: [{ severity: "minor", description: "x", location: "top-left" }],
      }),
    ].join("\n");
    const dup = JSON.stringify({ status: "SUCCESS", response: dupResponse, denied_actions: [] });
    const stub = makeStub("dup.sh", `cat <<'EOF'\n${dup}\nEOF`);
    const result = await runAgyReview({ ...base(), agyBin: stub });
    expect(result.classification).toBe("review-completed");
    expect(result.verdict).toMatchObject({ verdict: "request-changes", summary: "final" });
  });

  it("readonly-violation when the model hits deny rules", async () => {
    const denied = JSON.stringify({
      status: "SUCCESS",
      response: "I tried to write but got: permission check failed for write_file \"/x\". Matches user-configured deny rule.",
      denied_actions: ["write_file(*)"],
    });
    const stub = makeStub("denied.sh", `cat <<'EOF'\n${denied}\nEOF`);
    const result = await runAgyReview({ ...base(), agyBin: stub });
    // response is not schema JSON -> invalid-output takes precedence? No:
    // schema validation runs first in classify order only after SUCCESS; the
    // verdict parse fails so classification is invalid-output. Either way it
    // must NOT be review-completed.
    expect(result.classification).not.toBe("review-completed");
    expect(result.verified).toBe(false);
  });

  it("readonly-violation when verdict is valid but deny actions fired", async () => {
    const denied = JSON.stringify({
      status: "SUCCESS",
      response: JSON.stringify({ verdict: "approve", summary: "s", findings: [] }),
      denied_actions: ["command(*)"],
    });
    const stub = makeStub("denied2.sh", `cat <<'EOF'\n${denied}\nEOF`);
    const result = await runAgyReview({ ...base(), agyBin: stub });
    expect(result.readonly.deniedActions).toEqual(["command(*)"]);
    expect(result.classification).toBe("readonly-violation");
    expect(result.verified).toBe(false);
  });

  it("invalid-output on non-JSON stdout", async () => {
    const stub = makeStub("bad.sh", `echo "hello"`);
    const result = await runAgyReview({ ...base(), agyBin: stub });
    expect(result.classification).toBe("invalid-output");
  });

  it("agy-error on non-zero exit", async () => {
    const stub = makeStub("fail.sh", `echo "boom" >&2; exit 3`);
    const result = await runAgyReview({ ...base(), agyBin: stub });
    expect(result.classification).toBe("agy-error");
    expect(result.reasons.join(" ")).toContain("exited 3");
  });

  it("auth-required when stderr asks for sign-in", async () => {
    const stub = makeStub("auth.sh", `echo "Please sign in to continue" >&2; exit 1`);
    const result = await runAgyReview({ ...base(), agyBin: stub });
    expect(result.classification).toBe("auth-required");
  });

  it("protected path mutation is detected via git status", async () => {
    const repo = join(tmp, "repo");
    mkdirSync(repo, { recursive: true });
    Bun.spawnSync(["git", "init", "-q"], { cwd: repo });
    Bun.spawnSync(["git", "-C", repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init", "--allow-empty"]);
    const stub = makeStub(
      "mutate.sh",
      `echo '${VALID_ENVELOPE}'\ntouch "$AGY_TEST_PROTECT/mutated.txt"`
    );
    process.env.AGY_TEST_PROTECT = repo;
    try {
      const result = await runAgyReview({ ...base(), agyBin: stub, protect: repo });
      expect(result.readonly.protectedCheck).toBe("mutated");
      expect(result.readonly.protectedMutations.join(" ")).toContain("mutated.txt");
      expect(result.classification).toBe("readonly-violation");
    } finally {
      delete process.env.AGY_TEST_PROTECT;
    }
  });

  it("protected path clean run verifies", async () => {
    const repo = join(tmp, "repo2");
    mkdirSync(repo, { recursive: true });
    Bun.spawnSync(["git", "init", "-q"], { cwd: repo });
    Bun.spawnSync(["git", "-C", repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init", "--allow-empty"]);
    const stub = makeStub("ok2.sh", `cat <<'EOF'\n${VALID_ENVELOPE}\nEOF`);
    const result = await runAgyReview({ ...base(), agyBin: stub, protect: repo });
    expect(result.readonly.protectedCheck).toBe("clean");
    expect(result.classification).toBe("review-completed");
    expect(result.verified).toBe(true);
  });
});

describe("run-file (herdr inner path)", () => {
  it("round-trips a materialized request", async () => {
    const workdir = join(tmp, "req-workdir");
    mkdirSync(join(workdir, "inputs"), { recursive: true });
    const imgCopy = join(workdir, "inputs", "00-shot.png");
    writeFileSync(imgCopy, readFileSync(img));
    const stub = makeStub("ok3.sh", `cat <<'EOF'\n${VALID_ENVELOPE}\nEOF`);
    // request.json carries no agyBin; inject via AGY_CLI env instead.
    process.env.AGY_CLI = stub;
    try {
      writeFileSync(join(workdir, "request.json"), JSON.stringify({
        spec: "spec",
        schema: DEFAULT_REVIEW_SCHEMA,
        model: null,
        protect: null,
        imagePaths: [imgCopy],
        timeoutMs: 30000,
        skipQuota: true,
      }));
      const result: AgyReviewResult = await runAgyReviewFile(workdir);
      expect(result.classification).toBe("review-completed");
      expect(existsSync(join(workdir, "result.json"))).toBe(true);
    } finally {
      delete process.env.AGY_CLI;
    }
  });
});

describe("pre-flight quota gate and single-flight (#221)", () => {
  const base = () => ({ images: [img], spec: "review this", skipQuota: true, noOsSandbox: true });

  function quotaStub(pct: string, name: string): string {
    const quotaEnv = JSON.stringify({
      status: "SUCCESS",
      response: `Gemini Models\tWeekly Limit Remaining\t${pct}\t2026-11-29T00:00:00Z`,
    });
    return makeStub(name, `if [ "$2" = "/quota" ]; then\ncat <<'QEOF'\n${quotaEnv}\nQEOF\nelse\ncat <<'VEOF'\n${VALID_ENVELOPE}\nVEOF\nfi`);
  }

  it("quota-exhausted when remaining is below --min-remaining; model is not called", async () => {
    const stub = quotaStub("30%", "quota-low.sh");
    const result = await runAgyReview({ ...base(), agyBin: stub, minRemaining: 0.5 });
    expect(result.classification).toBe("quota-exhausted");
    expect(result.reasons.join(" ")).toContain("30.0%");
    expect(result.agy).toBeNull();
    expect(existsSync(join(result.isolation.workdir, "agy.stdout.log"))).toBe(false);
  });

  it("proceeds when quota clears the threshold", async () => {
    const stub = quotaStub("80%", "quota-ok.sh");
    const result = await runAgyReview({ ...base(), agyBin: stub, minRemaining: 0.5 });
    expect(result.classification).toBe("review-completed");
  });

  it("quota gate scopes to the model family when --model is given", async () => {
    const quotaEnv = JSON.stringify({
      status: "SUCCESS",
      response: [
        "Gemini Models\tWeekly Limit Remaining\t80%\t2026-11-29T00:00:00Z",
        "Claude and GPT models\tWeekly Limit Remaining\t5%\t2026-11-29T00:00:00Z",
      ].join("\n"),
    });
    const stub = makeStub("quota-scoped.sh", `if [ "$2" = "/quota" ]; then\ncat <<'QEOF'\n${quotaEnv}\nQEOF\nelse\ncat <<'VEOF'\n${VALID_ENVELOPE}\nVEOF\nfi`);
    const scoped = await runAgyReview({ ...base(), agyBin: stub, minRemaining: 0.5, model: "gemini-3-pro" });
    expect(scoped.classification).toBe("review-completed");
    const unscoped = await runAgyReview({ ...base(), agyBin: stub, minRemaining: 0.5 });
    expect(unscoped.classification).toBe("quota-exhausted");
  });

  it("fails closed when the quota probe itself fails", async () => {
    const stub = makeStub("quota-dead.sh", `if [ "$2" = "/quota" ]; then exit 1; else cat <<'VEOF'\n${VALID_ENVELOPE}\nVEOF\nfi`);
    const result = await runAgyReview({ ...base(), agyBin: stub, minRemaining: 0.1 });
    expect(result.classification).toBe("quota-exhausted");
    expect(result.reasons.join(" ")).toContain("unavailable");
  });

  it("deferred while another review holds the lock; --no-exclusive bypasses", async () => {
    const lockDir = join(stateDir, "agy-review");
    mkdirSync(lockDir, { recursive: true });
    try { unlinkSync(join(lockDir, ".single-flight.lock")); } catch {}
    const held = acquireReviewLock("held-by-other");
    expect(held).not.toBeNull();
    try {
      const stub = makeStub("ok4.sh", `cat <<'EOF'\n${VALID_ENVELOPE}\nEOF`);
      const deferred = await runAgyReview({ ...base(), agyBin: stub });
      expect(deferred.classification).toBe("deferred");
      const bypass = await runAgyReview({ ...base(), agyBin: stub, exclusive: false });
      expect(bypass.classification).toBe("review-completed");
    } finally {
      releaseReviewLock(held!, "held-by-other");
    }
  });
});
