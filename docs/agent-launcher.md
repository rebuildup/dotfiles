# Agent Launcher

Unified launcher for AI coding harnesses (`agent` command).

## Overview

`script/agent.ts` reads `config/agents.toml` and starts exactly one harness
with exactly one provider. No implicit provider switching, no silent model
fallback, no quota failover.

```bash
agent <harness> <provider> [--model <id>] [-- <harness args>...]
agent <harness>                    # native mode (no injection)
<harness>-<provider>               # shortcut form
agent list | models <provider> | shortcuts [list|check|create|remove]
agent check | help | guide [topic] | routes [--json]
agent fallback <profile-id> [--json]
```

## Architecture

| Module | Purpose |
|---|---|
| `script/agent.ts` | CLI entry point, config loading, plan building, execution |
| `script/agent/contract.ts` | Shared types: routes, models, attestation, redaction |
| `script/agent/catalog.ts` | Capability/pricing/terms catalog (issue #89) |
| `script/agent/probe.ts` | Route readiness probes (issue #90) |
| `script/agent/quota.ts` | Quota/usage telemetry (issue #91) |
| `script/agent/limits.ts` | Failure classification & retry policy (issue #92) |
| `script/agent/telemetry.ts` | Usage/task efficiency ledger (issue #93) |
| `script/agent/recommend.ts` | Task-aware route recommendation (issue #94) |
| `script/agent/policy.ts` | project-init policy resolver (issue #95) |
| `script/agent/preflight.ts` | Execution admission & task classification (issue #96) |
| `script/agent/machines.ts` | Machine inventory & placement (issue #97) |
| `script/agent/workspace.ts` | Workspace/runtime leases (issue #98) |
| `script/agent/attempts.ts` | Durable attempts, fencing, checkpoints (issue #99) |
| `script/agent/task.ts` | Herdr dispatch/collect (issue #100) |
| `script/agent/recovery.ts` | Cross-harness/host recovery (issue #101) |
| `script/agent/quality.ts` | SHA-pinned quality gate (issue #102) |
| `script/agent/delivery.ts` | GitHub delivery/reconciliation (issue #103) |
| `script/agent/fallback.ts` | Opt-in continuity profile (issue #136) |
| `script/agent/fallback-exec.ts` | Same-harness fallback execution (issue #139) |

## Policy Controls

Deterministic policy evaluation controls live in `evals/agent-router/controls.sh`.
Run with:

```bash
bash evals/agent-router/controls.sh
```

Positive controls verify valid behavior passes. Negative controls verify
invalid behavior fails. Regression controls verify known-bad inputs never
regress to PASS.

Hard failures tested:
- sandbox/secret exfiltration
- silent paid fallback
- wrong provider
- policy conflict
- stale approvals
- unauthorized merge
- split-brain
- unknown quota
- misleading success

## Testing

```bash
# Full test suite
bun test script/agent.*.test.ts script/agent/*.test.ts

# Individual modules
bun test script/agent.policy-evals.test.ts
bun test script/agent.fallback.test.ts
bun test script/agent.recovery.test.ts

# Quality gates
./script/check-secrets
./script/test-workflow
bun script/agent.ts check
```

## Known Limitations

- Reviewer authenticity is `distinct-only` (issue #124): reviewer distinctness
  from builder is enforced, but authenticity must be established by the
  delivery channel.
- Real provider E2E, Windows/WSL/macOS native, and Herdr pane round-trip
  are tracked in #104/#105.
- `home/snippets/` is not on release branches; `script/check` treats missing
  snippets as pre-existing state (not a failure of agent launcher changes).
