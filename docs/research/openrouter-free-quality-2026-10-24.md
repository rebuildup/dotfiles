# OpenRouter free model quality evidence

Research date: 2026-10-24 JST. The unauthenticated official models API was
retrieved at **2026-10-23T16:10:56.302744Z**. No authenticated quota endpoint or
inference endpoint was called for this research. This document records public
availability and benchmark evidence; it does not qualify any model/harness pair.

## Live catalog snapshot

Source: [OpenRouter public models API](https://openrouter.ai/api/v1/models).
There were 17 IDs ending in `:free`. Each returned pricing object contained
`prompt: "0"` and `completion: "0"`, with no other pricing entries. Catalog
presence is not an inference availability guarantee. Re-fetch before use.

| Model ID | Context tokens | Input modalities | Tools | Expiration |
| --- | ---: | --- | --- | --- |
| `recursive/flint-v1.0:free` | 262144 | text | yes | null |
| `xingchen-agi/xing4.0-29b-a4b:free` | 262144 | text | yes | null |
| `nvidia/nemotron-3.5-super-vl:free` | 1000000 | text, image, video | yes | null |
| `dots-studio/dots-3-note-preview:free` | 512000 | text, image | yes | 2026-12-31 |
| `liquid/lfm-2.5-2.6b:free` | 65536 | text | yes | null |
| `nvidia/nemotron-3.5-lightning:free` | 1000000 | text | yes | null |
| `thinkingmachines/inkling-small:free` | 1048576 | text, image, audio | yes | null |
| `poolside/laguna-s-2.1:free` | 262144 | text | yes | 2026-10-31 |
| `thinkingmachines/inkling:free` | 1048576 | text, image, audio | yes | null |
| `poolside/laguna-xs-2.1:free` | 262144 | text | yes | 2026-10-31 |
| `cohere/north-mini-code:free` | 256000 | text | yes | null |
| `nvidia/nemotron-3.5-content-safety:free` | 128000 | text, image | no | null |
| `nvidia/nemotron-3-ultra-550b-a55b:free` | 1000000 | text | yes | null |
| `nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free` | 256000 | text, audio, image, video | yes | null |
| `google/gemma-4-26b-a4b-it:free` | 262144 | image, text, video | yes | null |
| `google/gemma-4-31b-it:free` | 262144 | image, text, video | yes | null |
| `nvidia/nemotron-3-super-120b-a12b:free` | 262144 | text | yes | null |

All 17 returned text output. For a tool-using text agent with a minimum context
of 128000, Content Safety fails the tools requirement and Liquid fails the
context requirement. Flint lists `tools` but not `tool_choice`; adapters that
require the latter must reject it. Multimodal input support alone does not prove
or disprove text-agent suitability. All four requested initial candidates are
present and list both `tools` and `tool_choice`, but remain quality-unverified
until the exact harness/model pair is evaluated. Laguna S/XS expire on October
31 and must be excluded when the configured expiry margin is reached.

The Super entry's `canonical_slug` was
`nvidia/nemotron-3-super-120b-a12b-20230311`. Preserve this as observed metadata;
do not infer a release date from the anomalous suffix. The official NVIDIA model
card instead gives 2026-03-11 as its release date.

## Public benchmark records

[Machine-readable records](../../config/openrouter-benchmarks.json) retain
separate benchmark names, versions, conditions and sources. Their `updated_at`
is this research's observation timestamp, not an invented evaluation date.
These are vendor-reported results on their documented infrastructure, not local
OpenRouter free-endpoint measurements. Percentages below use a 0–100 scale.
They must not be averaged across benchmarks or substituted for local E2E.

| Model / source revision | Metric | Value | Conditions |
| --- | --- | ---: | --- |
| Nemotron 3 Ultra 550B-A55B BF16, report cover 2026-06-09, Table 10 | Terminal-Bench 2.1 | 56.4% | NVIDIA evaluation suite; SDK uses NeMo Gym, Skills and Harbor. Exact score-specific harness revision and trial count were not established by this research. |
| Same Ultra report and precision | SWE-bench Verified | 70.7% | Same report; keep distinct from Terminal-Bench. |
| Laguna S 2.1 118B-A8B, publication 2026-07-21 | Terminal-Bench 2.1 | 70.2% | `pool` harness, thinking enabled; pass@1 averaged over four attempts per task. |
| Same Laguna publication | DeepSWE v1.1 | 40.4% | `pool` harness, thinking enabled; pass@1 averaged over three attempts per task. |
| Nemotron 3 Super, official evaluation page observed 2026-10-24 | SWE-bench Verified | 60.47% | OpenHands; exact harness revision, trial count and evaluation date not established. |
| Same Super source | SWE-bench Verified | 59.20% | OpenCode; a separate harness result. |
| Same Super source | Terminal-Bench Core 2.0 | 31.00% | Harbor; different benchmark version from Ultra/Laguna 2.1. |
| North Mini Code 1.0, June 2026 launch statement | Artificial Analysis Coding Index | 33.4 | Composite index; index revision and evaluation date unspecified in launch statement. Not a task completion percentage. |

Sources and reproducibility limitations:

- [NVIDIA Ultra technical report](https://research.nvidia.com/labs/nemotron/files/NVIDIA-Nemotron-3-Ultra-Technical-Report.pdf),
  cover 2026-06-09, section 3.7 and Table 10, documents common evaluation
  resources/data/prompts/repeats within its own comparison and model-card
  recommended inference parameters. Its BF16 SWE score is 70.7. The
  [NVIDIA NIM page](https://docs.api.nvidia.com/nim/re/reference/nvidia-nemotron-3-ultra-550b-a55b)
  and OpenRouter descriptions still display 71.9; do not silently merge these
  revisions. Quantized variants also have distinct results.
- [Poolside release](https://poolside.ai/blog/introducing-laguna-s-2-1),
  dated 2026-07-21, reports the two Laguna results above and publishes
  [evaluation trajectories](https://trajectories.poolside.ai/). Its cross-model
  table takes maximal vendor/leaderboard/third-party values, with different
  harnesses; it is not a controlled local comparison. DeepSWE's official board
  uses mini-swe-agent, whereas Poolside reports `pool`.
- [NVIDIA Super evaluation](https://docs.nvidia.com/nemotron/latest/nemotron/super3/evaluate.html)
  and [official agent cookbook](https://docs.nvidia.com/nemotron/latest/usage-cookbook/Nemotron-3-Super/OpenScaffoldingResources/README.html)
  distinguish harness results. The
  [FP8 model card](https://huggingface.co/nvidia/NVIDIA-Nemotron-3-Super-120B-A12B-FP8)
  separately reports Terminal-Bench hard subset 26.04% on 48 tasks. Hard subset,
  Core 2.0 and 2.1 results are not interchangeable.
- [Cohere launch statement](https://cohere.com/blog/north-mini-code) reports
  Coding Index 33.4. The
  [official model card](https://huggingface.co/CohereLabs/North-Mini-Code-1.0)
  documents SWE-agent v1.1.0, single-terminal ReAct for Terminal-Bench v2,
  Terminus-2 for Terminal-Bench Hard, three seeds, temperature 1.0 and top_p
  0.95. This does not establish the composite index's version. The live
  OpenRouter catalog lists Coding Index 36.5 without comparable methodology;
  retain the discrepancy instead of replacing the launch value. Cohere's
  [release note](https://docs.cohere.com/changelog/north-mini-code-1-0) is dated
  June 9; June 17 is OpenRouter's catalog listing date.

No source establishes that North should lead this launcher's automatic
selection. None of these public scores validates Claude Code, Pi or OpenCode
under the local fixture, request limits and provider behavior.

## Free request quota and errors

[Official pricing](https://openrouter.ai/pricing) documents 20 requests/minute
and 50/day, rising to 1000/day after at least $10 cumulative credit purchases.
Failed attempts count toward the daily allowance; monetary billing and request
quota are separate. These published defaults must not replace the key's actual
counter.

The [current-key API](https://openrouter.ai/docs/api/api-reference/api-keys/get-current-api-key)
returns `data.free_model_daily_requests` with numeric `used`, `limit`, and
`remaining`. `usage_daily` and `limit_remaining` concern credits, so neither
can supply remaining free requests. Missing or malformed request-counter data
must remain unknown rather than be inferred from credit usage or
`is_free_tier`. The latter is independent of the cumulative purchase tier.

[Official limits](https://openrouter.ai/docs/api_reference/limits) define the
counter's UTC-day window and note that exempt accounts/endpoints and BYOK are
not necessarily gated by that reported policy ceiling. The per-minute counter
is not exposed there. OpenRouter platform 429 responses carry rate-limit
headers; provider errors may carry `metadata.provider_code`. Successful
inference responses omit the rate-limit headers. Honor `Retry-After` when
present. A rate-limit error after stream start can appear in SSE despite an
HTTP 200 status. Record quota/transport/provider errors separately from model
ability, stop on exhausted quota, and avoid cross-model retry loops.

## Existing delivery state observed during research

[Issue #72](https://github.com/rebuildup/dotfiles/issues/72) was open.
[PR #73](https://github.com/rebuildup/dotfiles/pull/73) was open, non-draft and
unmerged at head `4d648e9ff79950543ee88268721f0dbba6ab3f2a`, branch
`feat/openrouter-free-dynamic`. GitHub reported `mergeable: true`, which is not
evidence of satisfied quality gates. Two unresolved review threads requested
strict canonical `"0"` pricing validation and rejection of every non-null
unparseable expiration value, including an empty string. Review claims still
require checking against the updated code.

The PR's historical API E2E remained incomplete due to a reported daily quota
error (`used 11545`, `limit 1000`, zero monetary usage). That old observation
cannot establish the current account quota, and no new authenticated check or
inference result is claimed by this research.

## Bounded local E2E screening (2026-10-24 JST)

Initial screening used Pi `0.73.1`, fixture digest
`5c4dbd1cf076d6bc8a554b358aa0cdd9c13bd3d41d61395d29416e1f9a515b76`,
`isolated-default-v1`, one trial, a 12-forwarded-inference-request cap and a
180-second task timeout. All calls used the exact `:free` model ID. Runs were
serial; API errors and task failures stopped the run. Raw sanitized per-run
logs and hashes are machine-local under `~/.cache/dotfiles-agent/`; they are
not committed.

| Model | Pi result | Requests | Duration | Interpretation |
| --- | --- | ---: | ---: | --- |
| `poolside/laguna-s-2.1:free` | 13 tool calls, 2 tool failures; no passing final grade | 9 | 180.060 s | Actual model observed; task timeout, counted as capability failure. |
| `cohere/north-mini-code:free` | 11 tool calls, 1 tool failure; public regression failed | 9 | 49.323 s | Actual model observed; capability failure. |
| `nvidia/nemotron-3-super-120b-a12b:free` | No model response | 1 | 3.146 s | HTTP 404, `Provider returned error`; infrastructure/provider failure, not a capability result. No retry. |
| `nvidia/nemotron-3-ultra-550b-a55b:free` | 15 tool calls, 2 tool failures; no passing final grade | 12 | 149.767 s | Actual model observed; per-trial request budget exhausted, counted as capability failure. |

The first current-key preflight reported 960 daily requests remaining. These
four guarded runs made 31 inference attempts; the counter later reported 932.
The evaluator's guarded attempt counts and the provider's daily counter differ
by three in this observation window, so the counter is not treated as an exact
per-call ledger.

One diagnostic run gave Nemotron 3 Ultra more headroom. It used the same Pi,
fixture and generation profile with one trial, a 24-request cap and a
240-second timeout. The exact model was observed and three tool calls occurred
before an OpenRouter HTTP 200 stream carried provider code 503,
`Upstream error from Nvidia: Service temporarily overloaded`. This is recorded
as an infrastructure failure and was not retried. It is a separate condition
profile and cannot be pooled with the initial screen. That run used four
guarded inference attempts. The latest current-key preflight reported 930
requests remaining; the counter decrease did not match guarded attempts
one-for-one.

No run was calibrated as a baseline. No model qualified. Claude Code and
OpenCode were not part of the four-model screen; the results above apply only
to Pi and the recorded fixture/conditions.

The previously configured top-priority candidate, North Mini Code, was then
screened once in the other installed harnesses using the same 12-request,
180-second Pi profile and fixture digest:

| Model / harness | Result | Requests | Duration | Interpretation |
| --- | --- | ---: | ---: | --- |
| `cohere/north-mini-code:free` / Claude Code `2.1.306` | 12 tool calls, 4 tool failures; no passing final grade | 12 | 46.519 s | Actual model observed; per-trial budget exhausted, capability failure. |
| `cohere/north-mini-code:free` / OpenCode `2.1.2` | 14 tool calls, no tool failures; no passing final grade | 12 | 44.524 s | Actual model observed; per-trial budget exhausted, capability failure. |

The current-key counter reset at the UTC-day boundary and reported 1000 before
these two runs, 991 after Claude Code and 981 after OpenCode. The guarded
attempt count was 24 while the counter fell by 19. No further inference was
attempted. This gives North a Pi/Claude Code/OpenCode screening result, but no
successful completion in any harness. No model was calibrated or qualified.
The runs do not establish the best model across all candidates/harnesses, and
failed attempts remain part of their fresh condition profile rather than being
replaced by cherry-picked batches.
