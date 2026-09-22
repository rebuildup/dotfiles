# dotfiles

Minimal personal CLI configuration managed with symlinks. Portable secrets are managed centrally in Infisical and injected at runtime.

This repository owns **user-level CLI configuration**. Application/package installation, OS defaults, package-manager setup, Infisical/GitHub CLI installation, and machine provisioning belong in [`rebuildup/pc-setup`](https://github.com/rebuildup/pc-setup).

## Principles

- Keep the repository small. Add configuration only when there is an actual preference or recurring need.
- `home/` mirrors `$HOME`; managed files are linked individually into the real home directory.
- Linking is idempotent and non-destructive. Existing unmanaged targets are never overwritten automatically.
- Secret values are not Git state. Infisical is the canonical secret source of truth.
- Prefer process-scoped `infisical run` injection over global exports or persistent plaintext `.env` files.
- Git identity is machine/user-local state in `~/.gitconfig.local`; do not write it into the managed `~/.gitconfig`.
- GitHub HTTPS authentication uses GitHub CLI as Git's credential helper rather than account-password authentication.
- Human workstations use Infisical user login; CI/agents use least-privilege Machine Identities and short-lived platform/OIDC authentication where possible.
- Prefer common configuration. Add platform-specific structure only after a real platform difference appears.

## Layout

```text
.
├── .infisical.json       # project/default-environment binding; created by infisical init
├── agents/               # pinned private agent-config submodules
│   ├── claude/
│   ├── codex/
│   └── opencode/
├── home/                 # public files that mirror paths below $HOME
├── script/
│   ├── bootstrap         # fresh-machine identity/auth/project bootstrap
│   ├── link              # create missing symlinks
│   ├── check             # detect missing/drifted symlinks
│   ├── test              # isolated symlink behavior test
│   ├── test-workflow     # bootstrap / Infisical regression test
│   ├── secrets-doctor    # validate Infisical project access
│   ├── with-secrets      # process-scoped Infisical runtime injection
│   └── check-secrets     # reject secret material / legacy SOPS state in Git
├── docs/
│   ├── adr/
│   └── research/
└── AGENTS.md
```

`.infisical.json` is non-secret project binding metadata. It appears after the first `infisical init`; once reviewed, commit it through the normal issue/release flow so future machines bind to the same project without repeating project selection.

## Fresh-machine bootstrap

The machine first needs `git`, `gh`, and `infisical`. On managed machines these come from `pc-setup`.

```bash
git clone https://github.com/rebuildup/dotfiles.git ~/.dotfiles
cd ~/.dotfiles
./script/bootstrap
```

`bootstrap` performs:

1. Git identity setup in `~/.gitconfig.local`
2. migration of accidentally managed `user.name` / `user.email`
3. GitHub browser authentication when needed
4. `gh auth setup-git`
5. pinned private agent-config submodule sync/init
6. dotfile link/check
7. Infisical user login when needed
8. `infisical init` when no project binding exists
9. Infisical runtime-access validation

For non-interactive Git identity setup:

```bash
DOTFILES_GIT_NAME='Your Name' \
DOTFILES_GIT_EMAIL='you@example.com' \
./script/bootstrap
```

Do **not** use `git config --global user.name/user.email` after `~/.gitconfig` is linked: Git may write through the managed global-config path.

## Agent configuration

Global Claude Code, Codex, and OpenCode repositories are pinned as sibling submodules under `agents/`. A fresh clone does not need `--recurse-submodules`: `script/bootstrap` authenticates GitHub first, then initializes the exact commits recorded by the parent repository.

The current submodules are fetched automatically but are **not yet linked into active agent config paths**. Each child repository must first be made cross-platform; for example, the current Claude settings contain a Windows-specific absolute hook path. Activation before that cleanup would make the same dotfiles commit behave differently across operating systems.

The target composition is:

```text
agents/
├── common/      # future shared global instructions / Agent Skills
├── claude/      # Claude-specific settings
├── codex/       # Codex-specific settings
└── opencode/    # OpenCode-specific settings
```

The future common repository will own only tool-neutral Markdown instructions, Agent Skills, and genuinely portable supporting assets. Product-specific permission/provider/plugin formats stay in their product repositories.

One common global instruction source will be linked to:

- `~/.claude/CLAUDE.md`
- `~/.codex/AGENTS.md`
- `~/.config/opencode/AGENTS.md`

See [ADR-0005](docs/adr/ADR-0005.md).

## Secret model

Infisical owns secret values, versions, access policy, audit history, and rotation. The repository does not contain encrypted secret payloads either.

Human local development uses the Infisical CLI login session. Automated workloads should use dedicated Machine Identities scoped to the required project/environment/path; prefer OIDC or platform-native workload identity over long-lived static credentials.

The following must never be committed:

- `INFISICAL_TOKEN`
- Universal Auth client secrets
- user/session credentials
- Infisical local credential/cache files
- plaintext `.env`
- private SSH or age keys
- SOPS payloads/config from the superseded design

### Updating secrets

A secret update is **not a Git operation**.

Use the Infisical dashboard or the Infisical CLI to create/update/delete values. There is no dotfiles commit or push after a value change; Infisical provides its own version and audit history.

Avoid putting secret values directly into reusable shell history. For interactive manual edits, the dashboard is the default path unless a purpose-built non-history CLI flow is required.

### Using secrets

Run a command with the dotfiles Infisical project injected into only that process:

```bash
./script/with-secrets command arg1 arg2
```

Optional scope overrides:

```bash
DOTFILES_INFISICAL_ENV=dev \
DOTFILES_INFISICAL_PATH=/tools \
./script/with-secrets command
```

The wrapper uses `infisical run --project-config-dir=~/.dotfiles -- ...`, so the launched command keeps the caller's working directory while project binding is resolved from this repository.

Project-specific applications should normally keep their own `.infisical.json` and call `infisical run` directly rather than depending on the global dotfiles project.

## Migration from SOPS

ADR-0003 is superseded by ADR-0004.

Before the 0.1.1 migration is released to `main`, import every still-required value from the previous SOPS payload into the chosen Infisical project and verify it through `script/with-secrets`.

The patch removes active `.sops.yaml`, `secrets/*.sops.*`, SOPS helpers, and age bootstrap requirements. Historical ciphertext remains in Git history unless history is deliberately rewritten. Rotate migrated credentials when practical so the retired age key cannot decrypt still-valid historical values.

## Add a dotfile

Place the source at the same relative path under `home/` that it should have below `$HOME`, then run:

```bash
./script/link
./script/check
./script/test
./script/test-workflow
./script/check-secrets
```

Do not add package installation commands here. If a CLI tool must be installed before its configuration can be used, install/document that dependency in `pc-setup`.

## Current configuration

The current common Git baseline includes:

- default branch: `main`
- prune deleted remote refs on fetch
- global ignore via `~/.config/git/ignore`
- machine/user-local `~/.gitconfig.local`

## Decisions and research

- [`ADR-0001`](docs/adr/ADR-0001.md) — plain symlink home-mirror deployment
- [`ADR-0002`](docs/adr/ADR-0002.md) — minimal common-first configuration and `pc-setup` boundary
- [`ADR-0003`](docs/adr/ADR-0003.md) — superseded SOPS + age design
- [`ADR-0004`](docs/adr/ADR-0004.md) — Infisical secret source of truth
- [`ADR-0005`](docs/adr/ADR-0005.md) — sibling agent-config submodules and shared portable assets
- [`dotfiles survey`](docs/research/dotfiles-survey.md)
