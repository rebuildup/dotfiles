# dotfiles

Personal user-level configuration for my development machines.

Machine/package provisioning belongs in [`rebuildup/pc-setup`](https://github.com/rebuildup/pc-setup). This repository owns the user configuration that is linked into `$HOME`, portable agent configuration composition, and Infisical runtime integration.

This is not a reusable dotfiles template.


## Setup

Fresh machineでは `pc-setup` をentrypointにする。OS package managerやInfisical/GitHub CLIの個別導入手順はこのrepositoryでは持たない。

### NixOS / NixOS-WSL

```bash
nix run 'github:rebuildup/pc-setup?dir=platforms/nixos'
```

Nix/Flakeとmachine-global mise baselineが必要toolを用意し、`~/.dotfiles` をcloneして `script/bootstrap` まで進める。

### Ubuntu / Ubuntu WSL

```bash
curl -fsSL https://raw.githubusercontent.com/rebuildup/pc-setup/main/bootstrap.sh | bash
```

### macOS

```bash
curl -fsSL https://raw.githubusercontent.com/rebuildup/pc-setup/main/bootstrap.sh | bash
```

Ubuntu/macOSではpc-setupがGit + miseを最小bootstrapし、その後miseが `~/.dotfiles` checkout、GitHub CLI、Infisical等を用意してこのrepositoryのbootstrapへhandoffする。

### Windows 11

```powershell
irm https://raw.githubusercontent.com/rebuildup/pc-setup/main/bootstrap.ps1 | iex
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

既存の `~/.gitconfig` / `~/.config/git/ignore` がある場合、bootstrapは元ファイルを `.pre-dotfiles` backupとして残した上で、user-owned Git設定や追加ignore patternをmachine-local stateへ移行してからmanaged symlinkへ切り替える。

bootstrap中に未設定のものだけ要求される:

- Git identity
- GitHub browser login
- Infisical self-host login

Infisicalは `https://secrets.rebuildup.dev` のself-hosted instanceを使用する。WSLではSecret Service / D-Busに依存しないようInfisicalの`file` vault backendを使用し、backend切替でsessionが失効した場合はbootstrapが再ログインへ進む。bootstrapは必要時に:

```bash
infisical login --domain=https://secrets.rebuildup.dev
```

相当のloginを行う。`.infisical.json` はcommit済みなので、projectの再選択は発生しない。

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
- Linking is idempotent and non-destructive. `script/link` never overwrites unmanaged targets; `script/bootstrap` only adopts known legacy Git targets after preserving backups and migrating user-owned state.
- Secret values are not Git state. The self-hosted Infisical instance at `https://secrets.rebuildup.dev` is the canonical secret source of truth.
- Prefer process-scoped `infisical run` injection over global exports or persistent plaintext `.env` files.
- Git identity is machine/user-local state in `~/.gitconfig.local`; do not write it into the managed `~/.gitconfig`.
- GitHub HTTPS authentication uses GitHub CLI as Git's credential helper rather than account-password authentication.
- Local machines use Infisical user login; automated workloads use dedicated Machine Identities and short-lived platform/OIDC authentication where possible.
- Prefer common configuration. Add platform-specific structure only after a real platform difference appears.

## Layout

```text
.
├── .infisical.json       # tracked self-host project binding
├── config/
│   └── infisical.sh      # non-secret self-host site/API/project metadata
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

`.infisical.json` and `config/infisical.sh` are committed non-secret metadata.

Canonical binding:

- site: `https://secrets.rebuildup.dev`
- API: `https://secrets.rebuildup.dev/api`
- project: `d4c2fc09-a923-4a38-9cf4-b51769aadb76`
- environment: `dev`

A new machine reuses this binding. Normal setup only needs user authentication against the self-hosted instance; `infisical init` is not part of the normal bootstrap.

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

The self-hosted Infisical instance at `https://secrets.rebuildup.dev` owns secret values, versions, access policy, audit history, and rotation. The repository does not contain encrypted secret payloads either.

Local development uses an Infisical CLI user session authenticated against `https://secrets.rebuildup.dev`. Automated workloads use dedicated Machine Identities on the same instance, scoped to the project they need; prefer OIDC or platform-native workload identity over long-lived static credentials.

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

Use the self-hosted dashboard at `https://secrets.rebuildup.dev` or the Infisical CLI to create/update/delete values. There is no dotfiles commit or push after a value change; Infisical provides its own version and audit history.

Avoid putting secret values directly into reusable shell history. For interactive manual edits, the dashboard is the default path unless a purpose-built non-history CLI flow is required.

### Using secrets

Run a command with the secrets from the bound dotfiles Infisical project injected into only that process:

```bash
./script/with-secrets command arg1 arg2
```

There is no runtime environment/path selector at call time. The dotfiles secret project uses the canonical `dev` environment. `config/infisical.sh` pins the API URL, project ID, and environment, and `with-secrets` delegates with explicit `--projectId` and `--env=dev`. The wrapper does not narrow secrets by path.

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
- [`ADR-0006`](docs/adr/ADR-0006.md) — self-hosted Infisical control plane
- [`ADR-0007`](docs/adr/ADR-0007.md) — WSL Infisical file-vault / bounded runtime validation
- [`dotfiles survey`](docs/research/dotfiles-survey.md)
