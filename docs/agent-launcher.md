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

## Free-tier providers ($0, explicit opt-in)

Policy: [ADR-0018](adr/ADR-0018.md). Measurements:
[free-provider-evaluation-2026-11-13](research/free-provider-evaluation-2026-11-13.md).

These routes exist so agent work can continue when the OpenCode Go / Zen
allowance, the MiniMax plan window or an OpenRouter budget is exhausted, at
$0 additional monthly cost (no pay-as-you-go, no new subscription). They are
**explicit opt-in only**: nothing here is a fallback target, and no code path
moves from a free route to a paid one.

```bash
agent claude kilo            # first choice: Kilo free models (bare-origin Anthropic endpoint)
agent opencode kilo          # Kilo free models (OpenAI-compatible /v1)
agent omp kilo               # Kilo free models through OMP's native provider
agent claude requesty        # independent free path (org-wide 200/day, 20/min)
agent opencode requesty
agent opencode ovhcloud      # anonymous: NO credential, 2 req/min
agent omp groq               # Groq free tier (8k tokens/min: OMP only)
```

| route | default model | credential | limit that matters |
|---|---|---|---|
| `claude.kilo`, `opencode.kilo`, `omp.kilo` | `nvidia/nemotron-3-ultra-550b-a55b:free` | Infisical `KILO_API_KEY`, `require_infisical` | 200 req/hour anonymous; per-upstream limits |
| `claude.requesty`, `opencode.requesty` | `nvidia/nemotron-3-ultra-550b-a55b` | Infisical `REQUESTY_API_KEY`, `require_infisical` | 200 req/day, 20 req/min per organization (all free models combined) |
| `opencode.ovhcloud` | `gpt-oss-120b` | **none** (`anonymous = true`) | 2 req/min per IP and per model |
| `omp.groq` | `openai/gpt-oss-120b` | Infisical `GROQ_API_KEY`, `require_infisical` | 8,000 tokens/min (binding), 1,000 req/day |

Selectable alternatives: on `kilo`, `--model kilo-auto/free` (free-model
router), `--model cohere/north-mini-code:free` (code specialist),
`--model reflection/beam-free` (1M context, ~4× slower),
`--model nvidia/nemotron-3.5-lightning:free`; on `requesty`,
`--model nvidia/nemotron-3.5-lightning-30b-a3b` or
`--model google/gemma-4-31b-it`; on `ovhcloud`, `--model gpt-oss-20b` or
`--model Meta-Llama-3_3-70B-Instruct` (slower; timed out on the bug-fix
evaluation).

### Why some combinations deliberately do not exist

- **No `opencode.groq`.** Groq's free tier allows 8,000 tokens/min; an
  OpenCode turn's system prompt plus tool definitions alone requests
  ~9.9–10.7k tokens, so every real turn is rejected with 429 before a
  response. OMP's smaller prompt stays under it and completes real tasks.
- **No `claude.ovhcloud` / `omp.ovhcloud`.** The endpoint is
  OpenAI-compatible only (`POST /v1/messages` → 404), and the Anthropic
  adapter must send an auth token — with a credential-free endpoint Claude
  Code would fall back to its own claude.ai login and silently leave the
  route. The adapter rejects `anonymous` providers instead of letting that
  happen. OMP has no native `ovhcloud` provider, and its credential ladder has
  no proven credential-free contract, so no `omp.ovhcloud` route exists
  either.
- **No `omp.requesty`.** OMP has no native `requesty` or `ovhcloud`
  provider id (`Unknown provider "requesty"`), and adding one would require
  a local `models.yml` endpoint override, which this design does not allow.
- **No route at all for ModelScope, SenseNova or SiliconFlow.** Their keys
  exist in Infisical but the accounts are not entitled, and the reason for each
  is now identified: ModelScope's token is valid but the account is not bound
  to an Alibaba Cloud account; SenseNova's key matches neither Token Plan
  workspace; SiliconFlow's key is valid only on the international host, where
  the free chat IDs answer 402/403. These are account actions, not launcher
  defects — see
  [blocked-provider-investigation-2026-11-13](research/blocked-provider-investigation-2026-11-13.md).
  A key is not evidence that a route is free, so a route that cannot be proven
  $0 must not be reachable.

### New config attributes

```toml
[providers.ovhcloud]
anonymous = true                 # credential-free endpoint; no secret is fetched,
                                 # no credential env name reaches the child.
                                 # Rejected together with secret/env/require_infisical.

[providers.kilo]
opencode_base_url = "https://api.kilo.ai/api/gateway/v1"
                                 # re-spell the endpoint for the OpenCode custom-provider
                                 # block (requires opencode_npm; defaults to base_url).
                                 # Claude Code appends /v1/messages itself, so its
                                 # ANTHROPIC_BASE_URL must be the bare origin.
```

`agent check` validates both, plus that a provider declaring `opencode_npm`
is reachable from at least one `opencode` route (otherwise the custom-provider
block would sit silently inert).

### Data handling

Every Kilo free id reports `mayTrainOnYourPrompts = true`, and Kilo's Auto
Free docs warn that prompts may be logged by the upstream provider; the
NVIDIA-hosted free ids are trial-only under NVIDIA's API Trial Terms. Use
these routes for code and non-sensitive work — not for credentials, customer
data or private material. `agent routes` shows each provider's `terms`.

### What these routes do not guarantee

The model allowlist only prevents the launcher from selecting a different
id. If a provider starts charging for an id, or retires it, the launcher will
still try it. Re-check the live catalog before relying on a route, and keep
an account-side hard stop (spend limit, or pay-as-you-go switched off) where
the provider offers one — the launcher cannot see or change those settings
and does not claim to.

### Credentials (names only)

`KILO_API_KEY`, `REQUESTY_API_KEY` and `GROQ_API_KEY` live in the self-hosted
Infisical `dev` environment (project `d4c2fc09-a923-4a38-9cf4-b51769aadb76`)
and were already present on 2026-11-13. They are all `require_infisical`, so a
stale ambient value is stripped before the wrapper and a missing Infisical
value fails closed — these routes exist to spend *this* account's free
allowance, and an ambient key was measured to silently point the route at a
different account. `opencode.ovhcloud` needs no secret at all and runs no
Infisical stage.

`MODELSCOPE_API_KEY`, `SENSENOVA_API_KEY` and `SILICONFLOW_API_KEY` are also
stored in `dev` but are deliberately unused: the accounts are not entitled, so
no route reads them. Each cause is identified — see
[blocked-provider-investigation-2026-11-13](research/blocked-provider-investigation-2026-11-13.md).
All three need a one-time console action by the account owner:

| provider | action | where |
| --- | --- | --- |
| ModelScope | Bind an Alibaba Cloud account that has completed real-name verification. The token is already valid; the `.cn` site must be used (the international site cannot bind). | `https://modelscope.cn/my/settings/account` |
| SenseNova | Confirm a key exists under the Free (公测) plan for the 日日新 account, or issue one from the intended TokenPlan workspace. The stored key matches neither. | `https://platform.sensenova.cn` → API Keys |
| SiliconFlow | Complete real-name verification. The stored key is valid on the international host only; a `.cn` key would need a separate Infisical name. | SiliconFlow console → account |

After the action, re-run the probe in the investigation doc; a working account
turns the 401/402 into a normal completion, and only then should a route be
added (with fresh E2E evidence, per ADR-0018).

### $0 continuity when an allowance is exhausted (429)

Normal launches never switch providers. To continue the *same authorized
work* at $0 after a 429 / exhausted allowance, use an explicit opt-in
continuity profile (ADR-0017 mechanism, ADR-0018 policy). Inspect it first —
`agent fallback <id>` only resolves and displays, it never executes:

```bash
agent fallback free-go-to-kilo          # Go allowance exhausted -> Kilo -> Groq
agent fallback free-kilo-quota          # Kilo exhausted -> Groq
agent fallback opencode-requesty-quota  # Requesty exhausted -> Kilo (OpenCode)
agent fallback <id> --json              # redacted machine-readable form
```

Each profile declares `global_max_spend = 0`, so the resolver's spend checks
can never authorise paid usage. Candidates are `billing = "free"` and are
bound to the harness of their primary route (OMP has no native Requesty or
OVHcloud provider, so those cannot appear in an `omp` profile).

The resolver is the enforcement point, not the profile author's intent. It
rejects a candidate when:

- the primary's own allowance is not catalogued (`primary-quota-unknown`) —
  without it the independence check cannot run at all, so every candidate is
  refused rather than assumed fresh;
- the provider's catalogued `billing` does not match the declared boundary
  (`billing-boundary-crossed`), or is not catalogued at all (`billing-unknown`
  — unknown billing is never treated as free);
- the provider itself carries a `[catalog.providers.<id>.restriction]`
  (`provider-restricted`) — route-level evidence cannot unlock a provider
  whose allowance is unusable;
- a `free` candidate declares a positive `max_spend` (`spend-cap-invalid`),
  or any cap would exceed the profile/global cap;
- the candidate's *effective* scope equals the primary's
  (`quota-exhausted-scope`) — e.g. two models on the *same* Kilo account are
  not fresh capacity — or its scope is not catalogued (`quota-scope-unknown`).
  Both sides use the same route-first, provider-second rule, so a route that
  declares its own quota is compared by that quota;
- its attestation is `restricted`, `unknown` or stale.

`agent fallback` seeds attestations from the **committed** `[catalog.routes.*]`
E2E/restriction records, then merges local probe state by **severity first,
then evidence timestamp**: any observed `restricted` entry wins over a
non-restricted one regardless of recency (catalog evidence is day-precision, so
a same-day local block would otherwise tie and lose), and otherwise only a
strictly newer record wins while a tie keeps the committed one. So a fresh
machine resolves against reviewed evidence, a stale committed record still fails
the freshness check, and an older — or same-day — local observation cannot hide
a newer committed restriction.

Provider-wide and route-wide `[catalog.*.restriction]` are checked directly in
the resolver rather than only through seeding, because seeding can only attach a
per-model fact to models named in that route's `e2e` list (a restricted route
with no e2e, such as `omp.deepseek`'s 402, would otherwise have no seeded entry).
Any present restriction blocks; only an explicit `unknown` status is treated as
"no fact". A route with no committed evidence stays `attestation-unknown` and is
not usable.

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
