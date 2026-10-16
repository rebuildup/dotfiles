# Unified `agent` launcher (harness × provider routes from one TOML)

## Scope

`agent <harness> <provider>` starts exactly one installed AI harness with
exactly one API provider, chosen explicitly at launch:

```bash
agent list                                # configured routes
agent claude openrouter                   # Claude Code via OpenRouter
agent claude deepseek -- -p 'say ok'      # Claude Code via DeepSeek
agent claude minimax --model MiniMax-M2.5 -- <args>
agent opencode zen                        # OpenCode on the free zen models
agent opencode zen -- run "explain this repo"
agent pi deepseek -- -p 'hello'
agent dsh deepseek -- web                 # dsh keeps its own native auth
agent models deepseek                     # provider details + models
agent check                               # validate the config (CI runs this)
claude                                    # plain claude: official native auth
```

Design contract:

- **Thin**: read `config/agents.toml` → build a filtered process-scoped
  environment → `exec` the native CLI. No daemon, proxy, router or new
  dependency; credentials come from the existing `script/with-secrets`
  (Infisical) wrapper.
- **Declarative**: model ids, endpoints, credential names and route
  availability live only in `config/agents.toml`. Adding or changing them
  is a TOML edit; the launcher source contains adapter logic only.
- **Fail closed**: unknown harness, unknown provider, no route, unknown
  model, missing credential, missing harness binary → non-zero exit with a
  message that lists the supported choices. No implicit provider switch,
  no silent model fallback, no quota failover, no billing surprise.
- **Native by default**: plain `claude` is never wrapped, aliased or
  overridden by this repository (no shell function, no PATH shim).

Non-goals: per-combination mise tasks (the draft approach this replaces),
an implicit `claude()` override, cross-provider auth migration, and any
persistent write of a `--model` choice (`--model` affects one process).

## Usage

```
agent <harness> <provider> [--model <id>] [-- <harness args>...]
agent list | models <provider> | check | help
```

- Everything after `--` is passed to the harness verbatim
  (`agent claude openrouter -- --help` asks the harness for help;
  `agent claude openrouter --help` shows this launcher's help).
- Launcher-owned flags are rejected inside the passthrough: `--model`/`-m`,
  `--provider`, `--api-key`, `--fallback-model` (automatic model fallback is
  intentionally unsupported).
- Model resolution order: `--model` > route default > provider default >
  harness-native default. The last step only applies to passthrough
  harnesses (`dsh`), where model selection stays native; every other route
  must resolve a model before a process starts (config validation enforces
  this).
- `AGENT_MODEL` (the draft mise tasks' variable) is **not** read; a warning
  points at `--model`.

## Config: `config/agents.toml`

```toml
[defaults]
drop_env = ["ANTHROPIC_API_KEY", "..."]   # names that must never reach a child

[providers.deepseek]
label = "DeepSeek"
base_url = "https://api.deepseek.com/anthropic"  # Anthropic-compatible endpoint
secret = "DEEPSEEK_API_KEY"    # Infisical secret name (environment `dev`)
env = "DEEPSEEK_API_KEY"       # env var the harness reads (may differ)
default_model = "deepseek-flash"
models = ["deepseek-flash", "deepseek-v4-pro"]
# require_model = true         # fail closed: --model mandatory (MiniMax)
# opencode_id = "opencode"     # provider id when it differs from the key (zen)
# pi_id = "deepseek"           # pi --provider value (defaults to the key)

[harnesses.claude]
label = "Claude Code"
command = "claude"
adapter = "anthropic"          # anthropic | opencode | pi | passthrough
[harnesses.claude.env]         # adapter env names (names only, no values)
base_url = "ANTHROPIC_BASE_URL"
auth_token = "ANTHROPIC_AUTH_TOKEN"
api_key = "ANTHROPIC_API_KEY"  # always cleared for third-party endpoints
model = "ANTHROPIC_MODEL"
small_fast_model = "ANTHROPIC_SMALL_FAST_MODEL"
default_opus = "ANTHROPIC_DEFAULT_OPUS_MODEL"
default_sonnet = "ANTHROPIC_DEFAULT_SONNET_MODEL"
default_haiku = "ANTHROPIC_DEFAULT_HAIKU_MODEL"

[routes."claude.deepseek"]     # explicit harness × provider combinations
models = ["deepseek-flash"]    # optional route-level model list override
note = "..."                   # optional, shown by `agent list`
# default_model / require_model also override the provider defaults
```

Validation (`agent check`, run by CI) rejects: unknown adapter, route keys
that reference unknown harnesses/providers, missing defaults without
`require_model`, defaults that are not in the model list,
`require_model`-with-default contradictions, and `anthropic` routes whose
provider has no `base_url`.

## Adapters (native CLI contracts)

- **anthropic (Claude Code)**: exports `ANTHROPIC_BASE_URL`,
  `ANTHROPIC_AUTH_TOKEN` (derived from the provider credential),
  `ANTHROPIC_MODEL`, `ANTHROPIC_SMALL_FAST_MODEL` and all three
  `ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU}_MODEL` roles = the route model, and
  clears `ANTHROPIC_API_KEY`. Because every role maps to the single route
  model (subagents follow the haiku role), `CLAUDE_CODE_SUBAGENT_MODEL` is
  not needed and stays unset. Verified against claude 2.1.299.
- **opencode (OpenCode v2)**: model selection goes through the inline
  config override `OPENCODE_CONFIG_CONTENT={"model":"<provider>/<model>"}`
  (merged last over global/project config, so both `opencode` TUI and
  `opencode run` pick it up). The global `opencode --model` flag does not
  exist in v2 — it silently prints help — so it is never used.
- **pi**: `pi --provider <id> --model <id> ...` with the provider credential
  in its native env var. pi accepts ids outside its built-in catalog with a
  warning and passes them through (its catalog is shown by
  `pi --list-models`).
- **passthrough (dsh)**: argv only, plus the provider credential env;
  `--model` is rejected (dsh selects its model natively). dsh is not
  installed on the development machine and is explicitly unverified.

## Credential handling (no leakage, no argv secrets)

1. If the route's harness env already carries the credential, no secret is
   fetched at all (fast path, `script/with-secrets` is not invoked).
2. Otherwise the launcher re-executes itself *inside* the existing
   `script/with-secrets` (self-hosted Infisical project binding, environment
   `dev`), which injects the whole dev secret set.
3. The in-wrapper stage then filters the environment before `exec`:
   - variables injected by Infisical that the route did not select are
     dropped (baseline diff),
   - every credential name declared in the config (including legacy ones
     such as `MINIMAX_TOKEN_PLAN_KEY`) is dropped unless the route needs it,
   - `defaults.drop_env` names never reach the child,
   - only then are the adapter's `ANTHROPIC_*` values derived — secret
     values are referenced by *name* inside the child stage and are never
     placed in argv, files or logs.
4. Renames happen inside that stage too (e.g. Infisical
   `MINIMAX_M_PLAN_KEY` → harness `MINIMAX_API_KEY`).
5. A missing secret fails with its Infisical name before any harness starts.

The launcher's mock tests assert both directions: the selected credential
arrives, and every other provider's credential does not.

## Route matrix and verification status

| harness \ provider | zen | openrouter | deepseek | minimax |
| --- | --- | --- | --- | --- |
| claude | — (no Anthropic-compatible endpoint verified; zen free tier is client-bound: pi got `403 … only … within OpenCode`) | yes, default `z-ai/glm-5.3-flash` | yes, default `deepseek-flash` (route list: `deepseek-flash` only, because the endpoint silently remaps unknown names) | yes, `--model` required |
| opencode | yes, default `mimo-v2.6-flash-free` (free models; `opencode_id = "opencode"`) | yes | yes | yes, `--model` required |
| pi | — (free tier refused outside OpenCode) | yes | yes | yes, `--model` required |
| dsh | — | — | passthrough (native dsh auth, unverified) | — |

Not covered on purpose: `opencode`/`pi` on other providers, paid zen
models (add them to the TOML deliberately), and any automatic fallback
between models or providers.

Verification is reported in two tiers, matching issue #45's acceptance
criteria:

- **Mock/syntax**: `./script/test-agent` (19 cases: help/list/models,
  unknown harness/provider/model, `--model` precedence, secret filtering
  both ways, missing secret, forbidden passthrough flags, config
  validation failures) plus `agent check` and source compilation in CI.
- **Real machine E2E**: recorded in the PR/issue after running a cheap
  prompt per combination (`agent <harness> <provider> -- -p '…'`); combos
  run only in the mock tier stay marked unverified here.

## Installation and migration (replaces the draft mise tasks)

The draft PR #46 approach — ten per-combination global mise tasks in
`~/.config/mise/conf.d/agent-routes.toml` — is replaced by this launcher.
After review/merge:

```bash
cd ~/.dotfiles
git pull --ff-only
./script/link && ./script/check   # links home/.local/bin/agent
agent check && agent list
# if you used the draft tasks in a checkout: remove the old task file link
# (it is gone from home/) and re-run script/link / script/check
```

- `AGENT_MODEL=… mise run agent:…` → `agent <harness> <provider> --model …`.
- `script/agent/mimo` and `script/agent/minimax` stay as explicit,
  provider-tuned wrappers (ADR-0008) and are not touched here.
- pc-setup's NixOS shell init no longer defines a `claude()` override
  (issue #104); project-init profiles describe the launcher instead of mise
  tasks (issue #100).

Rollback: revert the dotfiles branch (or stop linking `home/.local/bin/agent`);
nothing in native CLI config, provider accounts, billing or shell rc files is
modified by the launcher itself. `config/agent-init.bash` only carries
comments, so rollback needs no shell surgery beyond what that file documents.

## Secrets

Names only, all already registered in the Infisical `dev` environment of
project `d4c2fc09-a923-4a38-9cf4-b51769aadb76` (no new secrets are created):

- `OPENROUTER_API_KEY`, `DEEPSEEK_API_KEY`, `OPENCODE_API_KEY`,
  `MINIMAX_M_PLAN_KEY` (harness env `MINIMAX_API_KEY`).
- Legacy/untouched names that are deliberately filtered out of every child:
  `MINIMAX_TOKEN_PLAN_KEY`, `MIMO_API_KEY`, `ANTHROPIC_AUTH_TOKEN`.

## Tests

```bash
./script/agent-launcher check   # config validation
./script/test-agent             # mock harness + mock Infisical wrapper
./script/test && ./script/check-secrets
```

CI runs the config validation and `./script/test-agent` on every pull
request; real prompt runs remain a manual, per-combination step.
