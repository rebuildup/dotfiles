# Provider-specific runtime entrypoints

This directory hosts provider-specific shell entrypoints. They are the only
place where a specific AI provider's URL, model, or Anthropic-compatible
alias is set.

## What goes here

One executable file per provider, named after the provider id:

- `mimo` — Xiaomi MiMo via the Anthropic Compatibility Protocol.
- `claude-mimo` — convenience launcher for Claude Code through `mimo`.

A provider entrypoint:

1. Sets the provider URL and model names as process-scoped `env` values.
   Claude Code's native slots map as: default / Sonnet / Haiku →
   `mimo-v2.6-flash` (common), Opus → `mimo-v2.6-pro[1m]` (upper tier,
   1M context window).
2. Execs the dotfiles `script/with-secrets` wrapper so secrets are injected
   from the self-hosted Infisical project.
3. Converts the provider-specific secret name (for example `MIMO_API_KEY`)
   into the Anthropic-shaped alias Claude Code expects
   (`ANTHROPIC_AUTH_TOKEN`) only inside that child process.
4. Forwards the rest of the argv to the wrapped command.

## What does NOT go here

- Login-shell global exports of provider URL / model / credential flags.
- Provider-specific values written into `home/`, `home/.config/`, or
  `~/.bashrc`.
- Plaintext secrets. Secret values stay in Infisical and are read through
  `script/with-secrets` at process start.

## Invocation

```bash
script/agent/mimo              # defaults to claude
script/agent/mimo claude -p 'hello'
script/agent/claude-mimo --version
```
