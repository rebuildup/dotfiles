# Agent API profiles with mise + Infisical (no custom router)

## Scope

The standard `claude` command invokes native Claude Code and its official login. `claude` is not a function or alias in the managed dotfiles. User API subscriptions are **opt-in** through mise global tasks. No separate `agent` executable, dynamic dispatch service, proxy, or quota-based fallback is installed.

Global tasks are declared in `home/.config/mise/conf.d/agent-routes.toml`, symlinked into `~/.config/mise/conf.d/` by the existing `script/link`. The default mise global configuration remains owned by `pc-setup`. Mise loads global tasks from any current project and `dir = "{{ cwd }}"` preserves the launch directory. <https://mise.jdx.dev/tasks/task-discovery.html>

```bash
claude                                     # official Claude auth, unchanged
mise run agent:claude:openrouter
mise run agent:claude:deepseek
AGENT_MODEL=<available-preview-model> mise run agent:claude:minimax

mise run agent:pi:openrouter
mise run agent:pi:deepseek
AGENT_MODEL=<available-preview-model> mise run agent:pi:minimax

mise run agent:opencode:openrouter
mise run agent:opencode:deepseek
AGENT_MODEL=<available-preview-model> mise run agent:opencode:minimax

mise run agent:dsh:deepseek
```

Set `AGENT_MODEL` per invocation to override the displayed default model. MiniMax tasks deliberately demand an explicit model: a preview name on the provider website does not prove that a particular account/CLI can use it. The provider catalog and subscription entitlement must be verified on the actual machine.

## Installation

Once branch changes are reviewed and merged:

```bash
cd ~/.dotfiles
git pull --ff-only
./script/link
./script/check
mise tasks --global
```

To activate a branch before merge, check it out explicitly first. `script/link` will refuse an existing unmanaged destination; inspect any conflict instead of deleting it.

In a **new** interactive shell, `type -a claude` should show the installed Claude Code CLI and no dotfiles-defined `claude` function. If old configuration already defined one, restart the shell, or use `unset -f claude` temporarily. Any additional machine-local alias/function or local `claude-sub` definition must be reviewed separately.

## Credential scope

Each API task starts `~/.dotfiles/script/with-secrets`, which uses the existing self-hosted Infisical binding. Required names:

- OpenRouter: `OPENROUTER_API_KEY`
- DeepSeek: `DEEPSEEK_API_KEY`
- MiniMax plan: `MINIMAX_TOKEN_PLAN_KEY`

A missing key exits before the model is called. No new secrets, API keys, aliases, or Infisical projects are provisioned by this migration.

**Security limitation:** the existing `with-secrets` injects every secret in the dotfiles `dev` environment into the task process. The mise tasks do not isolate those secret values from trusted local harnesses, and harness-native auth files can override the injected key. For untrusted agent workers, use a scoped Infisical identity/project or an isolated runtime; do not treat a task choice as a least-privilege boundary. Inspect Pi/OpenCode login priority and DSH settings/credential precedence before charging an account.

## Rollback and verification

To restore the old launch behavior, revert the dotfiles branch (or unlink the managed global task TOML and run `script/check` to see the expected drift). This migration does not modify native CLI sessions, provider accounts, billing caps, or existing provider scripts.

```bash
mise tasks --global
bash -n ~/.dotfiles/config/agent-init.bash
./script/check
./script/check-secrets
```

CI only parses the mise TOML and checks shell syntax. A small real prompt under each selected account is still required to validate that the installed model catalog, subscription entitlement and endpoint routing work as intended. No implicit fallback to a paid API is performed.
