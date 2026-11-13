# Blocked-provider root cause investigation — 2026-11-13

Follow-up to [free-provider-evaluation-2026-11-13](free-provider-evaluation-2026-11-13.md)
and [ADR-0018](../adr/ADR-0018.md). The first round recorded three providers as
"blocked" with only the status code. This round identifies the actual cause for
each, so the launcher reports a real reason and an operator knows exactly which
action (if any) would unblock it.

**No credentials were printed. No request was sent to a model that bills per
token.** Every probe below targets either an unauthenticated/documented
free endpoint or a 1–4 token completion.

## Summary

| Provider | Status | Root cause | Fixable by us? |
| --- | --- | --- | --- |
| ModelScope | **blocked, cause identified** | ModelScope account is not bound to an Alibaba Cloud account (real-name verified). Token itself is valid. | No — one-time browser action by the account owner |
| SenseNova | **blocked, cause identified** | Token is not accepted by either Token Plan host. Both hosts reject a *bogus* key identically, and the CN host answers `Forbidden` for every presented token, so the key is never matched to a workspace. | No — key/workspace mismatch must be resolved in the console |
| SiliconFlow | **blocked, cause identified** | Key is valid on the international host only; free models there return `402 balance insufficient` / `403 Model disabled`. Free tier also requires real-name verification (enforced platform-wide since 2026-05-15). | No — account eligibility |

All three remain **unrouted**. Nothing here changes the seven working routes.

## 1. ModelScope — account not bound to Alibaba Cloud

### What was previously recorded
`401 Authentication failed, please make sure that a valid ModelScope token is
supplied.` on every request shape, and a 200 on `/v1/models` which was read as
"the token authenticates for catalog but not inference".

### What that 200 actually meant
`GET /v1/models` is **fully public**. Measured:

| request | status |
| --- | --- |
| `/v1/models` with **no** `Authorization` header | 200 |
| `/v1/models` with a **deliberately bogus** token | 200 |
| `/v1/models` with our token | 200 |

So the catalog response proves nothing about the token, and the earlier
"authenticates for catalog but not inference" reading was wrong.

### The decisive test
The international host `api-inference.modelscope.ai` returns the *real* reason
instead of the generic one, and its answer differs from a bogus key:

| request on `api-inference.modelscope.ai` | status | message |
| --- | --- | --- |
| **our** token, chat | 401 | `Please bind your Alibaba Cloud account before use. You can bind it at: https://modelscope.ai/my/settings/account` |
| **bogus** token (`ms-aaaa…`), chat | 401 | `Authentication failed, please make sure that a valid ModelScope token is supplied.` |
| **no** auth header, chat | 401 | `Authentication failed, …` |
| our token, **nonexistent model** | 401 | `Please bind your Alibaba Cloud account before use. …` |

Three repetitions of the first row gave the same message. Two conclusions:

1. **The token is valid and recognised** — a garbage token gets a different
   error, so our token is being resolved to an account.
2. **The binding check runs before model/quota checks** — even a nonexistent
   model returns the binding error, so nothing else can be diagnosed until the
   binding is done.

The China host (`api-inference.modelscope.cn`) masks the same condition as the
generic `Authentication failed`, which is why the first round could not
distinguish them.

### Corroborating official documentation
ModelScope's free API-Inference runs on Alibaba Cloud resources and requires the
ModelScope account to be bound to an Alibaba Cloud account that has completed
real-name verification; the international site cannot perform the binding, so
the `.cn` site must be used. The `ms-` token prefix is unrelated (a widely
reported "strip the `ms-` prefix" workaround for a *different* client bug); we
tested both the stored token and the prefix-stripped form, and both 401 on the
CN host, so the prefix is not our problem.

### Action required (human, one-time)
- Open `https://modelscope.cn/my/settings/account` (China site — the
  international site cannot bind) while signed in as the token's owner.
- Bind an Alibaba Cloud account that has completed real-name verification.
- Then re-run the probe below; a successful binding should replace the 401 with
  a normal completion.

Verification command (does not print the token):

```bash
cd ~/.dotfiles && ./script/with-secrets bash -c '
  curl -sS -m 30 -H "Authorization: Bearer $MODELSCOPE_API_KEY" \
    -H "Content-Type: application/json" \
    -X POST https://api-inference.modelscope.cn/v1/chat/completions \
    -d "{\"model\":\"Qwen/Qwen3-Coder-30B-A3B-Instruct\",\"messages\":[{\"role\":\"user\",\"content\":\"say OK\"}],\"max_tokens\":16}"'
```

## 2. SenseNova — token not matched to a Token Plan workspace

### Documented endpoints (both tested)
The official docs name **two** base URLs, and both were tested:

- `https://token.sensenova.cn/v1` — `platform.sensenova.cn` / 日日新 Token Plan
- `https://token.sensetime.com/api/v1` — SenseTime TokenPlan docs
  (`/docs/guides/account/quick-access`)

`https://api.sensenova.cn/v1` is **retired** in the current docs (the old
address "已迁移到 `token.sensenova.cn`"), and it answered `404 no Route matched`
in the first round, which is consistent with retirement rather than a wrong
path.

### What each host says

| host | our key | bogus key | no auth |
| --- | --- | --- | --- |
| `token.sensenova.cn/v1` | 401 `{"error":{"code":16,"message":"Forbidden"}}` | 401 `code 16 Forbidden` (identical) | 401 `code 16 Authorization Not Found` |
| `token.sensetime.com/api/v1` | 401 `authentication_error: incorrect API key provided` | 401 identical | 401 `invalid authorization` |

Both hosts distinguish "no credential supplied" from "credential supplied", but
**neither distinguishes our key from a garbage key**. That means the key value
is never matched to a workspace: the credential is rejected before lookup, not
because of an entitlement, quota, model or region decision on a found account.

Additional negatives that rule out the cheap explanations:

- The key is clean: 35 chars, `sk-` prefix, ASCII, no whitespace, no trailing
  newline, `[A-Za-z0-9_-]` only. So "incorrect API key" is not a copy-paste
  artefact.
- Every auth-header shape was tried on the CN host — `Authorization: <key>`,
  `Authorization: Bearer <key>`, `x-api-key`, `api-key`, `X-Access-Token`. Only
  the shapes carrying a value produce `code 16 Forbidden`; the two that the
  host does not read produce `Authorization Not Found`. So the host *reads* the
  header but rejects the value.
- The CN host is reachable and its router works: a random path returns
  `404 {"code":5,"message":"NOT_FOUND"}`, not a WAF page. Requests were sent
  with a browser user agent because the docs warn a bare `curl` can be 403'd.
- Model choice is irrelevant: `sensenova-6.8-flash-lite`, `sensenova-6.8-flash`
  and `deepseek-v4-flash` all return the same rejection.

### Conclusion
The stored `SENSENOVA_API_KEY` is not a Token Plan key for either documented
host. The two hosts are separate products (`platform.sensenova.cn` /
日日新 vs `token.sensetime.com` / SenseTime TokenPlan), each issuing its own
workspace keys, and a key from one is rejected by the other — which matches the
observed "value not matched" behaviour exactly.

Per the instruction not to send a key to an unrelated service unconditionally,
no further hosts were tried. In particular `api.sensenova.cn` (retired) and
third-party gateways were **not** given the key.

### Action required (human)
1. Sign in to `https://platform.sensenova.cn` (日日新) with the phone number
   used for registration, open **API Keys**, and confirm a key exists under the
   **Free** (公测) plan. If the console shows the Free plan is not active, that
   is the blocker.
2. If that console has no key, the stored value came from a different product:
   either issue a new key there, or obtain one from
   `https://token.sensetime.com` if that is the intended TokenPlan account.
3. Re-run with the same command shape as ModelScope, substituting
   `https://token.sensenova.cn/v1` and `sensenova-6.8-flash-lite`.

Free-tier context from the official pages (for planning, not a guarantee): a
Free public-beta plan at 0元/月 with a rolling window of about 1,500
requests/5h per model, dual credit pools, and a documented free quota for
`sensenova-u1.5-lite` (1,500 requests/5h). Policies are explicitly subject to
change during the beta.

## 3. SiliconFlow — key valid on the international host only; no free model served

### Two separate account systems
| host | `GET /v1/models` with our key |
| --- | --- |
| `api.siliconflow.com` (international) | **200**, 80 models |
| `api.siliconflow.cn` (China) | 401 `code 30014 Token is invalid.` |

`.cn` rejects the key for *every* path (`/v1/models`, `/v1/user/info`), i.e. the
key belongs to the `.com` account system. The two sites are separate
datastores; a `.com` key is not valid on `.cn`. (The vendor's own guidance is
that both base URLs accept the same key, which does not hold for this key, so
this is an account-region mismatch rather than a documentation error we can fix
from here.)

### Free-model test (paid models never contacted)
The official free list is published per model ID on the pricing/docs pages
(currently GLM-4-9B-0414, GLM-Z1-9B-0414, Qwen3-8B, Qwen2.5-7B-Instruct,
Hunyuan-MT-7B, Xing4.0-29B, DeepSeek-R1-0528-Qwen3-8B, plus embeddings, ASR and
Kolors). Each of the *chat* IDs was probed with `max_tokens: 4`:

| model id | `.com` catalog | `.com` chat |
| --- | --- | --- |
| `Qwen/Qwen3-8B` | present | 402 `balance insufficient` |
| `Qwen/Qwen2.5-7B-Instruct` | present | 402 `balance insufficient` |
| `THUDM/GLM-4-9B-0414` | absent | 403 `Model disabled.` |
| `THUDM/GLM-Z1-9B-0414` | absent | 403 `Model disabled.` |
| `tencent/Hunyuan-MT-7B` | absent | 403 `Model disabled.` |
| `XingChenAGI/Xing4.0-29B` | absent | 400 `Model does not exist.` |
| `deepseek-ai/DeepSeek-R1-0528-Qwen3-8B` | absent | 400 `Model does not exist.` |

Interpretation:

- The two IDs the international catalog actually exposes answer **402**, i.e.
  the request is understood and the *account* lacks the credit/free allowance.
  SiliconFlow requires real-name verification before free models can be used
  (platform-wide since 2026-05-15), and free models are billed at 0 within a
  fixed rate limit; a 402 on a nominally free ID is the account-eligibility
  signal, not a model or auth failure.
- `Model disabled` (403) is the vendor's own status for an ID withdrawn from
  service on that host — several free IDs are CN-only or have been retired
  since the snapshot (e.g. `zai-org/GLM-5.3-Flash` was removed on 2026-10-28).
- `Model does not exist` (400) is simply "not on this host".

The first round's conclusion ("402/403 → exclude every model") was directionally
right for *this account* but was based on paid IDs. Re-testing only the
officially free IDs gives the precise picture above: no free chat model is
servable on this account today.

### Action required (human)
- Complete **real-name (identity) verification** in the SiliconFlow console, and
  confirm the account is not flagged. Until then free models answer 402.
- If the account is intended to be the China site, issue a key at
  `https://cloud.siliconflow.cn/me/account/ak` and store it under a **separate**
  Infisical name — a `.cn` key and a `.com` key are not interchangeable, and
  overwriting `SILICONFLOW_API_KEY` would silently break whichever host was
  working.

## 4. Groq + OpenCode: why no route can be added

Previously recorded as "8k TPM is the binding limit". Re-measured per model:

| model | `x-ratelimit-limit-tokens` | `x-ratelimit-limit-requests` |
| --- | --- | --- |
| `openai/gpt-oss-120b` | 8000 | 1000 |
| `openai/gpt-oss-20b` | 8000 | 1000 |
| `qwen/qwen3.8-27b` | 8000 | 1000 |

**Every** free chat model has TPM = 8000, so this is not a model-selection
problem: no choice makes an OpenCode turn fit. OpenCode's system prompt plus tool
definitions alone request ~9.9k–10.7k tokens, and it was rejected with
`429 ... tokens per minute (TPM): Limit 8000` at output budgets 512, 1024, 2048
and 4096. OMP's smaller prompt stays under the budget and completes real tasks
(320 s), so `omp.groq` remains the only Groq route.

This is recorded as a per-model `discouraged_reason`
(`catalog.providers.groq.models."openai/gpt-oss-120b"`) rather than a
provider-wide restriction: Groq *is* usable, just not from OpenCode, and a
provider-level restriction would have removed the working OMP route.

## 5. OMP and Requesty / OVHcloud

`omp models --json` exposes providers `apple, deepseek, groq, kilo, mistral,
opencode-go, opencode-zen, openrouter, siliconflow` (728 kilo models, 623
openrouter). **Neither `requesty` nor `ovhcloud` is a native OMP provider.**

OMP documents a supported way to declare a custom OpenAI-compatible provider in
`~/.omp/agent/models.yml` (`providers.<id>.{baseUrl, api, apiKey, models}`), so
technically both *could* be added. They are deliberately not, and this is an
architectural decision rather than a limitation of OMP:

- `config/agents.toml` is the single canonical provider/route/credential catalog
  (ADR-0015). Writing endpoint overrides into `~/.omp/agent/models.yml` would
  create a second, machine-local catalog outside review, and the launcher's
  existing OMP credential guard *rejects* `models.yml` provider overrides for
  exactly this reason.
- Requesty and OVHcloud are already reachable from OpenCode, and OVHcloud has a
  2 req/min anonymous budget that no agentic turn can survive. Adding an OMP
  route would provide no capacity the portfolio does not already have.
- Consequently no `omp.requesty` / `omp.ovhcloud` route exists, and the `omp`
  continuity profiles only name `omp.kilo` and `omp.groq`. This is documented in
  ADR-0018 §5 and enforced by `agent check` (a provider declaring
  `opencode_npm` must be reachable from an opencode route).

If OMP custom providers are ever wanted, the correct change is a reviewed
launcher feature that *generates* the block from `agents.toml` (as the OpenCode
adapter already does), not a hand-written `models.yml`.

## 6. Net effect on the launcher

- **No route added or removed.** The seven working routes and their measured
  roles are unchanged; the three blocked providers stay unrouted.
- The Groq/OpenCode ceiling is now recorded as a per-model
  `discouraged_reason`, and `agent routes` reports it.
- The continuity profiles were re-checked after the resolver hardening:
  `free-go-to-kilo` → `omp.kilo`, `omp.groq`; `free-kilo-quota` → `omp.groq`;
  `opencode-requesty-quota` → `opencode.kilo`.
- Nothing here requires a machine-local credential change; all three blocked
  items need an account action by the owner.
