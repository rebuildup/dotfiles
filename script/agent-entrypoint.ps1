#!/usr/bin/env pwsh
# Registers the Windows `agent` command: a managed `agent.cmd` shim in BinDir
# (default ~/.local/bin) that forwards to script/agent.cmd. Windows counterpart
# of the POSIX ~/.local/bin/agent link made by script/link.
#
#   agent-entrypoint.ps1 check [-BinDir <dir>]    verify the shim and that `agent` resolves to it
#   agent-entrypoint.ps1 install [-BinDir <dir>]  create the shim (idempotent), then verify
#   agent-entrypoint.ps1 remove [-BinDir <dir>]   remove the shim only if it is ours
#
# Safety: never overwrites or removes a file it does not own (no .grok\bin\agent.exe
# touching) and never edits PATH. If another `agent` shadows the shim the
# result is a FAIL (exit 1) with the shadowing path, never a silent success.
param(
  [Parameter(Position = 0)][ValidateSet('check', 'install', 'remove')][string]$Action = 'check',
  [string]$BinDir = (Join-Path $HOME '.local\bin')
)
$ErrorActionPreference = 'Stop'

$marker = 'rem managed-by: agent-entrypoint'
$target = Join-Path $PSScriptRoot 'agent.cmd'
$shim = Join-Path $BinDir 'agent.cmd'
$content = "@echo off`r`n$marker $target`r`n`"$target`" %*`r`n"

function Test-SamePath([string]$a, [string]$b) {
  [string]::Equals([IO.Path]::GetFullPath($a), [IO.Path]::GetFullPath($b), [StringComparison]::OrdinalIgnoreCase)
}

function Get-ShimState {
  if (-not (Test-Path -LiteralPath $shim)) { return 'missing' }
  $text = [IO.File]::ReadAllText($shim)
  if ($text.Contains("$marker $target")) { return 'ours' }
  return 'foreign'
}

# Returns $null when `agent` resolves to the shim in both PowerShell and cmd.exe.
function Get-Shadow {
  $ps = Get-Command agent -All -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $ps) { return "PowerShell cannot resolve 'agent' (is $BinDir on PATH?)" }
  $psPath = if ($ps.CommandType -eq 'Application') { $ps.Source } else { "$($ps.CommandType) '$($ps.Name)'" }
  if ($ps.CommandType -ne 'Application' -or -not (Test-SamePath $psPath $shim)) {
    return "PowerShell resolves 'agent' to $psPath, not $shim"
  }
  $first = (& where.exe agent 2>$null | Select-Object -First 1)
  if (-not $first) { return "where.exe cannot resolve 'agent'" }
  if (-not (Test-SamePath $first $shim)) { return "cmd.exe resolves 'agent' to $first, not $shim" }
  return $null
}

switch ($Action) {
  'remove' {
    switch (Get-ShimState) {
      'ours' { Remove-Item -LiteralPath $shim; Write-Output "removed $shim"; exit 0 }
      'missing' { Write-Output "nothing to remove: $shim"; exit 0 }
      default { [Console]::Error.WriteLine("refusing to remove unmanaged $shim"); exit 1 }
    }
  }
  'install' {
    switch (Get-ShimState) {
      'foreign' { [Console]::Error.WriteLine("refusing to overwrite unmanaged $shim"); exit 1 }
      'missing' {
        New-Item -ItemType Directory -Force -Path $BinDir | Out-Null
        [IO.File]::WriteAllText($shim, $content, [Text.UTF8Encoding]::new($false))
        Write-Output "created $shim"
      }
      'ours' {
        Write-Output "already installed: $shim"
      }
    }
  }
}

# install (after writing) and check both end with the resolution proof.
if ((Get-ShimState) -ne 'ours') {
  [Console]::Error.WriteLine("FAIL: $shim is $(Get-ShimState)")
  exit 1
}
$shadow = Get-Shadow
if ($shadow) {
  [Console]::Error.WriteLine("FAIL: agent entry point is shadowed: $shadow")
  [Console]::Error.WriteLine("Put $BinDir before the shadowing directory on PATH (this script never edits PATH).")
  exit 1
}
Write-Output "OK: 'agent' resolves to $shim in PowerShell and cmd.exe"
exit 0
