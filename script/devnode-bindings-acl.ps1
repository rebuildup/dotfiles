[CmdletBinding()]
param([Parameter(Mandatory)][string]$LiteralPath)
# Validate user-level binding integrity; never set or weaken permissions here.
$env:PSModulePath = Join-Path $PSHOME 'Modules'
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$trusted = @($sid, 'S-1-5-18', 'S-1-5-32-544')
$parent = [IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($LiteralPath))
foreach ($path in @($LiteralPath, $parent)) {
    $item = Get-Item -LiteralPath $path -Force
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Binding path must not be a reparse point.' }
    $acl = Get-Acl -LiteralPath $path
    if ($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -cne $sid) { throw 'Binding and parent must be owned by current user.' }
    if ($path -ceq $parent -and -not $acl.AreAccessRulesProtected) { throw 'Binding parent must have a protected DACL.' }
    foreach ($rule in $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
        if ($rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow) { continue }
        if ($rule.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly) { continue }
        # WriteData/Append/WriteEA/WriteAttributes/DeleteChild/Delete/WriteDACL/WriteOwner.
        $writeMask = 2 -bor 4 -bor 16 -bor 256 -bor 64 -bor 65536 -bor 262144 -bor 524288 -bor 0x10000000 -bor 0x40000000
        if (($rule.FileSystemRights.value__ -band $writeMask) -and $rule.IdentityReference.Value -notin $trusted) { throw 'Foreign principal can modify binding resources.' }
    }
}
[Console]::WriteLine('private-binding-acl-ok')
