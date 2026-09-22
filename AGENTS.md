# Agent Contract

This repository manages personal CLI configuration. Keep the contract short and preserve these project-local invariants:

- `dotfiles` owns user-level CLI configuration; `pc-setup` owns software installation, OS setup, and machine provisioning.
- `home/` mirrors `$HOME`. Managed files are linked individually rather than copying configuration into place.
- `script/link` must remain idempotent and non-destructive. Never silently replace an unmanaged file, directory, or foreign symlink.
- Secrets, credentials, tokens, private keys, and machine-specific identity values must not be committed. Prefer tool-native local include/override mechanisms.
- Keep configuration minimal. Do not add aliases, defaults, dependencies, abstractions, platform branches, or helper tooling without an observed need.
- Durable architecture or workflow decisions belong in `docs/adr/`; supporting external research belongs in `docs/research/`.
- Before presenting a change as ready, run `./script/test` and `./script/check` against an appropriate HOME when relevant.

Project-wide delivery, authority, evidence, and review rules follow the current `rebuildup/project-init` operating profile. This file only records dotfiles-specific constraints.
