# Free-tier provider evaluation — 2026-11-13

Research record for [ADR-0018](../adr/ADR-0018.md). Every number here is a
measurement from this machine, not a provider claim, unless the row says
otherwise. Keys were read from the self-hosted Infisical `dev` environment
through `script/with-secrets`; **no secret value appears in this file** (only
lengths/prefix-shaped metadata where it was needed to diagnose an auth
failure, and only for keys that turned out to be unusable).

Environment: macOS, Bun 1.4.2, Claude Code 2.1.322, OpenCode 2.2.7,
OMP 18.18.9, dsh 0.2.0-rc.2. Date of all measurements: 2026-11-13.

## 1. Registration and reachability

| Provider | Infisical secret | Reached | Usable free? |
| --- | --- | --- | --- |
| Kilo Gateway | `KILO_API_KEY` (268 chars) | yes | **yes** |
| Requesty | `REQUESTY_API_KEY` (117 chars) | yes | **yes** |
| GroqCloud | `GROQ_API_KEY` (56 chars) | yes | **yes** (OMP only, token-budget bound) |
| OVHcloud AI Endpoints | none (anonymous) | yes | **yes** (2 req/min) |
| ModelScope | `MODELSCOPE_API_KEY` (39 chars, `ms-` prefix) | catalog yes, inference no | **no — blocked** (account not bound to Alibaba Cloud) |
| SenseNova | `SENSENOVA_API_KEY` (35 chars, `sk-q` prefix) | no | **no — blocked** (key matches neither Token Plan workspace) |
| SiliconFlow | `SILICONFLOW_API_KEY` (51 chars, `sk-g` prefix) | `.com` catalog yes, inference no | **no — blocked** (not verified/entitled; key is `.com` only) |

Root causes for the three blocked providers were identified in a follow-up
round: see
[blocked-provider-investigation-2026-11-13](blocked-provider-investigation-2026-11-13.md).
They are account-eligibility issues, not launcher defects, and each needs a
one-time console action by the account owner.

### Blocked providers (details)

**ModelScope.** `GET https://api-inference.modelscope.cn/v1/models` returns
200 (so the catalog and the key's transport are fine), but every
`POST /v1/chat/completions` returns:

```json
{"error":{"message":"Authentication failed, please make sure that a valid ModelScope token is supplied."}}
```

with HTTP 401. Tried: `Authorization: Bearer`, `X-API-Key`, `X-Request-Id`,
`X-ModelScope-Async-Mode: true`, `Qwen/Qwen3.8-27B` and
`Qwen/Qwen3-Coder-30B-A3B-Instruct`, and `api-inference.modelscope.com`
(does not resolve). `/v1/messages` fails the same way. The token authenticates
for catalog listing but not for inference — a scope/permission issue on the
token, not a launcher bug.

**SenseNova.** `api.sensenova.cn` resets the connection on `/compatible-mode/v1`
(`curl: (35) Recv failure`), `api.sensenova.cn/v1/*` answers
`404 no Route matched with those values`, and `token.sensenova.cn/v1/models`
plus `/v1/chat/completions` answer
`{"error": {"code": 16, "message": "Forbidden"}}` with HTTP 401 — also with
`x-api-key` instead of `Bearer`. `docs.sensenova.cn` does not resolve. The
Token Plan is documented as a limited-time free public beta with a phone
signup; this key is not entitled on either host.

**SiliconFlow.** `api.siliconflow.com/v1/models` returns a catalog with the
key (80 entries), but inference answers
`{"code":30001,"message":"Sorry, your account balance is insufficient"}` with
HTTP 402, and a nominally disabled model answers
`{"code":30003,"message":"Model disabled."}` with HTTP 403. The
`api.siliconflow.cn` host rejects the same key with HTTP 401 on both
`/v1/models` and inference. There is no free chat model on this account: the
catalog's chat models are paid, so this provider cannot satisfy the "$0
proven" rule.

## 2. Provider-published limits and terms

### Kilo Gateway (`https://kilocode.ai/docs/gateway`)

- Free ids are `:free`/`isFree`; Kilo's billing docs state they are `$0`
  ("Models tagged with `:free` have zero cost"). Measured `usage.cost = 0`
  and `cost_details.upstream_inference_* = 0` on free ids.
- `kilo-auto/free` is documented as "Free with limited capability. No credits
  required", routing across available free models.
- Anonymous users: 200 requests/hour per IP. Authenticated free requests are
  additionally subject to per-upstream limits, which the gateway does not
  publish as one number.
- "Free models are available to both authenticated and anonymous users."
- Auto Free warning: "Prompts may be logged by the upstream provider and used
  to improve their services. Not suitable for production or sensitive data
  workloads." NVIDIA free endpoints are trial-only under NVIDIA's API Trial
  Terms.
- Public catalog (`GET /api/gateway/v1/models`, no key): 473 models, **14**
  `isFree`, all reporting `tools` support.

### Requesty (`https://docs.requesty.ai/features/free-models`)

- Free models are "$0 input / $0 output", "free for now", changes announced
  in the changelog.
- Limits are **per organization, across all free models combined**:
  new organization 200 requests/day and 20 requests/minute; paying
  organization 1,000/day and 60/minute.
- Public catalog: 750 entries, **8** with `input_price = output_price = 0`,
  all `supports_tool_calling = true`.

### GroqCloud (`https://console.groq.com/docs/rate-limits`)

- Free tier, no credit card, per organization and per model:
  30 req/min, 1,000 req/day, 8,000 tokens/min, 200,000 tokens/day.
- Confirmed live in response headers: `x-ratelimit-limit-requests: 1000`,
  `x-ratelimit-limit-tokens: 8000`.
- Note: a plain `curl` user agent got `HTTP 403 error code: 1010` (Cloudflare
  bot check); a browser-like UA or the OpenAI-style UA works. This does not
  affect the harnesses (they send their own UA and succeeded).

### OVHcloud AI Endpoints (`help.ovhcloud.com`, AI Endpoints capabilities)

- "Anonymous: 2 requests per minute, per IP and per model. Authenticated with
  an API access key: 400 requests per minute, per Public Cloud project and per
  model." Exceeding it returns 429.
- Payload limits: 2 MB per request body (10 MB for VLM).
- Measured: 3 rapid gpt-oss-120b requests returned `200, 429, 429`, and the
  window recovered after ~60 s.
- Measured auth shape: no `Authorization` header → 200; invalid
  `Bearer sk-not-a-real-key` → **403**. So the anonymous tier is not a
  "credential is optional and ignored" hole; a presented bad key is rejected.
- Public catalog lists `pricing.prompt` per model, but those are the
  *authenticated* list prices, not the anonymous tier's price. The anonymous
  tier itself has no per-token charge.

## 3. Model catalogs (free slice)

### Kilo free ids (public catalog)

| id | context | max output | tools | notes |
| --- | --- | --- | --- | --- |
| `nvidia/nemotron-3-ultra-550b-a55b:free` | 1,000,000 | 65,536 | yes | default; fastest correct |
| `kilo-auto/free` | 256,000 | 32,768 | yes | free-model router |
| `cohere/north-mini-code:free` | 256,000 | 64,000 | yes | code specialist; moderated |
| `reflection/beam-free` | 1,048,576 | 131,072 | yes | largest context, slowest |
| `nvidia/nemotron-3.5-lightning:free` | 1,000,000 | 65,536 | yes | mid-speed |
| `nvidia/nemotron-3.5-super-vl:free` | 1,000,000 | 131,072 | yes | vision-capable, not exercised |
| `baidu/ernie-5.5-flash-preview:free` | 1,024,000 | 921,600 | yes | not exercised |
| `apodex/apodex-1.1-mini:free`, `dots-studio/dots-3-note-preview:free`, `liquid/lfm-3-1.7b:free`, `particle-ai/particle-1:free`, `stealth/glyph-cluster`, `nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free`, `openrouter/free` | various | various | yes | not exercised |

Rejected: `deepseek/deepseek-v4-flash:free` is listed in the account-visible
catalog but answers "The requested model does not exist" at request time.

### Requesty free ids

`nvidia/nemotron-3-ultra-550b-a55b` (1M ctx), `nvidia/nemotron-3.5-lightning-30b-a3b`
(1M), `google/gemma-4-31b-it` (262k), `nvidia/nemotron-3-nano-30b-a3b` (262k),
`nvidia/nemotron-3-nano-omni-30b-a3b-reasoning` (131k),
`nvidia/muse-glimmer-30b` (131k), `novita/ling-3.1-flash` (262k),
`mistral/leanstral-1-5` (262k).

Rejected: `nvidia/nemotron-3-super-120b-a12b` is still in models.dev but
Requesty answers `404 The requested model ... is no longer available`.

### OVHcloud chat ids

`gpt-oss-120b` (131k), `gpt-oss-20b` (131k), `Meta-Llama-3_3-70B-Instruct`
(131k), `Mistral-Small-3.2-24B-Instruct-2506` (131k), `Qwen3.5-397B-A17B`
(262k), `Qwen3.5-9B` (262k), `Qwen3.6-27B` (262k), `Qwen3.8-27B` (262k).
Non-chat (embeddings/guards/TTS/whisper/stable-diffusion) excluded.

### Groq free chat ids

`openai/gpt-oss-120b` (131k), `openai/gpt-oss-20b` (131k),
`qwen/qwen3.8-27b` (131k). `groq/compound` and `groq/compound-mini` appear in
models.dev but this account answers `404 model_not_found`.

## 4. Raw tool-call probe (OpenAI-compatible wire)

One request per model: `tools` with a `run_shell` function, `tool_choice:
auto`, a prompt asking for `echo AGENT_TOOL_OK`.

| Provider / model | HTTP | tool call | latency | cost |
| --- | --- | --- | --- | --- |
| kilo `kilo-auto/free` | 200 | yes (`run_shell` → `echo AGENT_TOOL_OK`) | 2.1 s | 0 |
| kilo `nvidia/nemotron-3-ultra-550b-a55b:free` | 200 | yes | 2.6 s | 0 |
| requesty `nvidia/nemotron-3-ultra-550b-a55b` | 200 | yes | 4.0 s | 0 |
| siliconflow `zai-org/GLM-5.3-Flash` | — | — | — | 402 (blocked) |
| modelscope `deepseek-ai/DeepSeek-V4.1-Flash` | 401 | — | — | blocked |
| groq `openai/gpt-oss-120b` | 200 | yes | — | free tier |
| ovhcloud `Meta-Llama-3_3-70B-Instruct` (no auth) | 200 | yes | — | anonymous |

Anthropic-compatible `/v1/messages` probe (same shape, `x-api-key` +
`Authorization`): Kilo 200, Requesty 200, SiliconFlow 402, Groq 404 (no such
path), OVHcloud 404 (no such path), ModelScope 401.

## 5. Real agentic evaluation

Two tasks, run through the real harness binaries with `--permission-mode
bypassPermissions` (Claude) / `--standalone` (OpenCode) / worker tool surface
(OMP), each in a fresh temporary directory.

**Task A (implement):** "Create `fib.ts` exporting `fib(n)` with memoization.
Create `fib.test.ts` with Bun tests for fib(0)=0, fib(1)=1, fib(30)=832040.
Run `bun test` and fix failures. Then write the single line `DONE` into
`result.txt`."

**Task B (debug/repair):** a fixture module with three planted defects
(case-sensitive method match, missing percent-decoding, lost leading slash)
and a 12-case Bun suite that must not be modified. Success requires: suite
green **and** `router.test.ts` byte-identical **and** `router.ts` changed.

`dur` is wall clock; `tests` is the independent `bun test` run afterwards;
`tampered` is a byte comparison of the test file.

### Task A — implement

| Route / model | rc | dur | files | tests |
| --- | --- | --- | --- | --- |
| claude / kilo ultra | 0 | 29.9 s | all 3 | pass |
| claude / kilo-auto/free | 0 | 28.8 s | all 3 | pass |
| claude / requesty ultra | 0 | 31.3 s | all 3 | pass |
| opencode / kilo ultra | 0 | 19.8 s | all 3 | pass |
| opencode / kilo-auto/free | 0 | 18.8 s | all 3 | pass |
| opencode / kilo cohere-north | 0 | 19.9 s | all 3 | pass |
| opencode / requesty ultra | 0 | 16.6 s | all 3 | pass |
| opencode / ovh gpt-oss-120b | 0 | 115–154 s | all 3 | pass |
| opencode / ovh llama-3.3-70b | 0 | 257 s | all 3 | pass |
| omp / kilo ultra | 0 | 23.4 s | all 3 | pass |
| omp / kilo-auto/free | 0 | 19.0 s | all 3 | pass |
| omp / groq gpt-oss-120b | 0 | 319.8 s | all 3 | pass |
| opencode / groq gpt-oss-120b | 1 | 5.3 s | — | 429, 9,953 > 8,000 TPM |
| opencode / siliconflow GLM-5.3-Flash | 1 | 5.5 s | — | 402 balance |
| opencode / modelscope Qwen3-Coder | 1 | 5.6 s | — | 401 |
| opencode / kilo deepseek-v4-flash:free | 1 | 5.3 s | — | model does not exist |

### Task B — debug/repair (the differentiating task)

| Route / model | rc | dur | suite | implementation fixed | test file tampered |
| --- | --- | --- | --- | --- | --- |
| claude / kilo ultra | 0 | 38.9 s | pass | yes | **no** |
| claude / kilo-auto/free | 0 | 49.3 s | pass | yes | no |
| claude / kilo cohere-north | 0 | 38.1 s | pass | yes | no |
| claude / kilo beam-free | 0 | 157.8 s | pass | yes | no |
| claude / kilo nemotron-lightning | 0 | 84.3 s | pass | yes | no |
| claude / requesty ultra | 0 | 44.0 s | pass | yes | no |
| claude / requesty lightning-30b | 0 | 96.2 s | pass | yes | no |
| claude / requesty gemma-4-31b | 0 | 65.5 s | pass | yes | no |
| opencode / kilo ultra | 0 | 128.6 s | pass | yes | no |
| opencode / kilo-auto/free | 0 | 66.9 s | pass | yes | no |
| opencode / kilo cohere-north | 0 | 85.5 s | pass | yes | no |
| opencode / requesty ultra | 0 | 42.5 s | pass | yes | no |
| opencode / ovh gpt-oss-120b | 0 | 153.6 s | pass | yes | no |
| opencode / ovh llama-3.3-70b | 1 | 600.5 s (timeout) | fail | no | no |
| omp / kilo ultra | 0 | 41.0 s | pass | yes | no |
| omp / kilo-auto/free | 0 | 74.3 s | pass | yes | no |

No model weakened or deleted the tests, and every successful run edited the
implementation rather than the assertions. The OVHcloud Llama 3.3 70B run
burned its 600 s budget inside the 2 req/min anonymous window; that is a
capacity symptom, not a correctness one.

### Task C — Groq token-budget boundary

OpenCode through a custom provider with explicit `limit.context` and varying
output budgets. All rejected **before a response**, i.e. the harness could not
even start a turn:

| output budget | requested tokens | result |
| --- | --- | --- |
| 512 | 9,853 | 429 TPM |
| 1,024 | 10,533 | 429 TPM |
| 2,048 | 9,876 | 429 TPM |
| 4,096 | 10,703 | 429 TPM |

OMP with the launcher's worker tool surface stayed under 8,000 and finished
both tasks. This is why `omp.groq` exists and `opencode.groq` does not.

## 6. OMP provider coverage

`omp models --json` inside Infisical, 2026-11-13: `kilo` 728 entries,
`openrouter` 623, `siliconflow` 60, `opencode-zen` 49, `mistral` 44,
`opencode-go` 28, `groq` 20, `deepseek` 4, `apple` 1. **`requesty` and
`ovhcloud` are not native OMP providers** (`Unknown provider "requesty"` /
`"ovhcloud"`), which is why no `omp.requesty` / `omp.ovhcloud` route exists.
`omp.kilo` and `omp.groq` use OMP's native provider ids.

OpenCode has native catalog entries for `kilo` (728 models) but the catalog
it ships is stale: a native `kilo/...` run works, while a native request for
`requesty/...` or `groq/...` resolved to an unrelated paid OpenCode model and
failed with "Insufficient balance". Consequently Requesty, OVHcloud and Groq
are registered through the launcher's `opencode_npm` block, which pins the
base URL and the model list explicitly instead of trusting the client
catalog.

## 7. Resulting configuration

See `config/agents.toml` `[providers.kilo]`, `[providers.requesty]`,
`[providers.ovhcloud]`, `[providers.groq]` and the matching `[routes.*]` and
`[catalog.*]` tables, and `docs/adr/ADR-0018.md` for the policy.

New launcher attributes introduced by this work:

- `anonymous = <bool>` — the endpoint needs no credential; no secret is
  fetched and no credential env name reaches the child.
- `opencode_base_url = "<url>"` — re-spell the endpoint for the OpenCode
  custom-provider block when the Anthropic adapter needs a different origin
  (`opencode_npm` required).

Both are validated in `agent check` and covered by
`bun test script/agent.test.ts`.

## 8. Continuity profiles ($0, opt-in)

Three `[fallback_profile.*]` entries were added so a 429 / exhausted allowance
does not stop work:

| profile | primary | candidates (in order) |
| --- | --- | --- |
| `free-go-to-kilo` | `omp.opencode-go` | `omp.kilo` → `omp.groq` |
| `free-kilo-quota` | `omp.kilo` | `omp.groq` |
| `opencode-requesty-quota` | `opencode.requesty` | `opencode.kilo` |

All three declare `global_max_spend = 0` and `billing = "free"` candidates
with `max_spend = 0`. Candidates must share the primary's harness: OMP has no
native `requesty`/`ovhcloud` provider (`Unknown provider`), so no `omp`
profile may name them. OVHcloud is excluded from every profile anyway: 2
req/min cannot carry an agentic turn.

Resolution measured 2026-11-13 after the resolver fixes below:
`free-go-to-kilo`, `free-kilo-quota` and `opencode-requesty-quota` all report
`STATUS: USABLE` from the committed catalog E2E records, while
`omp.openrouter` (no committed e2e) stays `attestation-unknown` and
`omp.openrouter-free` (1-day-old record) stays `attestation-stale`. The
existing `omp-mistral-quota` profile therefore correctly reports
`NO USABLE CANDIDATES` — its paid and free candidates are genuinely
unverified, and the launcher does not paper over that.

### Resolver defects found and fixed while building this

The pre-existing `resolveFallbackProfile` had four checks that did not
actually enforce anything:

1. **Billing boundary** was a no-op (`if (cand.billing === "free" && …) { /* Warn
   but don't reject */ }`), so a `free`-labelled candidate pointing at a
   metered provider was accepted.
2. **Unknown billing** was ignored entirely.
3. **`max_spend`** was not related to the billing boundary, so a `free`
   candidate could declare a positive cap.
4. **Shared quota scope** compared `cand.routeConfig.provider + ":" +
   cand.credential` against a key built as `<secret>:<env>`, which never
   matches a real `quotaScopeKey` (`<kind>:<id>`) — the check could not fire.

They are now `billing-unknown`, `billing-boundary-crossed`,
`spend-cap-invalid` and a real `effectiveQuotaKey` comparison (with
`quota-scope-unknown` when independence cannot be proven). `agent fallback`
and `executeWithFallback` now share one `buildFallbackCatalog(config,
catalogFacts)` builder and both load the validated catalog, so they cannot
disagree.

Four further gaps were found in independent review and fixed:

5. **Unknown primary scope skipped the quota check entirely.** When the
   primary's allowance was not catalogued, `primaryQuotaScopeKey` was `null`
   and the whole comparison was bypassed, so a candidate could be declared
   fresh capacity with no evidence that it was not drawing on the exhausted
   primary's budget. Now `primary-quota-unknown` rejects every candidate.
6. **Provider-wide restriction was dropped.** Only route-level
   `[catalog.routes.*.restriction]` reached the resolver, so a route under a
   restricted provider could resolve as usable purely on its own fresh e2e
   evidence. The provider restriction is now carried into
   `FallbackCatalogFacts`/`CatalogLike` and checked in resolution
   (`provider-restricted`); seeding cannot do it, having no route→provider
   map.
7. **Candidate quota used provider scope only.** The primary used
   `effectiveQuotaKey` (route scope overrides provider scope) while the
   candidate used `providerConfig.quota_scope`, so a candidate route with its
   own quota could be accepted while sharing the primary's effective
   allowance, or rejected while being independent. Both sides now use the
   same route-first rule via `effectiveRouteQuotaKey`.
8. **`mergeAttestations` ignored evidence timestamps.** Any local entry
   replaced a committed one with the same key, so an older `verified-live`
   local observation could hide a newer committed `restricted` one (still
   inside the 7-day window) and resolve a blocked route as usable — or stale
   local evidence could make a healthy route look stale. A local entry now
   wins only when its `evidence.at` is strictly newer; a tie or unparsable
   timestamp keeps the committed entry.

Separately, `agent fallback` only read ephemeral `agentStateDir()/catalog`
probe state, so every committed route reported `attestation-unknown` and no
profile could ever resolve on a fresh machine. It now seeds from the
committed `[catalog.routes.*]` e2e/restriction records and lets fresher local
probe state override them; freshness still applies, so seeding cannot make a
dead route look healthy.
