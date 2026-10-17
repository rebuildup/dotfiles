#!/usr/bin/env pwsh
# `agent` — PowerShell entry point for the unified AI harness launcher
# (Windows-native; no Bash/WSL/Python involved). Usage matches the Unix form:
#
#   agent.ps1 <harness> <provider> [--model <id>] [-- <harness args>...]
#   agent.ps1 <harness>-<provider> [<harness args>...]
#   agent.ps1 list | models <provider> | shortcuts [list|check|create|remove] | check | help
#
# Short commands (`<harness>-<provider>`) work here directly as the first
# argument; `agent shortcuts create` additionally generates minimal .cmd
# entry points derived from config/agents.toml.
$ErrorActionPreference = 'Stop'
$launcher = Join-Path $PSScriptRoot 'agent.ts'
$PSNativeCommandArgumentPassing = 'Standard'  # PS 7.3+: faithful arg passing
& bun $launcher @args
exit $LASTEXITCODE
