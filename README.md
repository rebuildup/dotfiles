# dotfiles

Minimal personal CLI configuration managed with symlinks.

This repository owns **user-level CLI configuration**. Application/package installation, OS defaults, package-manager setup, and machine provisioning belong in [`rebuildup/pc-setup`](https://github.com/rebuildup/pc-setup).

## Principles

- Keep the repository small. Add configuration only when there is an actual preference or recurring need.
- `home/` mirrors `$HOME`; managed files are linked individually into the real home directory.
- Linking is idempotent and non-destructive. Existing unmanaged targets are never overwritten automatically.
- Secrets and machine-specific values stay outside the repository and use tool-native local overrides where possible.
- Prefer common configuration. Add platform-specific structure only after a real platform difference appears.
- Do not make a dotfile manager an installation prerequisite while plain symlinks satisfy the required guarantees.

## Layout

```text
.
├── home/                 # files that mirror paths below $HOME
├── script/
│   ├── link              # create missing symlinks
│   ├── check             # detect missing/drifted symlinks
│   └── test              # isolated behavior test
├── docs/
│   ├── adr/              # durable decisions
│   └── research/         # evidence used by decisions
└── AGENTS.md             # project-local agent contract
```

## Bootstrap

Linux, macOS, and WSL are supported by the current Bash scripts.

```bash
git clone https://github.com/rebuildup/dotfiles.git ~/.dotfiles
cd ~/.dotfiles
./script/link
./script/check
```

`script/link` preflights every managed target before making changes and creates parent directories as needed. If any target already exists and is not the expected symlink, the command reports conflicts, creates no new links, and leaves existing targets untouched.

For an existing configuration, migrate or merge it deliberately before re-running the linker. For example, the managed Git config supports `~/.gitconfig.local` for identity, credentials-related settings, or machine-specific values:

```bash
mv ~/.gitconfig ~/.gitconfig.local
./script/link
```

Review `~/.gitconfig.local` after moving an existing file and keep only settings that should remain local.

## Add a dotfile

Place the source at the same relative path under `home/` that it should have below `$HOME`.

```text
home/.config/example/config
        ↓
~/.config/example/config
```

Then run:

```bash
./script/link
./script/check
./script/test
```

Do not add package installation commands here. If a CLI tool must be installed before its configuration can be used, document/install that dependency in `pc-setup` and keep only the configuration in this repository.

## Current configuration

The initial configuration intentionally contains only a small Git baseline:

- default branch: `main`
- prune deleted remote refs on fetch
- include optional `~/.gitconfig.local`
- ignore common OS metadata files globally

More settings should be added from observed usage rather than copied wholesale from another dotfiles repository.

## Decisions and research

- [`ADR-0001`](docs/adr/ADR-0001.md) — plain symlink home-mirror deployment
- [`ADR-0002`](docs/adr/ADR-0002.md) — minimal common-first configuration and `pc-setup` boundary
- [`dotfiles survey`](docs/research/dotfiles-survey.md) — representative public dotfiles reviewed before choosing the initial design
