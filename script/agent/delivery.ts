#!/usr/bin/env bun
/**
 * GitHub delivery / reconciliation for agent tasks (dotfiles#103, Epic#86 T017).
 *
 * Handles ticket PR creation, readiness evaluation, merge authorization,
 * and reconciliation of Issue/PR/branch state.
 */

import { ContractError, agentStateDir, isPlainObject } from "./contract.ts";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PRState = "draft" | "ready" | "merged" | "closed" | "blocked";

export interface TicketPR {
  number: number;
  issueNumber: number;
  headRef: string;           // ticket branch name (e.g., "123")
  baseRef: string;           // target release branch (e.g., "release-0-4-0")
  headSha: string;           // current head commit SHA
  baseSha: string;           // base branch SHA at PR creation
  state: PRState;
  isDraft: boolean;
  isStacked: boolean;
  predecessor?: number;      // predecessor PR number for stacked PRs
  mergeMethod?: "merge" | "squash" | "rebase";
  requiredChecks: string[];
  createdAt: string;
  updatedAt: string;
  mergedAt?: string;
  mergedBy?: string;
}

export interface DeliveryReconciliation {
  issueNumber: number;
  pr: TicketPR | null;
  branchExists: boolean;
  branchSha: string | null;
  remoteHeadSha: string | null;
  localHeadSha: string | null;
  isStale: boolean;
  blockers: string[];
  canLand: boolean;
  landingAuthority: "autonomous" | "requires-approval" | "blocked";
}

export interface ReconcileResult {
  issueNumber: number;
  action: "create-pr" | "update-pr" | "land" | "close-issue" | "cleanup-branch" | "blocked";
  prNumber?: number;
  reason: string;
  blockers: string[];
  evidence: {
    prState?: string;
    headSha?: string;
    baseSha?: string;
    checksGreen?: boolean;
    reviewApproved?: boolean;
    staleReadiness?: boolean;
    baseStaleness?: boolean;
    stackStaleness?: boolean;
  };
}

// ---------------------------------------------------------------------------
// GitHub CLI integration
// ---------------------------------------------------------------------------

const GH_CLI = "gh";

/** Raw stdout/stderr text of a successful child process. */
async function readProc(
  proc: Bun.Subprocess,
): Promise<{ stdout: string; stderr: string; code: number }> {
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout as ReadableStream).text(),
    new Response(proc.stderr as ReadableStream).text(),
    proc.exited,
  ]);
  return { stdout, stderr, code };
}

/**
 * Execute a gh CLI command. Commands that pass "--json <fields>" return the
 * parsed JSON value; all others return trimmed stdout text.
 */
async function ghCommand(args: string[], cwd?: string): Promise<unknown> {
  const proc = await Bun.spawn([GH_CLI, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    cwd,
  });
  const { stdout, stderr, code } = await readProc(proc);
  if (code !== 0) {
    throw new ContractError("state", `gh ${args.join(" ")} failed: ${stderr.trim()}`);
  }
  const trimmed = stdout.trim();
  if (args.includes("--json")) {
    try {
      return JSON.parse(trimmed);
    } catch {
      throw new ContractError("state", `gh ${args.join(" ")}: invalid JSON output`);
    }
  }
  return trimmed;
}

/** Subset of `gh pr view/list --json` fields consumed by this module. */
export interface GHPullRequest {
  number: number;
  headRefName: string;
  baseRefName: string;
  headRefOid: string;
  baseRefOid: string;
  state: string; // OPEN | CLOSED | MERGED
  isDraft: boolean;
  mergeable?: string;
  reviews?: { state?: string }[];
  statusCheckRollup?: { conclusion?: string | null; status?: string }[];
}

const GH_PR_FIELDS =
  "number,headRefName,baseRefName,headRefOid,baseRefOid,state,isDraft,mergeable,reviews,statusCheckRollup";

/** Validate one `gh` PR JSON object; unknown shape is a contract violation. */
export function parseGHPullRequest(raw: unknown, where: string): GHPullRequest {
  if (!isPlainObject(raw)) throw new ContractError("state", `${where}: PR JSON must be an object`);
  const reqStr = (key: string): string => {
    const value = raw[key];
    if (typeof value !== "string") {
      throw new ContractError("state", `${where}.${key}: must be a string`);
    }
    return value;
  };
  const num = raw["number"];
  if (typeof num !== "number" || !Number.isInteger(num)) {
    throw new ContractError("state", `${where}.number: must be an integer`);
  }
  const isDraft = raw["isDraft"];
  if (typeof isDraft !== "boolean") {
    throw new ContractError("state", `${where}.isDraft: must be a boolean`);
  }
  const pr: GHPullRequest = {
    number: num,
    headRefName: reqStr("headRefName"),
    baseRefName: reqStr("baseRefName"),
    headRefOid: reqStr("headRefOid"),
    baseRefOid: reqStr("baseRefOid"),
    state: reqStr("state"),
    isDraft,
  };
  const mergeable = raw["mergeable"];
  if (mergeable !== undefined) {
    if (typeof mergeable !== "string") {
      throw new ContractError("state", `${where}.mergeable: must be a string`);
    }
    pr.mergeable = mergeable;
  }
  const reviews = raw["reviews"];
  if (reviews !== undefined) {
    if (!Array.isArray(reviews)) {
      throw new ContractError("state", `${where}.reviews: must be an array`);
    }
    pr.reviews = reviews.map((entry, i) => {
      if (!isPlainObject(entry)) {
        throw new ContractError("state", `${where}.reviews[${i}]: must be an object`);
      }
      const state = entry["state"];
      if (state !== undefined && typeof state !== "string") {
        throw new ContractError("state", `${where}.reviews[${i}].state: must be a string`);
      }
      return state === undefined ? {} : { state };
    });
  }
  const rollup = raw["statusCheckRollup"];
  if (rollup !== undefined) {
    if (!Array.isArray(rollup)) {
      throw new ContractError("state", `${where}.statusCheckRollup: must be an array`);
    }
    pr.statusCheckRollup = rollup.map((entry, i) => {
      if (!isPlainObject(entry)) {
        throw new ContractError("state", `${where}.statusCheckRollup[${i}]: must be an object`);
      }
      const conclusion = entry["conclusion"];
      if (conclusion !== undefined && conclusion !== null && typeof conclusion !== "string") {
        throw new ContractError(
          "state",
          `${where}.statusCheckRollup[${i}].conclusion: must be a string or null`,
        );
      }
      const status = entry["status"];
      if (status !== undefined && typeof status !== "string") {
        throw new ContractError("state", `${where}.statusCheckRollup[${i}].status: must be a string`);
      }
      const check: { conclusion?: string | null; status?: string } = {};
      if (conclusion !== undefined) check.conclusion = conclusion;
      if (status !== undefined) check.status = status;
      return check;
    });
  }
  return pr;
}

function parseGHPullRequestList(raw: unknown, where: string): GHPullRequest[] {
  if (!Array.isArray(raw)) throw new ContractError("state", `${where}: expected a JSON array`);
  return raw.map((entry, i) => parseGHPullRequest(entry, `${where}[${i}]`));
}

/**
 * Get PR by number.
 */
export async function getPR(number: number, repo?: string): Promise<GHPullRequest> {
  const args = ["pr", "view", String(number), "--json", GH_PR_FIELDS];
  if (repo) args.push("--repo", repo);
  return parseGHPullRequest(await ghCommand(args), `pr view ${number}`);
}

/**
 * List PRs for an issue.
 */
export async function listPRsForIssue(issueNumber: number, repo?: string): Promise<GHPullRequest[]> {
  const args = ["pr", "list", "--search", `issue:${issueNumber}`, "--state", "all", "--json", GH_PR_FIELDS];
  if (repo) args.push("--repo", repo);
  return parseGHPullRequestList(await ghCommand(args), `pr list issue:${issueNumber}`);
}

/**
 * Create a Draft PR for a ticket.
 */
export async function createTicketPR(
  issueNumber: number,
  baseBranch: string,
  title: string,
  body: string,
  repo?: string
): Promise<{ number: number; url: string }> {
  const args = [
    "pr", "create",
    "--title", title,
    "--body", body,
    "--base", baseBranch,
    "--draft",
    "--head", String(issueNumber),  // ticket branch name
  ];
  if (repo) args.push("--repo", repo);

  const url = await ghCommand(args);
  if (typeof url !== "string") {
    throw new ContractError("state", "gh pr create: expected a URL on stdout");
  }
  const match = /\/pull\/(\d+)/.exec(url);
  if (!match) {
    throw new ContractError("state", `gh pr create: cannot parse PR number from '${url}'`);
  }
  return { number: Number(match[1]), url };
}

/**
 * Update PR metadata (ready for review, labels, etc.).
 */
export async function updatePR(
  number: number,
  updates: { readyForReview?: boolean; body?: string; labels?: string[] },
  repo?: string
): Promise<void> {
  const args = ["pr", "edit", String(number)];
  if (updates.readyForReview) args.push("--ready-for-review");
  if (updates.body) args.push("--body", updates.body);
  if (updates.labels) {
    for (const label of updates.labels) {
      args.push("--add-label", label);
    }
  }
  if (repo) args.push("--repo", repo);
  
  await ghCommand(args);
}

/**
 * Merge a PR with specified method.
 */
export async function mergePR(
  number: number,
  method: "merge" | "squash" | "rebase",
  repo?: string
): Promise<void> {
  const args = ["pr", "merge", String(number), `--${method}`];
  if (repo) args.push("--repo", repo);
  await ghCommand(args);
}

/**
 * Get current branch SHA.
 */
export async function getCurrentBranchSha(cwd?: string): Promise<string> {
  const proc = await Bun.spawn(["git", "rev-parse", "HEAD"], {
    stdout: "pipe",
    stderr: "pipe",
    cwd,
  });
  const stdout = await new TextDecoder().decode(await new Response(proc.stdout).arrayBuffer());
  const code = await proc.exited;
  if (code !== 0) throw new ContractError("state", "Failed to get current branch SHA");
  return stdout.trim();
}

/**
 * Get remote branch SHA.
 */
export async function getRemoteBranchSha(branch: string, remote: string = "origin"): Promise<string | null> {
  const proc = await Bun.spawn(["git", "ls-remote", remote, branch], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new TextDecoder().decode(await new Response(proc.stdout).arrayBuffer());
  if (!stdout.trim()) return null;
  return stdout.split("\t")[0];
}

/**
 * Check if branch exists locally.
 */
export async function branchExistsLocally(branch: string): Promise<boolean> {
  const proc = await Bun.spawn(["git", "show-ref", "--verify", `refs/heads/${branch}`], {
    stdout: "pipe",
    stderr: "pipe",
  });
  return (await proc.exited) === 0;
}

/**
 * Get merge base of two branches.
 */
export async function getMergeBase(branch1: string, branch2: string): Promise<string | null> {
  const proc = await Bun.spawn(["git", "merge-base", branch1, branch2], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, code] = await Promise.all([
    new Response(proc.stdout).text(),
    proc.exited,
  ]);
  if (code !== 0 || !stdout.trim()) return null;
  return stdout.trim();
}

// ---------------------------------------------------------------------------
// Delivery reconciliation
// ---------------------------------------------------------------------------

/**
 * Reconcile a ticket's Issue/PR/branch state.
 */
export async function reconcileTicket(
  issueNumber: number,
  options: { baseBranch?: string; repo?: string } = {}
): Promise<ReconcileResult> {
  const baseBranch = options.baseBranch || "release-0-4-0";
  const repo = options.repo;
  const ticketBranch = String(issueNumber);

  // Get PR for this issue
  const prs = await listPRsForIssue(issueNumber, options.repo);
  const pr = prs.find(p => p.headRefName === ticketBranch && p.baseRefName === baseBranch) || null;

  // Check branch existence and SHAs
  const branchExists = await branchExistsLocally(ticketBranch);
  const localHeadSha = branchExists ? await getCurrentBranchSha() : null;
  const remoteHeadSha = await getRemoteBranchSha(ticketBranch);
  const baseSha = await getRemoteBranchSha(baseBranch);

  // Determine staleness
  const isStale = !!(remoteHeadSha && localHeadSha && remoteHeadSha !== localHeadSha);
  const baseStaleness = !!(remoteHeadSha && baseSha && remoteHeadSha === baseSha);

  // Get PR details if exists
  let prDetails: GHPullRequest | null = null;
  if (pr) {
    prDetails = await getPR(pr.number, options.repo);
  }

  // Determine checks status: every reported check must be concluded SUCCESS.
  const checksGreen =
    (prDetails?.statusCheckRollup?.length ?? 0) > 0 &&
    prDetails!.statusCheckRollup!.every((c) => c.conclusion === "SUCCESS");

  // Check review status
  const reviewApproved =
    prDetails?.reviews?.some((r) => r.state === "APPROVED") ?? false;

  // Check for stale readiness (green checks but stale SHA)
  const staleReadiness = checksGreen && isStale;

  // Check stack staleness (if stacked PR): the base branch must not have moved
  // past the SHA the PR was created against.
  let stackStaleness = false;
  if (prDetails && prDetails.baseRefName !== baseBranch) {
    const predRemoteSha = await getRemoteBranchSha(prDetails.baseRefName);
    stackStaleness = predRemoteSha !== null && predRemoteSha !== prDetails.baseRefOid;
  }

  // Determine blockers
  const blockers: string[] = [];
  if (!branchExists) blockers.push("ticket branch does not exist locally");
  if (!remoteHeadSha) blockers.push("ticket branch not pushed to remote");
  if (isStale) blockers.push("local branch diverges from remote");
  if (baseStaleness) blockers.push("ticket branch is at base (no commits)");
  if (staleReadiness) blockers.push("checks green but SHA stale - requires rebase/revalidation");
  if (stackStaleness) blockers.push("stacked PR predecessor has moved - requires rebase");
  if (prDetails?.isDraft) blockers.push("PR is still draft");
  if (prDetails && prDetails.mergeable !== "MERGEABLE") blockers.push("PR has merge conflicts");
  if (!checksGreen) blockers.push("required checks not green");
  if (!reviewApproved && !prDetails?.isDraft) blockers.push("no approving review");

  // Determine if can land autonomously
  const landingAuthority = blockers.length === 0 ? "autonomous" :
                          blockers.some(b => b.includes("approval") || b.includes("release")) ? "requires-approval" : "blocked";

  const canLand = landingAuthority === "autonomous";

  // Determine action
  let action: "create-pr" | "update-pr" | "land" | "close-issue" | "cleanup-branch" | "blocked" = "blocked";
  let reason = blockers.join("; ");

  if (!pr && branchExists && remoteHeadSha) {
    action = "create-pr";
    reason = "Ticket branch exists but no PR created";
  } else if (pr && prDetails && prDetails.isDraft && canLand) {
    action = "update-pr";
    reason = "PR ready for review";
  } else if (pr && prDetails && !prDetails.isDraft && canLand) {
    action = "land";
    reason = "All gates green, authorized for landing";
  } else if (pr && prDetails && prDetails.state === "CLOSED") {
    action = "cleanup-branch";
    reason = "PR closed without merge";
  } else if (pr && prDetails && prDetails.state === "MERGED") {
    action = "close-issue";
    reason = "PR merged, issue ready to close";
  }

  return {
    issueNumber,
    action,
    prNumber: pr?.number,
    reason,
    blockers,
    evidence: {
      prState: prDetails?.state ?? undefined,
      headSha: remoteHeadSha ?? undefined,
      baseSha: baseSha ?? undefined,
      checksGreen,
      reviewApproved,
      staleReadiness,
      baseStaleness,
      stackStaleness,
    },
  };
}

/**
 * Create or update PR for a ticket based on current state.
 */
export async function ensureTicketPR(
  issueNumber: number,
  options: { baseBranch?: string; repo?: string; title?: string; body?: string } = {}
): Promise<{ prNumber: number; created: boolean }> {
  const baseBranch = options.baseBranch || "release-0-4-0";
  const repo = options.repo;
  const ticketBranch = String(issueNumber);

  // Check if PR already exists
  const prs = await listPRsForIssue(issueNumber, repo);
  const existingPr = prs.find(p => p.headRefName === ticketBranch && p.baseRefName === baseBranch);

  if (existingPr) {
    return { prNumber: existingPr.number, created: false };
  }

  // Ensure ticket branch exists and has commits
  const branchExists = await branchExistsLocally(ticketBranch);
  if (!branchExists) {
    throw new ContractError("state", `Ticket branch ${ticketBranch} does not exist`);
  }

  const remoteHeadSha = await getRemoteBranchSha(ticketBranch);
  if (!remoteHeadSha) {
    throw new ContractError("state", `Ticket branch ${ticketBranch} not pushed to remote`);
  }

  // Create PR
  const title = options.title || `Issue #${issueNumber}`;
  const body = options.body || `Implements issue #${issueNumber}`;
  
  const pr = await createTicketPR(issueNumber, baseBranch, title, body, repo);
  return { prNumber: pr.number, created: true };
}

/**
 * Land a ticket PR if authorized.
 */
export async function landTicketPR(
  prNumber: number,
  options: { method?: "merge" | "squash" | "rebase"; repo?: string; requireApproval?: boolean } = {}
): Promise<void> {
  const pr = await getPR(prNumber, options.repo);

  if (pr.state !== "OPEN") {
    throw new ContractError("state", `PR #${prNumber} is not open`);
  }

  if (pr.isDraft) {
    throw new ContractError("state", `PR #${prNumber} is still draft`);
  }

  // Check required checks
  const checksGreen =
    (pr.statusCheckRollup?.length ?? 0) > 0 &&
    pr.statusCheckRollup!.every((c) => c.conclusion === "SUCCESS");
  if (!checksGreen) {
    throw new ContractError("state", "Required checks not green");
  }

  // Check review approval
  const reviewApproved = pr.reviews?.some((r) => r.state === "APPROVED") ?? false;
  if (options.requireApproval && !reviewApproved) {
    throw new ContractError("state", "No approving review");
  }

  // Check for staleness
  const remoteHeadSha = await getRemoteBranchSha(pr.headRefName);
  if (remoteHeadSha && pr.headRefOid !== remoteHeadSha) {
    throw new ContractError("state", "PR head SHA diverged from remote - rebase required");
  }

  // Merge
  const method = options.method || "squash";
  await mergePR(prNumber, method, options.repo);
}

/**
 * Close issue after successful merge.
 */
export async function closeIssueAfterMerge(
  issueNumber: number,
  options: { repo?: string; comment?: string } = {}
): Promise<void> {
  const args = ["issue", "close", String(issueNumber)];
  if (options.comment) args.push("--comment", options.comment);
  if (options.repo) args.push("--repo", options.repo);
  await ghCommand(args);
}

/**
 * Clean up stale ticket branches.
 */
export async function cleanupStaleBranches(
  baseBranch: string = "release-0-4-0",
  options: { dryRun?: boolean } = {}
): Promise<string[]> {
  const proc = await Bun.spawn(["git", "branch", "--list"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new TextDecoder().decode(await new Response(proc.stdout).arrayBuffer());
  const branches = stdout.trim().split("\n").map(b => b.trim().replace(/^\*\s*/, ""));
  
  const staleBranches: string[] = [];
  
  for (const branch of branches) {
    // Skip main branches
    if (branch === "main" || branch.startsWith("release-")) continue;
    
    // Check if branch is a ticket branch (numeric name)
    if (!/^\d+$/.test(branch)) continue;
    
    // Check if merged
    const merged = await isBranchMerged(branch, baseBranch);
    if (merged) {
      if (!options.dryRun) {
        await Bun.spawn(["git", "branch", "-d", branch], { stdout: "pipe", stderr: "pipe" });
        await Bun.spawn(["git", "push", "origin", "--delete", branch], { stdout: "pipe", stderr: "pipe" });
      }
      staleBranches.push(branch);
    }
  }
  
  return staleBranches;
}

async function isBranchMerged(branch: string, baseBranch: string): Promise<boolean> {
  const proc = await Bun.spawn(["git", "merge-base", "--is-ancestor", branch, baseBranch], {
    stdout: "pipe",
    stderr: "pipe",
  });
  return (await proc.exited) === 0;
}

// ---------------------------------------------------------------------------
// Local state for delivery tracking
// ---------------------------------------------------------------------------

const DELIVERY_STATE_DIR = join(agentStateDir(), "delivery");

function ensureDeliveryStateDir(): void {
  if (!existsSync(DELIVERY_STATE_DIR)) {
    mkdirSync(DELIVERY_STATE_DIR, { recursive: true });
  }
}

function deliveryStatePath(issueNumber: number): string {
  return join(DELIVERY_STATE_DIR, `${issueNumber}.json`);
}

export function saveDeliveryState(issueNumber: number, state: unknown): void {
  ensureDeliveryStateDir();
  writeFileSync(deliveryStatePath(issueNumber), JSON.stringify(state, null, 2));
}

export function loadDeliveryState(issueNumber: number): Record<string, unknown> | null {
  const path = deliveryStatePath(issueNumber);
  if (!existsSync(path)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
    return isPlainObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

