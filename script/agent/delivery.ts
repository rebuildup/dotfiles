#!/usr/bin/env bun
/**
 * GitHub delivery / reconciliation for agent tasks (dotfiles#103, Epic#86 T017).
 *
 * Handles ticket PR creation, readiness evaluation, merge authorization,
 * and reconciliation of Issue/PR/branch state.
 */

import { ContractError } from "./contract.ts";
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

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

/**
 * Execute a gh CLI command and return parsed JSON.
 */
async function ghCommand(args: string[], cwd?: string): Promise<any> {
  const hasJson = args.length > 0 && args[args.length - 1] === "--json";
  const args_ = hasJson ? [GH_CLI, ...args] : [GH_CLI, ...args, "--json"];
  const proc = await Bun.spawn(["gh", ...args_], {
    stdout: "pipe",
    stderr: "pipe",
    cwd,
  });
  
  const stdout = await new TextDecoder().decode(await new Response(proc.stdout).arrayBuffer());
  const stderr = await new TextDecoder().decode(await proc.stderr.arrayBuffer());
  const code = await proc.exited;
  
  if (code !== 0) {
    throw new ContractError("state", `gh ${args.join(" ")} failed: ${stderr}`);
  }
  
  try {
    return JSON.parse(stdout.trim());
  } catch {
    return stdout.trim();
  }
}

/**
 * Get PR by number.
 */
export async function getPR(number: number, repo?: string): Promise<any> {
  const args = ["pr", "view", String(number)];
  if (repo) args.push("--repo", repo);
  return ghCommand(args);
}

/**
 * List PRs for an issue.
 */
export async function listPRsForIssue(issueNumber: number, repo?: string): Promise<any[]> {
  const args = ["pr", "list", "--search", `issue:${issueNumber}`, "--state", "all"];
  if (repo) args.push("--repo", repo);
  return ghCommand([...args, "--json", "number,headRefOid,baseRefOid,headRefName,baseRefName,state,isDraft,mergeable,reviews,statusCheckRollup,title,author,createdAt,updatedAt"]);
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
  
  const result = await ghCommand(args);
  return { number: result.number, url: result.url };
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
): Promise<{ sha: string }> {
  const args = ["pr", "merge", String(number), `--${method}`];
  if (repo) args.push("--repo", repo);
  return ghCommand(args);
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
  return proc.exited === 0;
}

/**
 * Get merge base of two branches.
 */
export async function getMergeBase(branch1: string, branch2: string): Promise<string | null> {
  const proc = await Bun.spawn(["git", "merge-base", branch1, branch2], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new TextDecoder().decode(await new Response(proc.stdout).arrayBuffer());
  if (proc.exited !== 0 || !stdout.trim()) return null;
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
): Promise<any> {
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
  const isStale = remoteHeadSha && localHeadSha && remoteHeadSha !== localHeadSha;
  const baseStaleness = remoteHeadSha && baseSha && remoteHeadSha === baseSha;

  // Get PR details if exists
  let prDetails: any = null;
  if (pr) {
    prDetails = await getPR(pr.number, options.repo);
  }

  // Determine checks status
  const checksGreen = prDetails?.statusCheckRollup?.every((c: any) => c.conclusion === "SUCCESS") ?? false;
  
  // Check review status
  const reviewApproved = prDetails?.reviews?.some((r: any) => r.state === "APPROVED") ?? false;
  
  // Check for stale readiness (green checks but stale SHA)
  const staleReadiness = checksGreen && isStale;

  // Check stack staleness (if stacked PR)
  let stackStaleness = false;
  if (prDetails?.headRefName && prDetails?.baseRefName !== baseBranch) {
    // Stacked PR - check predecessor
    const baseSha_ = await getRemoteBranchSha(prDetails.baseRefName);
    const predRemoteSha = await getRemoteBranchSha(prDetails.baseRefName);
    stackStaleness = predRemoteSha && baseSha_ && predRemoteSha !== baseSha_;
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
  if (!prDetails?.mergeable) blockers.push("PR has merge conflicts");
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
  } else if (pr && prDetails.isDraft && canLand) {
    action = "update-pr";
    reason = "PR ready for review";
  } else if (pr && !prDetails.isDraft && canLand) {
    action = "land";
    reason = "All gates green, authorized for landing";
  } else if (pr && prDetails.state === "CLOSED" && !prDetails.merged) {
    action = "cleanup-branch";
    reason = "PR closed without merge";
  } else if (pr && prDetails.merged) {
    action = "close-issue";
    reason = "PR merged, issue ready to close";
  }

  return {
    issueNumber,
    action,
    prNumber: pr?.number,
    reason,
    evidence: {
      prState: prDetails?.state,
      headSha: remoteHeadSha,
      baseSha: baseSha,
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
): Promise<{ sha: string }> {
  const pr = await getPR(prNumber, options.repo);
  
  if (pr.state !== "OPEN") {
    throw new ContractError("state", `PR #${prNumber} is not open`);
  }
  
  if (pr.isDraft) {
    throw new ContractError("state", `PR #${prNumber} is still draft`);
  }
  
  // Check required checks
  const checksGreen = pr.statusCheckRollup?.every((c: any) => c.conclusion === "SUCCESS") ?? false;
  if (!checksGreen) {
    throw new ContractError("state", "Required checks not green");
  }
  
  // Check review approval
  const reviewApproved = pr.reviews?.some((r: any) => r.state === "APPROVED") ?? false;
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
  return mergePR(prNumber, method, options.repo);
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
  return proc.exited === 0;
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

export function saveDeliveryState(issueNumber: number, state: any): void {
  ensureDeliveryStateDir();
  writeFileSync(deliveryStatePath(issueNumber), JSON.stringify(state, null, 2));
}

export function loadDeliveryState(issueNumber: number): any | null {
  const path = deliveryStatePath(issueNumber);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
}

// Re-export needed functions
import { agentStateDir } from "./contract.ts";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
