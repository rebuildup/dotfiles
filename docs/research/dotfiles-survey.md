# Public dotfiles survey

Date: 2026-09-23

This survey records the external patterns considered before establishing the initial `rebuildup/dotfiles` structure. It is evidence for the ADRs, not a list of configuration to copy.

## Zach Holman — `holman/dotfiles`

Source: https://github.com/holman/dotfiles

- Organizes configuration by topic rather than one large shell file.
- Uses `*.symlink` files and a bootstrap script to create links into `$HOME`.
- Allows topic-local install scripts and PATH/completion fragments.

Adopted idea: keep configuration decomposable and make symlink deployment explicit.

Not adopted: automatic installation hooks. Package installation belongs in `pc-setup` here.

## thoughtbot — `thoughtbot/dotfiles`

Source: https://github.com/thoughtbot/dotfiles

- Uses `rcm` to create and maintain symlinks.
- Keeps personal overrides in a separate `dotfiles-local` source and `*.local` files.

Adopted idea: define a clear boundary for personal/machine-specific overrides.

Not adopted: the `rcm` dependency, because the initial requirements are satisfied by a small local linker.

## Jess Frazelle — `jessfraz/dotfiles`

Source: https://github.com/jessfraz/dotfiles

- `make` creates symlinks from the repository into the home directory.
- Keeps private/custom values in an `.extra` file.
- Includes automated shell checks/tests for the repository scripts.

Adopted idea: symlink behavior should be testable, and private/local values should remain outside the main tracked configuration.

Not adopted: Make as an additional command layer; direct scripts are sufficient for the current size.

## Mathias Bynens — `mathiasbynens/dotfiles`

Source: https://github.com/mathiasbynens/dotfiles

- Uses a bootstrap script and includes substantial macOS/Homebrew setup.
- Explicitly warns users to review and remove settings they do not understand or need instead of blindly copying them.

Adopted idea: treat another person's dotfiles as research material, not defaults.

Not adopted: OS defaults and package installation, because those are `pc-setup` responsibilities.

## Paul Irish — `paulirish/dotfiles`

Source: https://github.com/paulirish/dotfiles

- Treats the repository primarily as personal configuration and recommends selectively taking useful pieces rather than wholesale reuse.
- Covers a broad range of shell, preferences, helper binaries, and other personal tooling.

Adopted idea: optimize for the owner's actual workflow rather than trying to become a generic dotfiles framework.

Not adopted: broad scope before the corresponding configuration is actually needed.

## Resulting design

The initial design deliberately combines only the recurring ideas that match this repository's needs:

- symlinks as the live-config mechanism
- small, reviewable configuration units
- explicit local override boundaries
- non-destructive bootstrap behavior
- automated validation of the link mechanism
- selective adoption rather than copying a public setup wholesale

The project intentionally does **not** begin with a third-party dotfile manager, package installation, OS defaults, templates, host matrices, or a large alias/function collection. Those remain possible future refinements if concrete needs justify them.
