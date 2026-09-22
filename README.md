# dotfiles

Minimal personal CLI configuration managed with symlinks and SOPS-encrypted portable secrets.

This repository owns **user-level CLI configuration**. Application/package installation, OS defaults, package-manager setup, SOPS/age installation, and machine provisioning belong in [`rebuildup/pc-setup`](https://github.com/rebuildup/pc-setup).

## Principles

- Keep the repository small. Add configuration only when there is an actual preference or recurring need.
- `home/` mirrors `$HOME`; managed files are linked individually into the real home directory.
- Linking is idempotent and non-destructive. Existing unmanaged targets are never overwritten automatically.
- Portable secrets use SOPS + age; plaintext secrets and the age private identity never belong in Git.
- Prefer process-scoped secret injection over globally exporting every API key into login shells.
- Prefer common configuration. Add platform-specific structure only after a real platform difference appears.
- Do not make a dotfile manager an installation prerequisite while plain symlinks satisfy the required guarantees.

## Layout

```text
.
├── home/                 # public files that mirror paths below $HOME
├── secrets/              # SOPS-encrypted portable secret payloads only
├── script/
│   ├── link              # create missing symlinks
│   ├── check             # detect missing/drifted symlinks
│   ├── test              # isolated symlink behavior test
│   ├── secrets-init      # establish local age identity + public .sops.yaml
│   ├── secrets-doctor    # validate secret bootstrap state
│   ├── with-secrets      # process-scoped env secret injection
│   └── check-secrets     # reject tracked private-key material
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

For an existing configuration, migrate or merge it deliberately before re-running the linker. For example, the managed Git config supports `~/.gitconfig.local` for identity or machine-specific non-secret values:

```bash
mv ~/.gitconfig ~/.gitconfig.local
./script/link
```

Review `~/.gitconfig.local` after moving an existing file and keep only settings that should remain local.

## Secret bootstrap

SOPS + age reduces portable secret recovery to one root secret: the age private identity.

After `pc-setup` installs `sops` and `age`:

```bash
./script/secrets-init
./script/secrets-doctor
```

`secrets-init` uses `$SOPS_AGE_KEY_FILE` when set, otherwise `~/.config/sops/age/keys.txt`. If no local identity exists it generates one with restrictive permissions, derives its public recipient, and creates a repository-root `.sops.yaml`.

The private identity must be backed up somewhere outside this repository. Only the corresponding public `age1...` recipient is committed.

Once `.sops.yaml` exists, create a flat encrypted environment file:

```bash
sops secrets/global.sops.json
```

Then inject those values into one explicit process:

```bash
./script/with-secrets 'your-command'
```

This uses SOPS `exec-env`; the default path is `secrets/global.sops.json`. Set `DOTFILES_SECRET_FILE` to select another encrypted environment file.

SSH private keys remain device-specific by default. Generate a new key for a new device unless a particular key has been explicitly classified as a portable encrypted file secret.

See [`secrets/README.md`](secrets/README.md) and [`ADR-0003`](docs/adr/ADR-0003.md).

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
./script/check-secrets
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
- [`ADR-0003`](docs/adr/ADR-0003.md) — SOPS + age portable secret bootstrap boundary
- [`dotfiles survey`](docs/research/dotfiles-survey.md) — representative public dotfiles reviewed before choosing the initial design
