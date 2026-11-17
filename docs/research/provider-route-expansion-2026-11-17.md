# Provider route expansion probe — 2026-11-17

Live measurements behind the `claude.logfare` route and the audit of which
other provider × harness combinations can or cannot exist. Policy context:
[ADR-0018](../adr/ADR-0018.md) (explicit opt-in only, no implicit fallback,
a route that cannot be proven must not be reachable).

## Added: `claude.logfare`

Logfare serves an Anthropic-protocol surface at the same origin as its
OpenAI-compatible API, so the provider now carries two endpoint spellings:

- `base_url = "https://logfare.ai"` — the Anthropic adapter appends
  `/v1/messages` itself (`https://logfare.ai/v1/messages`);
- `opencode_base_url = "https://logfare.ai/v1"` — the OpenCode custom
  provider (`opencode_npm = "@ai-sdk/openai-compatible"`) keeps the `/v1`
  spelling it already used.

Measured 2026-11-17 (LOGFARE_API_KEY from Infisical `dev`, claude 2.1.325,
opencode 2.3.0):

- `POST https://logfare.ai/v1/messages` with `authorization: Bearer` and
  `anthropic-version: 2023-06-01` returns a well-formed Anthropic `message`
  object (verified for `deepseek-v4.1-flash-1017`).
- `agent claude logfare -- -p ...` produced a real response, and with
  `--dangerously-skip-permissions` a real file-creation tool call
  (`probe.txt` written) on **both** `deepseek-v4.1-flash-1017` and
  `glm-5.3`.
- `agent opencode logfare -- run ...` still answers after the endpoint
  split (the OpenCode block now uses `opencode_base_url`).

The account-wide budget is unchanged and shared with `opencode.logfare`:
40 req/min, 1,000 req/hour, 5,000 req/day, 6 concurrent (new accounts
10/min, 200/hour, 500/day, 2 concurrent for the first 24h). Both models
remain premium: the `/consent` training opt-in and Discord membership are
still required or every request returns 403.

Claude Code prints an `unrecognized_model` notice for both Logfare ids and
assumes a 1M-token window; `glm-5.3` is actually enforced at 262,144 by
Logfare (413 beyond that), so very large prompts on `glm-5.3` can still be
rejected upstream. This is a client-side display assumption, not a route
defect; the same notice appears on other non-Anthropic model ids.

## Probe fix that came with it

`script/agent/probe.ts` `wireFor` previously returned the OpenAI wire for
ANY route whose provider declared `opencode_npm`, and `buildRequest` always
used `base_url`. For a dual-surface provider that meant a claude route
would have been probed with OpenAI wire format against the Anthropic
spelling (and vice versa for gateways whose OpenAI surface lives under a
different `opencode_base_url`). The wire now follows the harness adapter
(`anthropic` → `<base_url>/v1/messages`, `opencode` + `opencode_npm` →
`<opencode_base_url ?? base_url>/chat/completions`), which also corrects
live probes for the existing `claude.kilo` / `claude.requesty` routes.

## Audited and deliberately NOT added

| combination | verdict | evidence (2026-11-17) |
|---|---|---|
| `omp.logfare` | impossible | OMP has no native `logfare` provider id; a local `models.yml` endpoint override is outside the launcher design (same reason `omp.requesty` / `omp.ovhcloud` do not exist). |
| `claude.mistral` | impossible | `POST https://api.mistral.ai/v1/messages` returns 404 "Not found" for every configured model id, with both `authorization: Bearer` and `x-api-key`. Mistral has no Anthropic-protocol surface. |
| `opencode.opencode-go` | unverifiable → not added | OpenCode 2.3.0 knows `opencode-go/*` natively, but `opencode run --model opencode-go/deepseek-v4.1-flash` and `opencode-go/mimo-v2.6-flash` both fail with "Insufficient balance" against the workspace billing endpoint — the client path does not demonstrably draw the Go subscription allowance with `OPENCODE_API_KEY`. A route that cannot be proven must not be reachable. |
| `claude.groq` / `opencode.groq` | impossible | `POST https://api.groq.com/openai/v1/messages` → 404 (OpenAI-compatible only); the opencode route stays absent because Groq's 8k tokens/min free budget rejects every real OpenCode turn (see free-provider-evaluation-2026-11-13). |
| `claude.ovhcloud` / `omp.ovhcloud` | impossible | OpenAI-compatible only (`/v1/messages` → 404) and `anonymous = true`; the Anthropic adapter requires a credential and OMP has no credential-free contract. Already documented in `docs/agent-launcher.md`. |
| `claude.zen` / `omp.zen` | impossible | Zen free tier is client-bound: it answers only inside OpenCode clients (403 elsewhere, verified earlier). |
| `omp.requesty` | impossible | OMP has no native `requesty` provider id; `models.yml` overrides are disallowed. Already documented. |
| `dsh.*` / `vibe.*` beyond current | impossible | Both harnesses use the `passthrough` adapter: no provider injection exists by design; they keep their own native auth. |

Providers already at full claude/opencode/omp coverage: `openrouter`,
`openrouter-free`, `deepseek`, `minimax`, `kilo`.
