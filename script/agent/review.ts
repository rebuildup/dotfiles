/**
 * Independent cold review gating for agent workers (Epic #86, T016 /
 * issue #102).
 *
 * Pure functions only: every input is injected, nothing here launches a
 * process, touches the network, or reads the filesystem.
 *
 * Design rule (same as `preflight.ts` / `quality.ts`): the ENTIRE input is
 * validated with a strict schema FIRST; any malformed field throws
 * `ContractError` and never produces a decision. Every produced decision
 * fails closed:
 *
 *   - a reviewer is independent only when it is a real owner identity
 *     DISTINCT from the builder — self-review, case variants, and ambiguous
 *     self-references ("self") never approve anything;
 *   - a review is pinned to the exact reviewed SHA and is never reused for
 *     another SHA;
 *   - a missing/unknown verdict, a review of a mutated (non-clean) snapshot,
 *     or stale evidence never approves;
 *   - the reviewer's input channel is `ReviewInput` (SHA + changed paths)
 *     ONLY — no field exists that could carry the builder's private
 *     reasoning;
 *   - task classes that do not require cold review (mechanical/localized,
 *     per `preflight.reviewRequirement`) are never over-reviewed.
 *
 * KNOWN LIMITATION: the review record's `reviewer` field is accepted on its
 * face. DISTINCTNESS from the builder is enforced here; the AUTHENTICITY of
 * the reviewer identity (that the record really was produced by that
 * reviewer, not forged by the builder) is NOT verified in this module and
 * MUST be established by the channel that delivers the record (e.g. a
 * signed/attributed review surface). Until such a channel exists, a forged
 * reviewer name defeats this gate.
 */

import {
  ContractError,
  DEFAULT_MAX_EVIDENCE_AGE_MS,
  isPlainObject,
  looksLikeSecretValue,
  parseEnvelope,
  requireBool,
  requireStr,
  stringList,
} from "./contract.ts";
import {
  requireEpochMs,
  requireImmutableRef,
  requireIsoTime,
  validateOwner,
} from "./attempts.ts";
import { TASK_CLASSES, reviewRequirement } from "./preflight.ts";
import type { TaskClass } from "./preflight.ts";
import { isRecordStale } from "./quality.ts";

// ---------------------------------------------------------------------------
// Reviewer input: the only channel to a cold reviewer
// ---------------------------------------------------------------------------

/**
 * Everything a cold reviewer receives: the immutable candidate SHA, the
 * changed repo-relative paths, and the candidate's diff identity (sha256 of
 * the diff base..candidate). Deliberately closed — there is no field a
 * builder's private reasoning could travel through.
 */
export interface ReviewInput {
  sha: string;
  filesChanged: string[];
  diffFingerprint: string;
}

/** Repo-relative path that can never escape the repo or smuggle secrets. */
function parseChangedPath(value: unknown, where: string): string {
  if (
    typeof value !== "string" ||
    value.trim() === "" ||
    value.startsWith("/") ||
    value.includes("..") ||
    value.includes("\\") ||
    looksLikeSecretValue(value)
  ) {
    throw new ContractError("schema", `${where}: must be a repo-relative changed path`);
  }
  return value;
}

/** Validate a diff fingerprint: 64 lowercase hex (sha256 of the diff). */
function parseDiffFingerprint(value: unknown, where: string): string {
  if (typeof value !== "string" || !DIFF_FINGERPRINT_RE.test(value)) {
    throw new ContractError(
      "schema",
      `${where}: must be a 64-hex sha256 of the diff base..candidate`,
    );
  }
  return value;
}

/**
 * Build the reviewer's input for a candidate. Throws on a malformed SHA,
 * diff identity, or change surface (empty list, empty/path-traversal/
 * secret-shaped entries).
 */
export function buildReviewInput(
  candidateSha: string,
  filesChanged: readonly string[],
  diffFingerprint: string,
): ReviewInput {
  const sha = requireImmutableRef(candidateSha, "buildReviewInput.candidateSha");
  if (!Array.isArray(filesChanged) || filesChanged.length === 0) {
    throw new ContractError(
      "schema",
      "buildReviewInput.filesChanged: must be a non-empty array (an unknown change surface fails closed)",
    );
  }
  for (const path of filesChanged) parseChangedPath(path, "buildReviewInput.filesChanged[]");
  return {
    sha,
    filesChanged: [...filesChanged],
    diffFingerprint: parseDiffFingerprint(diffFingerprint, "buildReviewInput.diffFingerprint"),
  };
}

// ---------------------------------------------------------------------------
// Review records
// ---------------------------------------------------------------------------

/** Verdict of one cold review. Anything else fails closed. */
export type ReviewVerdict = "approve" | "request-changes" | "reject";

const REVIEW_VERDICTS: readonly ReviewVerdict[] = ["approve", "request-changes", "reject"];

/**
 * A bare `approve` is never a passing review. The record must carry a diff
 * identity, an explicit findings list, and a substantive rationale.
 */
export const REVIEW_RECORD_FIELDS = [
  "reviewer",
  "sha",
  "verdict",
  "diffFingerprint",
  "findings",
  "snapshotClean",
  "at",
  "summary",
] as const;

/**
 * Identity of the reviewed diff: sha256 (64 lowercase hex) over the canonical
 * diff `base..candidate` (caller-defined canonicalization, e.g.
 * `git diff --binary base candidate | sha256sum`). The gate compares the
 * record's fingerprint against the candidate's ACTUAL diff identity supplied
 * by the caller; a mismatch or absence fails closed.
 */
const DIFF_FINGERPRINT_RE = /^[0-9a-f]{64}$/;

/** Rationale is bounded so a record cannot smuggle unbounded payloads. */
export const MAX_SUMMARY_CHARS = 2000;
/** Findings list bounds: explicit, but never unbounded. */
export const MAX_FINDINGS = 100;
export const MAX_FINDING_CHARS = 500;

/**
 * Rationale quality heuristic (documented, deliberately simple): the summary
 * is lowercased and tokenized on non-alphanumeric runs. It is DEGENERATE —
 * and the gate fails — when it has fewer than 8 tokens, fewer than 5
 * DISTINCT tokens, or a single token covers more than half of all tokens.
 * This rejects bare approvals, "APPROVED APPROVED …" loops, and one-word
 * sign-offs while accepting any ordinary sentence.
 */
const MIN_RATIONALE_TOKENS = 8;
const MIN_DISTINCT_TOKENS = 5;
const MAX_TOKEN_SHARE = 0.5;

export interface ReviewRecord {
  reviewer: string;
  /** Immutable SHA the review was performed against. */
  sha: string;
  verdict: ReviewVerdict;
  /** sha256 of the reviewed diff base..candidate; must match the candidate's actual diff. */
  diffFingerprint: string;
  /** Reviewer findings; empty only when EXPLICITLY empty (field required). */
  findings: string[];
  /** True only when the reviewer ran on a clean candidate snapshot. */
  snapshotClean: boolean;
  /** ISO 8601 UTC timestamp of the review. */
  at: string;
  /** Required substantive rationale; bounded and secret-redacted. */
  summary: string;
}

/** Classify a rationale as degenerate; returns the reason or null. */
function degenerateRationale(summary: string): string | null {
  const tokens = summary.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t !== "");
  if (tokens.length < MIN_RATIONALE_TOKENS) {
    return `only ${tokens.length} tokens, need at least ${MIN_RATIONALE_TOKENS}`;
  }
  const distinct = new Set(tokens);
  if (distinct.size < MIN_DISTINCT_TOKENS) {
    return `only ${distinct.size} distinct tokens, need at least ${MIN_DISTINCT_TOKENS}`;
  }
  const counts = new Map<string, number>();
  for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1);
  const [top, topCount] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  if (topCount / tokens.length > MAX_TOKEN_SHARE) {
    return `token '${top}' covers ${topCount}/${tokens.length} tokens (max share ${MAX_TOKEN_SHARE})`;
  }
  return null;
}

/** Parse a review record from untrusted data. Unknown/missing fields throw. */
export function parseReviewRecord(raw: unknown, where: string): ReviewRecord {
  const { payload } = parseEnvelope(raw, REVIEW_RECORD_FIELDS, where);
  for (const field of REVIEW_RECORD_FIELDS) {
    if (!(field in payload)) {
      throw new ContractError("schema", `${where}: missing field '${field}'`);
    }
  }
  const reviewer = validateOwner(payload["reviewer"], `${where}.reviewer`);
  const sha = requireImmutableRef(payload["sha"], `${where}.sha`);
  const verdict = payload["verdict"];
  if (!REVIEW_VERDICTS.includes(verdict as ReviewVerdict)) {
    throw new ContractError("schema", `${where}.verdict: unknown verdict '${verdict}'`);
  }
  const diffFingerprint = payload["diffFingerprint"];
  if (typeof diffFingerprint !== "string" || !DIFF_FINGERPRINT_RE.test(diffFingerprint)) {
    throw new ContractError(
      "schema",
      `${where}.diffFingerprint: must be a 64-hex sha256 of the reviewed diff base..candidate`,
    );
  }
  const findings = stringList(payload["findings"], where, "findings");
  if (findings.length > MAX_FINDINGS) {
    throw new ContractError("schema", `${where}.findings: at most ${MAX_FINDINGS} entries`);
  }
  for (const finding of findings) {
    if (finding.length > MAX_FINDING_CHARS || looksLikeSecretValue(finding)) {
      throw new ContractError("schema", `${where}.findings[]: bounded non-secret strings only`);
    }
  }
  const snapshotClean = requireBool(payload, "snapshotClean", where);
  const at = requireIsoTime(payload["at"], `${where}.at`);
  const summary = requireStr(payload, "summary", where);
  if (summary.length > MAX_SUMMARY_CHARS) {
    throw new ContractError("schema", `${where}.summary: at most ${MAX_SUMMARY_CHARS} chars`);
  }
  if (looksLikeSecretValue(summary)) {
    throw new ContractError("schema", `${where}.summary: secret-shaped values are refused`);
  }
  return {
    reviewer,
    sha,
    verdict: verdict as ReviewVerdict,
    diffFingerprint,
    findings,
    snapshotClean,
    at,
    summary,
  };
}

// ---------------------------------------------------------------------------
// Independence
// ---------------------------------------------------------------------------

/**
 * Identity strings that name no one: as a reviewer they are an ambiguous
 * self-reference and fail closed instead of being resolved against some
 * assumed builder.
 */
const AMBIGUOUS_REVIEWERS: readonly string[] = ["self", "me", "same", "builder", "author"];

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

export interface ReviewEvaluationInput {
  taskClass: TaskClass;
  /** Untrusted builder identity. */
  builder: unknown;
  /** The candidate SHA the result claims to be for. */
  candidateSha: unknown;
  /**
   * The candidate's ACTUAL diff identity (64-hex sha256 of the diff
   * base..candidate), computed by the caller. The review record must match
   * it exactly; absence or mismatch fails closed.
   */
  diffFingerprint: unknown;
  /** Reference time (ms epoch) for staleness checks. */
  now: number;
  /** Maximum evidence age; defaults to the contract default (7 days). */
  maxAgeMs?: number;
  /** Untrusted review record; null/absent means no review exists. */
  record: unknown;
}

export interface ReviewDecision {
  /** Whether cold review is required for this task class at all. */
  required: boolean;
  passed: boolean;
  reviewer: string | null;
  reasons: string[];
}

/**
 * Evaluate whether the candidate has the independent cold review its task
 * class requires. Throws `ContractError` on malformed input (malformed
 * identities, SHAs, diff identities, or records — hostile input never
 * produces a decision). Fail-closed: a required review passes ONLY with an
 * existing record whose reviewer is a real identity distinct from the
 * builder, whose verdict is `approve` WITH a diff identity matching the
 * candidate's actual diff, an explicit findings list, and a substantive
 * (non-degenerate) rationale, whose SHA equals the candidate SHA exactly,
 * whose snapshot was clean, and whose evidence is fresh. A bare approve —
 * no diff identity, no findings, no rationale — never passes. Mechanical/
 * localized classes need no review and pass without one (no
 * over-verification).
 */
export function evaluateReview(input: unknown): ReviewDecision {
  if (!isPlainObject(input)) {
    throw new ContractError("schema", "evaluateReview: input must be an object");
  }
  const taskClass = input["taskClass"];
  if (!TASK_CLASSES.includes(taskClass as TaskClass)) {
    throw new ContractError("schema", `evaluateReview: unknown taskClass '${taskClass}'`);
  }
  const builder = validateOwner(input["builder"], "evaluateReview.builder");
  const candidateSha = requireImmutableRef(input["candidateSha"], "evaluateReview.candidateSha");
  const diffFingerprint = parseDiffFingerprint(
    input["diffFingerprint"],
    "evaluateReview.diffFingerprint",
  );
  const now = requireEpochMs(input["now"], "evaluateReview.now");
  const maxAgeMs =
    input["maxAgeMs"] === undefined
      ? DEFAULT_MAX_EVIDENCE_AGE_MS
      : requireEpochMs(input["maxAgeMs"], "evaluateReview.maxAgeMs");
  if (maxAgeMs <= 0) {
    throw new ContractError("schema", "evaluateReview.maxAgeMs must be positive");
  }

  const required = reviewRequirement(taskClass as TaskClass).coldReview;
  if (!required) {
    return { required: false, passed: true, reviewer: null, reasons: [] };
  }

  const rawRecord = input["record"];
  if (rawRecord === null || rawRecord === undefined) {
    return {
      required: true,
      passed: false,
      reviewer: null,
      reasons: ["missing: no review record exists for this candidate"],
    };
  }
  const record = parseReviewRecord(rawRecord, "evaluateReview.record");

  const reasons: string[] = [];
  // Identity comparison is normalized (trimmed, case-folded) so a case
  // variant of the builder can never count as a distinct reviewer.
  const reviewerKey = record.reviewer.trim().toLowerCase();
  const builderKey = builder.trim().toLowerCase();
  if (AMBIGUOUS_REVIEWERS.includes(reviewerKey)) {
    reasons.push(`reviewer '${record.reviewer}' is an ambiguous self-reference, not an identity`);
  } else if (reviewerKey === builderKey) {
    reasons.push(`reviewer '${record.reviewer}' is the builder: self-review is never independent`);
  }
  if (record.sha !== candidateSha) {
    reasons.push(
      `review is pinned to SHA ${record.sha}, not the candidate ${candidateSha}; reviews are never reused across SHAs`,
    );
  }
  if (record.diffFingerprint !== diffFingerprint) {
    reasons.push(
      `review's diff identity ${record.diffFingerprint} does not match the candidate's actual diff identity ${diffFingerprint}`,
    );
  }
  if (record.verdict !== "approve") {
    reasons.push(`verdict is '${record.verdict}', not 'approve'`);
  }
  const degenerate = degenerateRationale(record.summary);
  if (degenerate !== null) {
    reasons.push(`rationale is degenerate (repetition heuristic): ${degenerate}`);
  }
  if (!record.snapshotClean) {
    reasons.push("review did not run on a clean candidate snapshot");
  }
  if (isRecordStale(record.at, now, maxAgeMs)) {
    reasons.push(`review evidence from ${record.at} is outside the freshness window`);
  }

  return {
    required: true,
    passed: reasons.length === 0,
    reviewer: record.reviewer,
    reasons,
  };
}
