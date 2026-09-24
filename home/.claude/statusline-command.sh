#!/usr/bin/env bash
#
# Claude Code status line renderer.
#
# Reads a single JSON payload from stdin (Claude Code passes the live
# session context this way), then prints a colored, OSC8-hyperlinked
# status line showing:
#
#   <workspace> (VS Code clickable) | <model> | <effort> | <ctx%> | <branch [↑ahead↓behind]> | <PR>
#
# All visual details — colors, clickable dir/PR links, ahead/behind
# counters — are derived from the JSON payload + the current Git
# state of the workspace directory. Output is intentionally a single
# line so it stays compatible with terminals that do not preserve
# trailing newlines.
#
# This file is symlinked into $HOME by `script/link`, so any change
# here is picked up on every machine that shares these dotfiles.
# Keep it portable: POSIX-ish bash, `jq`, `git`, `sed`, `basename`,
# `printf`. Do not introduce provider-specific or absolute-path
# assumptions here — this is the cross-provider baseline.

set -euo pipefail

input="$(cat)"

dir="$(printf '%s' "$input" | jq -r '.workspace.current_dir')"
short="$(basename "$dir")"
model="$(printf '%s' "$input" | jq -r '.model.display_name')"
effort="$(printf '%s' "$input" | jq -r '.effort.level // "off"')"

ctx="$(printf '%s' "$input" | jq -r '
  .context_window.used_percentage
  | if . != null then ((. | floor) | tostring) + "%" else empty end
')"

branch="$(git -C "$dir" --no-optional-locks symbolic-ref --short HEAD 2>/dev/null || true)"
upstream="$(git -C "$dir" --no-optional-locks rev-parse --abbrev-ref '@{u}' 2>/dev/null || true)"

ahead=""
behind=""
if [[ -n "$upstream" ]]; then
  ahead="$(git -C "$dir" --no-optional-locks rev-list --count '@{u}..HEAD' 2>/dev/null || true)"
  behind="$(git -C "$dir" --no-optional-locks rev-list --count 'HEAD..@{u}' 2>/dev/null || true)"
fi

pr="$(printf '%s' "$input" | jq -r '.pr.url // empty')"
if [[ -z "$pr" ]]; then
  remote="$(git -C "$dir" --no-optional-locks remote get-url origin 2>/dev/null || true)"
  case "$remote" in
    *github.com*)
      pr="https://github.com/$(printf '%s' "$remote" | sed -E 's#(git@|https://)?github.com[:/]([^/]+)/([^/.]+)(\.git)?$#\2/\3#')/pulls"
      ;;
  esac
fi

pr_short="$(printf '%s' "$pr" | sed -nE 's;https?://[^/]+/([^/]+)/([^/]+)/pull/([0-9]+).*;\1/\2#\3;p')"
[[ -z "$pr_short" ]] && pr_short="PRs"

# Workspace (clickable VS Code link in WSL).
printf '\e]8;;vscode://vscode-remote/wsl+%s%s\e\\\e[01;34m%s\e[0m\e]8;;\e\\' \
  "${WSL_DISTRO_NAME:-}" "$dir" "$short"

# Model + effort level.
printf ' | \e[33m%s\e[0m' "$model"
printf ' | \e[35m%s\e[0m' "$effort"

# Context window usage (only when Claude provides a percentage).
if [[ -n "$ctx" ]]; then
  printf ' | \e[36m%s\e[0m' "$ctx"
fi

# Git branch with ahead/behind counters when an upstream is set.
if [[ -n "$branch" ]]; then
  printf ' | \e[32m%s' "$branch"
  if [[ -n "$upstream" ]]; then
    printf '↑%s↓%s' "$ahead" "$behind"
  fi
  printf '\e[0m'
fi

# PR link (clickable when a concrete PR URL is known).
if [[ -n "$pr" ]]; then
  printf ' | \e]8;;%s\e\\\e[31m%s\e[0m\e]8;;\e\\' "$pr" "$pr_short"
fi

echo ""
