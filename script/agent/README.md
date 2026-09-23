# Provider-specific runtime entrypoints

This directory hosts provider-specific shell entrypoints. They are the
only place where a specific AI provider's URL, model, or compatibility
flag is set.

The pattern is intentional and is anchored in `docs/adr/0008` (keep
Claude common configuration provider-neutral; isolate MiniMax as a
transitional / legacy provider).

## What goes here

One executable file per provider, named after the provider id:

- `minimax` — transitional / legacy provider. Active until retirement.
- `mimo` — placeholder for the future provider. Only added when MiMo
  adoption begins; never before.

A provider entrypoint:

1. Sets the provider URL, model names, and compatibility flags as
   process-scoped `env` values.
2. Execs the dotfiles `script/with-secrets` wrapper so that secrets are
   injected from the self-hosted Infisical project.
3. Forwards the rest of the argv to the wrapped command.

## What does NOT go here

- Login-shell global exports. The `~/.bashrc`-level exports belong in
  the user's host, not in this repository.
- Provider-specific Claude Code values that masquerade as `ANTHROPIC_*`
  canonical names. If a downstream consumer expects `ANTHROPIC_AUTH_TOKEN`,
  the wrapper sets it for the provider from a `MINIMAX_*` (or equivalent)
  source. The fact that this happens here, not in the common layer, is
  the whole point of `docs/adr/0008`.
- Plaintext secrets. All secrets are sourced from Infisical via
  `script/with-secrets`.

## Why per-provider wrappers and not a single switcher

A single switcher would still require the common layer to know about
every possible provider, which would re-create the coupling this ADR
deliberately removes.

Per-provider wrappers keep the common layer truly provider-neutral, at
the cost of one extra shell entrypoint per provider.

## Migration to a future provider

When a future provider needs to be added, the only required change is
adding a new entrypoint in this directory. The Claude common
configuration in `home/` and the `agents/claude` submodule remain
untouched.
