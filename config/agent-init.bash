# No Claude Code interception here.
#
# `claude` is the native Claude Code CLI, using its own official login.
# Alternative provider routes are explicit and process-scoped through the
# unified launcher (config/agents.toml + script/agent-launcher):
#   agent list                             # configured routes
#   agent claude openrouter                # Claude Code via OpenRouter
#   agent claude deepseek -- -p 'say ok'   # Claude Code via DeepSeek
#   agent claude minimax --model MiniMax-M2.5 -- <args>
#   agent opencode zen                     # OpenCode on free zen models
#
# Do not re-introduce a shell function named `claude` or export
# ANTHROPIC_* credentials globally. Existing shells must be restarted
# (or run `unset -f claude` in Bash/Zsh) after this change.
