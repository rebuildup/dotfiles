# dotfiles

Personal user-level configuration for my development machines.

Machine/package provisioning belongs in [`rebuildup/pc-setup`](https://github.com/rebuildup/pc-setup). This repository owns the user configuration that is linked into `$HOME`, portable agent configuration composition, and Infisical runtime integration.

This is not a reusable dotfiles template.


## Setup

Fresh machineでは `pc-setup` をentrypointにする。OS package managerやInfisical/GitHub CLIの個別導入手順はこのrepositoryでは持たない。

> `pc-setup` 0.1.0 is still in its release stack. Until it reaches `main`, the commands below intentionally pin the current setup branches (`1` for the common mise bootstrap and `4` for NixOS). After the release they should be changed back to `main`.

### NixOS / NixOS-WSL

```bash
nix run 'github:rebuildup/pc-setup/4?dir=platforms/nixos'
```

Nix profileが必要toolを用意し、`~/.dotfiles` をcloneして `script/bootstrap` まで進める。

### Ubuntu / Ubuntu WSL

```bash
curl -fsSL https://raw.githubusercontent.com/rebuildup/pc-setup/1/bootstrap.sh | bash
```

### macOS

```bash
curl -fsSL https://raw.githubusercontent.com/rebuildup/pc-setup/1/bootstrap.sh | bash
```

Ubuntu/macOSではpc-setupがGit + miseを最小bootstrapし、その後miseが `~/.dotfiles` checkout、GitHub CLI、Infisical等を用意してこのrepositoryのbootstrapへhandoffする。

### Windows 11

```powershell
irm https://raw.githubusercontent.com/rebuildup/pc-setup/1/bootstrap.ps1 | iex
```

Windows machineのtool/application setupはmise + WinGetで進める。Windows nativeのdotfiles symlink adapterはまだcanonicalではないため、user-level dotfiles / agent configは現時点ではWSL側への適用をcanonicalとする。

### Direct dotfiles recovery

pc-setupを使わずこのrepositoryだけを復旧する場合は、先に `git`、`gh`、`infisical` が利用可能な状態を作る。

その後:

```bash
git clone https://github.com/rebuildup/dotfiles.git ~/.dotfiles
cd ~/.dotfiles
./script/bootstrap
```

初回cloneでは `--recurse-submodules` を付けない。private agent config repositoryは、bootstrapがGitHub認証を済ませてからpinされたcommitを取得する。

bootstrap中に未設定のものだけ要求される:

- Git identity
- GitHub browser login
- Infisical login

`.infisical.json` はcommit済みなので、通常はInfisical projectの再選択は発生しない。

### Verify

```bash
cd ~/.dotfiles
./script/check
./script/secrets-doctor
git submodule status --recursive
```

`git submodule status --recursive` の各行の先頭に `-`、`+`、`U` がなく、`script/check` と `script/secrets-doctor` が成功すればdotfiles bootstrap完了。

## Principles

- Keep only configuration that I actually use or need to reproduce.
- `home/` mirrors `$HOME`; managed files are linked individually into the real home directory.
- Linking is idempotent and non-destructive. Existing unmanaged targets are never overwritten automatically.
- Secret values are not Git state. Infisical is the canonical secret source of truth.
- Prefer process-scoped `infisical run` injection over global exports or persistent plaintext `.env` files.
- Git identity is machine/user-local state in `~/.gitconfig.local`; do not write it into the managed `~/.gitconfig`.
- GitHub HTTPS authentication uses GitHub CLI as Git's credential helper rather than account-password authentication.
- Local machines use Infisical user login; automated workloads use dedicated Machine Identities and short-lived platform/OIDC authentication where possible.
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

`.infisical.json` is committed non-secret project binding metadata. A new machine reuses this binding, so normal setup only needs Infisical user login; project selection is not repeated.

## Agent configuration

Global Claude Code, Codex, and OpenCode repositories are pinned as sibling submodules under `agents/`. A fresh clone does not need `--recurse-submodules`: `script/bootstrap` authenticates GitHub, stores the GitHub credential helper in machine-local `~/.gitconfig.local`, links the stable global Git config, then initializes the exact commits recorded by the parent repository.

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

Local development uses the Infisical CLI login session. Automated workloads use dedicated Machine Identities scoped to the project they need; prefer OIDC or platform-native workload identity over long-lived static credentials.

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

Run a command with the secrets from the bound dotfiles Infisical project injected into only that process:

```bash
./script/with-secrets command arg1 arg2
```

There is no runtime environment/path selector in this wrapper. The `.infisical.json` project binding is the scope boundary, and `with-secrets` simply delegates to `infisical run --project-config-dir=~/.dotfiles -- ...` without narrowing it further.

Project-specific secrets belong to that project's own Infisical project and `.infisical.json`. If secret sets become too broad, split the ownership at the project boundary instead of adding a secret-selection step to every command.

## SOPS migration history

SOPS + age was replaced by Infisical in 0.1.1. Active SOPS configuration and encrypted payloads are no longer part of the current tree.

Historical ciphertext remains in Git history. Migrated credentials should be rotated when practical if they are still valid.

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
