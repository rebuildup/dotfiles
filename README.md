# dotfiles

Personal user-level configuration for my development machines.

Machine/package provisioning belongs in [`rebuildup/pc-setup`](https://github.com/rebuildup/pc-setup). This repository owns the user configuration that is linked into `$HOME`, portable agent configuration composition, and Infisical runtime integration.

This is not a reusable dotfiles template.


## Setup

Fresh machineでは、まず `git`、`gh`、`infisical` を使える状態にしてからこのrepositoryをbootstrapする。

### NixOS / NixOS-WSL

dotfilesだけを先に導入する場合は、一時Nix shellで必要toolを揃える。

```bash
nix shell nixpkgs#git nixpkgs#gh nixpkgs#infisical -c bash
```

shell内で下の「Common bootstrap」を実行する。

`pc-setup` のNixOS profileを適用済みなら `git` / `gh` / `infisical` は恒久profileに入るため、この一時shellは不要。

### Ubuntu / Ubuntu WSL

Gitとinstaller用toolを入れる。

```bash
sudo apt-get update
sudo apt-get install -y git curl wget ca-certificates
```

GitHub CLIは公式APT repositoryから入れる。

```bash
sudo mkdir -p -m 755 /etc/apt/keyrings
out="$(mktemp)"
wget -nv -O"$out" https://cli.github.com/packages/githubcli-archive-keyring.gpg
cat "$out" | sudo tee /etc/apt/keyrings/githubcli-archive-keyring.gpg >/dev/null
rm -f "$out"
sudo chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg
sudo mkdir -p -m 755 /etc/apt/sources.list.d
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
  | sudo tee /etc/apt/sources.list.d/github-cli.list >/dev/null
sudo apt-get update
sudo apt-get install -y gh
```

Infisical CLIは公式repositoryから入れる。

```bash
curl -1sLf 'https://artifacts-cli.infisical.com/setup.deb.sh' | sudo -E bash
sudo apt-get update
sudo apt-get install -y infisical
```

その後、下の「Common bootstrap」を実行する。

### macOS

Homebrewがまだ無ければ先に入れる。

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
```

installer終了時に表示される `brew shellenv` の設定を反映してから:

```bash
brew install git gh
brew install infisical/get-cli/infisical
```

その後、下の「Common bootstrap」を実行する。

### Windows 11

Windows nativeのapplication/package provisioningは `rebuildup/pc-setup` が所有する。

現在のdotfiles bootstrapはBashとPOSIX symlinkを前提としており、Windows nativeへの直接適用はまだcanonicalではない。WindowsではWSL側へdotfilesを導入し、使用するdistributionに応じて上の **NixOS / NixOS-WSL** または **Ubuntu / Ubuntu WSL** の手順を使う。

Windows native側のClaude/Codex/OpenCode設定も将来的に同じsource of truthへlinkするが、cross-platform link adapterが完成するまでは自動適用しない。

### Common bootstrap

初回cloneでは `--recurse-submodules` を付けない。agent config repositoryはprivateなので、bootstrapがGitHub認証を済ませてからpinされたsubmoduleを取得する。

```bash
git clone https://github.com/rebuildup/dotfiles.git ~/.dotfiles
cd ~/.dotfiles
./script/bootstrap
```

`script/bootstrap` の途中で必要に応じて:

- Git identity
- GitHub browser login
- Infisical login

が要求される。

完了後に確認する。

```bash
cd ~/.dotfiles
./script/check
./script/secrets-doctor
git submodule status --recursive
```

`git submodule status --recursive` の各行の先頭に `-`、`+`、`U` が無く、`script/check` と `script/secrets-doctor` が成功すればbootstrap完了。

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

`.infisical.json` is non-secret project binding metadata. It appears after the first `infisical init`; once reviewed, commit it through the normal issue/release flow so future machines bind to the same project without repeating project selection.

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
