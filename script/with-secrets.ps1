#!/usr/bin/env pwsh
# script/with-secrets — PowerShell mirror of the bash wrapper for
# Windows-native usage. Runs a command with the self-hosted Infisical `dev`
# secret set injected (process-scoped):
#
#   with-secrets.ps1 command [args...]
#
# Same contract as the bash script: non-secret instance metadata comes from
# config/infisical.sh, the tracked project binding must match, and the
# `infisical` CLI is started natively (infisical.exe on Windows).
$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$metadata = Get-Content -Raw (Join-Path $repoRoot 'config' 'infisical.sh')
$projectId = [regex]::Match($metadata, 'INFISICAL_PROJECT_ID="([^"]+)"').Groups[1].Value
$environment = [regex]::Match($metadata, 'INFISICAL_ENVIRONMENT="([^"]+)"').Groups[1].Value
if (-not $projectId -or -not $environment) {
    [Console]::Error.WriteLine('config/infisical.sh does not declare INFISICAL_PROJECT_ID / INFISICAL_ENVIRONMENT')
    exit 1
}

if ($args.Count -lt 1) {
    [Console]::Error.WriteLine("usage: $($MyInvocation.MyCommand.Name) command [args...]")
    exit 2
}

if (-not (Get-Command infisical -ErrorAction SilentlyContinue)) {
    [Console]::Error.WriteLine('missing required command: infisical (install it via pc-setup)')
    exit 1
}

$binding = Join-Path $repoRoot '.infisical.json'
if (-not (Test-Path $binding)) {
    [Console]::Error.WriteLine("missing tracked Infisical project binding: $binding")
    exit 1
}

$bindingText = Get-Content -Raw $binding
if ($bindingText -notmatch [regex]::Escape($projectId)) {
    [Console]::Error.WriteLine("Infisical binding does not match expected self-host project $projectId")
    exit 1
}

# PS 7.3+ passes array elements faithfully; older versions only. Harmless
# assignment where the variable is unknown (Windows PowerShell 5.1).
$PSNativeCommandArgumentPassing = 'Standard'
& infisical run "--projectId=$projectId" "--env=$environment" "--project-config-dir=$repoRoot" -- @args
exit $LASTEXITCODE
