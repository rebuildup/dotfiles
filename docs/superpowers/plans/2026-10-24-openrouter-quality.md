# OpenRouter quality gate implementation plan

> For agentic workers: use parallel independent tasks, then integrate and review.

**Goal:** Select only free model/harness pairs with current measured coding evidence.

**Architecture:** Retain the availability catalog and thin launcher. Add a small
quality evidence reader and an explicit, isolated evaluator with external grading.
Default evidence is empty until real baseline measurements support calibration.

**Tech Stack:** Bun + TypeScript, existing TOML, standard library only.

**Spec:** User request attached to this chat; durable scope is GitHub Issue #72
and ADR-0012.

## Global constraints

- Preserve Infisical endpoint/project/dev and process-scoped secret filtering.
- No paid fallback, new runtime dependencies, service or normal-launch proxy.
- Protect unrelated local files; update PR #73's existing remote branch.
- Never report an unrun harness/model pair or exhausted quota as a successful E2E.

## Review focus

- Fresh evidence for a different harness/version cannot qualify this run.
- Broken pricing/expiry/modalities/cache metadata cannot authorize execution.
- Hidden grading and forbidden-file checks cannot be satisfied by self-report.
- Actual request retries must consume the same finite evaluation budget.
- Unknown quota and upstream 429 must stop rather than trigger model hopping.

## Tasks

- [x] Inspect main, Issue #72, PR #73, related issues and baseline tests.
- [x] Quality worker: tests first for strict evidence, calibration and ranking;
  implement `agent-quality.ts`; version/provider/harness/freshness are checked.
- [x] Evaluator worker: tests first for fixture grading, transcript identity,
  quota and request budget; implement explicit sequential temporary-project E2E.
- [x] Parent: tests first for availability failures, opt-in and selection CLI;
  integrate configuration, quality ranking and lazy evaluation command.
- [x] Research worker: official catalog, quotas and attributed benchmark records.
- [x] Run required repository gates, real quota preflight and bounded E2E screening.
- [ ] Publish final changes to PR #73 and get final independent review.
- [ ] Demonstrate repeatable passing evidence for a baseline and evaluate
  Claude Code, Pi and OpenCode before qualifying or adopting any model.
- [ ] Merge only after all requested acceptance criteria are demonstrated.

## Current acceptance status

Implementation and local gates are complete. The recorded live screen covers
four requested models in Pi only, under one fixed condition profile; none
qualified. The installed-workstation `./script/check` reports existing links
to the primary checkout while this work runs in an isolated worktree, missing
machine-local targets, and the absent Claude settings submodule. No adoption,
calibration or merge is justified until the outstanding real-harness evidence
is collected.
