# No Claude Code interception here.
#
# `claude` is the native Claude Code CLI, using its own official login.
# Alternative paid API routes are opt-in global mise tasks:
#   mise run agent:claude:openrouter
#   mise run agent:claude:deepseek
#   AGENT_MODEL=<plan-model> mise run agent:claude:minimax
#
# Do not re-introduce a shell function named `claude` or export
# ANTHROPIC_* credentials globally. Existing shells must be restarted
# (or run `unset -f claude` in Bash/Zsh) after this change.
