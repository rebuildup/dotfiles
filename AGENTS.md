# Agent Contract

This repository manages personal CLI configuration. Keep the contract short and preserve these project-local invariants:

- `dotfiles` owns user-level CLI configuration and encrypted portable secret payloads; `pc-setup` owns software installation, OS setup, and machine provisioning.
- `home/` mirrors `$HOME`. Managed public files are linked individually rather than copying configuration into place.
- `script/link` must remain idempotent and non-destructive. Never silently replace an unmanaged file, directory, or foreign symlink.
- Portable secrets use SOPS + age. Plaintext secrets, credentials, tokens, private keys, and the age private identity must never be committed.
- The age private identity is a bootstrap root secret outside the repository. Only its public recipient belongs in `.sops.yaml`.
- Secret material must not be placed under `home/`. Environment-shaped secrets should prefer process-scoped `sops exec-env` consumption.
- SSH private keys are device-local by default. Do not silently convert a device identity into a portable shared key.
- Keep configuration minimal. Do not add aliases, defaults, dependencies, abstractions, platform branches, or helper tooling without an observed need.
- Durable architecture or workflow decisions belong in `docs/adr/`; supporting external research belongs in `docs/research/`.
- Before presenting a change as ready, run `./script/test`, `./script/check-secrets`, and the relevant `./script/check` / `./script/secrets-doctor` validation.

Project-wide delivery, authority, evidence, and review rules follow the current `rebuildup/project-init` operating profile. This file only records dotfiles-specific constraints.
