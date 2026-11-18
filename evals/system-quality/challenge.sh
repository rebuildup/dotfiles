#!/usr/bin/env bash
# Materialize a symlink-free copy of the repo and run the system-quality
# challenge suite against it. challenge.mts refuses symlinks, so .claude
# skill links and home/ entries are dereferenced away (they are not part of
# the TypeScript surface under test).
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
suite="${1:-evals/system-quality/typecheck.challenge.json}"
work="$(mktemp -d "${TMPDIR:-/tmp}/sq-challenge.XXXXXX")"
trap 'rm -rf "$work"' EXIT

mkdir -p "$work/source"
tar -C "$repo_root" --exclude=.git --exclude=node_modules -cf - . | tar -C "$work/source" -xf -
find "$work/source" -type l -delete

exec bun "$repo_root/.devin/skills/system-quality/scripts/challenge.mts" \
  "$work/source" "$repo_root/$suite"
