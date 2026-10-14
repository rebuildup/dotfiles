# Interactive-shell provider entrypoint delegation (ADR-0008).
# Sourced from ~/.bashrc. Sets no provider URL, model, or credential;
# script/agent/openrouter owns process-scoped OpenRouter state.

if [[ -x "${HOME}/.dotfiles/script/agent/openrouter" ]]; then
  claude() {
    "${HOME}/.dotfiles/script/agent/openrouter" claude "$@"
  }
fi

# --- rollback (MiMo) -----------------------------------------------
# To return to the MiMo provider, restore the block below and remove
# the openrouter block above (original file backup:
# ~/.config/opencode/backup-mimo-20261009/agent-init.bash.mimo-original,
# or `git -C ~/.dotfiles checkout -- config/agent-init.bash`):
#
# if [[ -x "${HOME}/.dotfiles/script/agent/mimo" ]]; then
#   claude() {
#     "${HOME}/.dotfiles/script/agent/mimo" claude "$@"
#   }
# fi
