# Gemini 4 Hydrogen Free Tier candidate — 2026-11-19

Status: **not adopted**. The candidate remains blocked by two required but
unverified conditions: the billing state of the project behind the existing
API key, and practical coding-agent performance at least equal to MiniMax M3.
Tracking issue: [#185](https://github.com/rebuildup/dotfiles/issues/185).

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
workflows as intended use. That establishes the public model surface, not
performance parity with MiniMax M3. See the
[Gemini 4 Hydrogen model page](https://ai.google.dev/gemini-api/docs/models/gemini-4-hydrogen).

Google DeepMind's November 2026 model card reports:

| Model | Benchmark | Result | Limitation |
| --- | --- | ---: | --- |
| Gemini 4 Hydrogen | SWE-sweep | 13.5% | Not SWE-bench Pro or Verified |
| Gemini 4 Hydrogen | Terminal-Bench 4.1, cheating-adjusted | 57.0% | Different benchmark version from MiniMax's published result |
| MiniMax M3 | SWE-Bench Pro | 59.0% | Provider-published result |
| MiniMax M3 | Terminal-Bench 2.1 | 66.0% | Provider-published result; version differs from Hydrogen's 4.1 result |

Sources: [Google DeepMind model card](https://deepmind.google/models/model-cards/gemini-4-hydrogen/)
and [MiniMax M3 research report](https://www.minimax.io/blog/minimax-m3).

These results do not establish that Hydrogen is below M3, because the
Terminal-Bench versions and SWE task sets are different. They also do not
establish that Hydrogen is equal or better: there is no matching SWE-Bench
Pro/Verified result or same-version Terminal-Bench comparison in the reviewed
official evidence. No same-harness real-agent evaluation was run because the
key's Free Tier project and no-billing state could not be verified first.

## Decision and re-evaluation gate

- Keep the existing provider/model routes and fallback behavior unchanged.
- Do not add `gemini-4-hydrogen` to `config/agents.toml` or expose a Gemini
  route until the project is authoritatively verified as dedicated to this
  Gemini API use, Free Tier, and unlinked to Cloud Billing / Prepay.
- After that verification, compare Hydrogen against MiniMax M3 or stronger
  with the same real harness and task set covering multi-file changes,
  repository understanding, tool calls, debugging, test repair, and continued
  agent execution. Record the baseline, task protocol, model ids, and outcomes.
- Any eventual route must use only `gemini-4-hydrogen`, the existing
  process-scoped Infisical integration, explicit opt-in, and the current
  fail-closed behavior for authentication and 429/quota exhaustion. It must
  never retry indefinitely or cross into paid routes.

Until both gates pass, the candidate remains unconfigured and safe.
