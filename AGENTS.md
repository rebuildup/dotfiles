# Agent Contract

This repository manages personal CLI configuration. Preserve these project-local invariants:

- `dotfiles` owns user-level CLI configuration and Infisical bootstrap/runtime wrappers; `pc-setup` owns software installation, OS setup, and machine provisioning.
- `home/` mirrors `$HOME`. Managed public files are linked individually rather than copied.
- `script/link` must remain idempotent and non-destructive. Never silently replace an unmanaged file, directory, or foreign symlink.
- Git identity belongs in `~/.gitconfig.local`. Do not instruct users to run `git config --global user.*` against the symlink-managed global config.
- GitHub HTTPS Git authentication uses `gh auth setup-git`; do not introduce account-password authentication.
- The canonical Infisical control plane is the self-hosted instance at `https://secrets.rebuildup.dev`; wrappers must not silently fall back to Infisical Cloud.
- `config/infisical.sh` owns non-secret instance metadata. `.infisical.json` owns the dotfiles project binding. Both may be committed; secret values and login/session/cache material remain machine-local.
- The dotfiles Infisical project ID is `d4c2fc09-a923-4a38-9cf4-b51769aadb76`; its canonical environment is `dev`. Wrappers must pass both explicitly.
- Human workstations use Infisical user login. Automation uses dedicated least-privilege Machine Identities; prefer platform-native/OIDC short-lived authentication over static client secrets.
- Environment-shaped secrets should use process-scoped `infisical run` injection rather than global shell exports or persistent plaintext files.
- Do not manage Infisical credential/cache directories, SSH private keys, `.env` files, SOPS payloads, or private key material through `home/`.
- SSH private keys are device-local by default. Do not silently convert a device identity into a portable shared key.
- Keep configuration minimal. Do not add dependencies or abstractions without an observed need.
- Durable architecture/workflow decisions belong in `docs/adr/`; supporting external research belongs in `docs/research/`.
- Before presenting a change as ready, run `./script/test`, `./script/test-workflow`, `./script/check-secrets`, and relevant `./script/check` / `./script/secrets-doctor` validation.

Project-wide delivery, authority, evidence, and review rules follow the current `rebuildup/project-init` operating profile.


## Constitution / operating profile

- 最上位 contract: [`constitution/CONSTITUTION.md`](constitution/CONSTITUTION.md)
- current Operating Model: [`organization/profiles/release-driven-solo.md`](organization/profiles/release-driven-solo.md)
- 既存の project-specific invariant / ADR は、Constitution と両立する限り generic upstream Practice より具体的な authority として保持する。


## Agent Skills lifecycle

project-init 由来の Agent Skills は **project-local** に管理し、global install を canonical にしない。

- 初回導入 / 全体 reconcile: `bunx skills add rebuildup/project-init --skill '*' --agent claude-code opencode codex -y`
- fresh clone から lock を復元: `bunx skills install`
- 継続更新: `bunx skills update -p -y`
- `skills-lock.json` は `skills` CLI が生成・更新する source/freshness metadata として commit する。手で hash / source entry を捏造しない。
- upstream-managed Skill 本文は手編集しない。project 固有の refinement / override は別の project-local Skill、adapter、ADR、docs に置き、次回 update で上書きされない構造にする。
- update 後は Git diff と applicable quality gate を確認し、upstream 更新を無条件に current project policy とみなさない。

Bun はここでは Agent Skills 管理用の project tooling であり、product runtime / package manager の既存 decision を自動的に置換しない。
