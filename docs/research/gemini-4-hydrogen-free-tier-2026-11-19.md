# Gemini 4 Hydrogen Free Tier candidate — 2026-11-19

Status: **not adopted**. A shared practical coding-agent benchmark shows a
stronger aggregate score for Hydrogen than MiniMax M3, but public evidence does
not yet verify every requested task dimension or the exact route configuration.
The candidate remains blocked by those performance evidence gaps and by the
unverified billing state of the project behind the existing API key. Tracking issue:
[#185](https://github.com/rebuildup/dotfiles/issues/185).

No Gemini route was added. This follows
[ADR-0018](../adr/ADR-0018.md): a stored key and provider price statement do
not prove that this account is entitled to a $0 route; an unproven candidate
must remain unreachable.

## Infisical and key handling

The existing `script/with-secrets.ps1` wrapper resolved the repository's
self-hosted Infisical binding and injected the `dev` environment. It confirmed
that `GEMINI_API_KEY` is present without printing its value. The key was used
transiently only with Google's API Keys `lookupKey` endpoint to identify its
owning project resource; no Gemini generation or agent request was made.

The active Google Cloud identity could not read that project's metadata
(Cloud Resource Manager returned HTTP 403). The AI Studio Projects page
redirected to sign-in, so no account interaction was attempted. Consequently
the project's billing account, AI Studio tier, prepay state, and dedicated
purpose are **unknown**. The API key's presence in Infisical is not billing
evidence. No key, project number, or account identifier is recorded here.

Google's current Gemini API documentation says Free Tier input and output for
Hydrogen are free of charge. It also explains that Free Tier access is limited
to eligible models and project rate limits, while linking a billing account
moves a project to a paid tier. That documents the product's pricing model;
it does not establish the tier of the project behind this key. See the
[Hydrogen pricing table](https://ai.google.dev/gemini-api/docs/pricing#gemini-4-hydrogen),
[billing guide](https://ai.google.dev/gemini-api/docs/billing), and
[rate-limit guide](https://ai.google.dev/gemini-api/docs/rate-limits).

## Model and performance evidence

The Google model page identifies the exact API id as `gemini-4-hydrogen`,
lists function calling as supported, and describes coding and agentic
workflows as intended use. See the
[Gemini 4 Hydrogen model page](https://ai.google.dev/gemini-api/docs/models/gemini-4-hydrogen).

Artificial Analysis independently evaluates both models on FrontierCode-AA
2.0:

| Model | Benchmark | Result | Evaluation |
| --- | --- | ---: | --- |
| Gemini 4 Hydrogen (xhigh) | FrontierCode-AA 2.0 | 39.0% | Same benchmark and agent harness |
| MiniMax-M3 | FrontierCode-AA 2.0 | 21.9% | Same benchmark and agent harness |

The benchmark uses 132 tasks in real open-source repositories. Each task runs
three times in the Stirrup agent harness, capped at 500 turns; held-out tests
and a rubric assess whether the change is mergeable. The harness permits shell
commands to continue in the background so an agent can check them later. This
is strong aggregate evidence for practical coding-agent performance, and
Hydrogen is 17.1 percentage points above M3 in this comparison. However, the
task set is private and its public results do not break out coverage or scores
for multi-file changes, codebase understanding, tool use, debugging, test
repair, or sustained execution. The benchmark description supports real
repository changes, tool use, and continued execution; it does not establish
that every requested task dimension is represented or independently passed.
The public score therefore does not by itself close the full performance
acceptance gate.

The 39.0% result is specifically for Hydrogen at `xhigh`. Google's model
documentation lists `xhigh` as a supported Hydrogen thinking level. Any route
must explicitly use `xhigh`; if the selected API interface or adapter cannot
set it, performance must be re-evaluated at the exact supported configuration
before adoption. See the
[Gemini 4 Hydrogen model documentation](https://ai.google.dev/gemini-api/docs/models/gemini-4-hydrogen).

The results were checked on 2026-11-19 in Artificial Analysis's
[FrontierCode-AA 2.0 results and methodology](https://artificialanalysis.ai/evaluations/frontiercode-2-0).
The shared result supports an aggregate M3-or-better finding, but the task
dimension coverage and exact route setting remain unverified. The task examples
and public methodology do not provide a complete subtype inventory.

Google DeepMind's November 2026 model card reports:

| Model | Benchmark | Result | Limitation |
| --- | --- | ---: | --- |
| Gemini 4 Hydrogen | SWE-sweep | 13.5% | Not SWE-bench Pro or Verified |
| Gemini 4 Hydrogen | Terminal-Bench 4.1, cheating-adjusted | 57.0% | Different benchmark version from MiniMax's published result |
| MiniMax M3 | SWE-Bench Pro | 59.0% | Provider-published result |
| MiniMax M3 | Terminal-Bench 2.1 | 66.0% | Provider-published result; version differs from Hydrogen's 4.1 result |

Sources: [Google DeepMind model card](https://deepmind.google/models/model-cards/gemini-4-hydrogen/)
and [MiniMax M3 research report](https://www.minimax.io/blog/minimax-m3).

Google's SWE-sweep and Terminal-Bench 4.1 figures are not directly comparable
to MiniMax's published SWE-Bench Pro and Terminal-Bench 2.1 results because
the task sets and versions differ. FrontierCode-AA 2.0 supplies a matching
aggregate real-agent comparison, but does not close the requested task-dimension
coverage gate. No Gemini API inference was run because the key's Free Tier
project and no-billing state could not be verified first.

## Decision and re-evaluation gate

- Keep the existing provider/model routes and fallback behavior unchanged.
- Do not add `gemini-4-hydrogen` to `config/agents.toml` or expose a Gemini
  route until authoritative Google project/billing information verifies that
  the key's project is dedicated to Gemini API Free Tier use, has no linked
  Cloud Billing account, and has no Prepay.
- The shared FrontierCode-AA 2.0 result supports aggregate performance above
  M3, but before implementation the evidence must map the requested task
  dimensions to covered tasks or add a same-harness comparison that evaluates
  multi-file changes, codebase understanding, tool calls, debugging, test
  repair, and sustained agent execution. The route must explicitly use the
  evaluated `xhigh` thinking level, or be re-evaluated at the exact route
  configuration. Do not make live API requests before billing proof.
- Once the billing and performance gates pass, implement the route and add
  local contract coverage for Infisical retrieval, health/probe, auth/quota
  failures, and fail-closed behavior.
- Any eventual route must use only `gemini-4-hydrogen`, the existing
  process-scoped Infisical integration, explicit opt-in, and the current
  fail-closed behavior for authentication and 429/quota exhaustion. It must
  never retry indefinitely or cross into paid routes.

Until billing is verified, the candidate remains unconfigured and safe.
