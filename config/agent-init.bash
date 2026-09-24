# Interactive-shell provider entrypoint delegation (ADR-0008).
# Sourced from ~/.bashrc. Sets no provider URL, model, or credential;
# script/agent/mimo owns process-scoped MiMo state.

if [[ -x "${HOME}/.dotfiles/script/agent/mimo" ]]; then
  claude() {
    "${HOME}/.dotfiles/script/agent/mimo" claude "$@"
  }
fi
