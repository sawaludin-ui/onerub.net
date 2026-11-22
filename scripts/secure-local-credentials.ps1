# PowerShell / Windows NTFS / OneRub local credentials. Never emits credential bytes.
[CmdletBinding()]
param(
    [ValidateSet('Audit', 'Harden', 'Verify', 'Restore')][string]$Action = 'Audit',
    [string]$ProjectRoot = '',
    [string]$RecoveryFile = 'D:/NXR/secrets/onerub-marketplace-recovery.json',
    [string]$ApprovedRecoveryJunctionTarget = '',
    [switch]$IncludeDeployer,
    [string[]]$EncryptedSnapshotFile = @(),
    [string]$VaultDirectory = (Join-Path $env:LOCALAPPDATA 'OneRubCredentialRecovery'),
    [string[]]$RuntimeReadSid = @(),
    [string]$BackupManifest,
    [switch]$RequireOriginalMatch,
    [ValidatePattern('^(env|runtime|recovery|deployer|snapshot-\d+)$')][string]$RestoreId,
    [string]$RestoreDirectory
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if (-not $ProjectRoot) { $ProjectRoot = Split-Path -Parent $PSScriptRoot }
if ($env:OS -ne 'Windows_NT') { throw 'NTFS ACL and CurrentUser DPAPI require Windows.' }
Add-Type -AssemblyName System.Security
$operatorSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$adminSids = @($operatorSid, 'S-1-5-18', 'S-1-5-32-544') | Select-Object -Unique
foreach ($sid in $RuntimeReadSid) {
    # No group-wide grants: only an explicitly supplied user or service SID is accepted.
    if ($sid -notmatch '^S-1-5-(21-\d+-\d+-\d+-\d+|80-(\d+-){4}\d+)$') { throw 'RuntimeReadSid must be an exact user/service SID, not a broad group.' }
    $resolved = New-Object Security.Principal.SecurityIdentifier($sid)
    try {
        $account = $resolved.Translate([Security.Principal.NTAccount]).Value
        $local = Get-LocalGroup -ErrorAction SilentlyContinue | Where-Object { $_.SID.Value -eq $sid }
        if ($local) { throw 'Local groups cannot be allowlisted for credential access.' }
    } catch [Security.Principal.IdentityNotMappedException] { throw 'Runtime SID must resolve to a known identity.' }
}
$allowedSids = @($adminSids) + @($RuntimeReadSid) | Select-Object -Unique
function Assert-OrdinaryPath([string]$Path, [bool]$MustExist = $true) {
    $full = [IO.Path]::GetFullPath($Path)
    $part = $full
    while ($part) {
        if (Test-Path -LiteralPath $part) {
            $item = Get-Item -Force -LiteralPath $part
            if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
                # The existing host has one proved NXR junction; opt in only to its exact target.
                $approved = $ApprovedRecoveryJunctionTarget -and $item.FullName.TrimEnd('\') -eq 'D:\NXR' -and $item.LinkType -eq 'Junction' -and @($item.Target).Count -eq 1 -and [IO.Path]::GetFullPath($item.Target[0]).TrimEnd('\') -eq [IO.Path]::GetFullPath($ApprovedRecoveryJunctionTarget).TrimEnd('\') -and ($full -eq [IO.Path]::GetFullPath($RecoveryFile) -or ($IncludeDeployer -and $full -eq 'D:\NXR\secrets\agentopia-oracle.json'))
                if (-not $approved) { throw 'Reparse points are not accepted without the exact proved recovery junction target.' }
            }
        }
        $parent = Split-Path -Parent $part
        if ($parent -eq $part) { break }; $part = $parent
    }
    if ($MustExist -and -not (Test-Path -LiteralPath $full -PathType Leaf)) { throw 'An exact existing credential file is required.' }
    return $full
}
function Get-Metadata([string]$Path) {
    $acl = Get-Acl -LiteralPath $Path
    [pscustomobject]@{ Path = $Path; Owner = $acl.Owner; Protected = $acl.AreAccessRulesProtected; Sddl = $acl.Sddl; Rules = @($acl.Access | ForEach-Object {
        [pscustomobject]@{ Sid = $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value; Rights = $_.FileSystemRights.ToString(); Type = $_.AccessControlType.ToString(); Inherited = $_.IsInherited }
    }) }
}
function Set-PrivateAcl([string]$Path, [bool]$Directory = $false) {
    $acl = Get-Acl -LiteralPath $Path
    $owner = $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
    if ($owner -notin $adminSids) { throw 'Unexpected credential owner; preserve it and resolve access explicitly before hardening.' }
    # Set only DACL sections: never request SACL/owner privilege on an idempotent rerun.
    $acl = if ($Directory) { New-Object Security.AccessControl.DirectorySecurity } else { New-Object Security.AccessControl.FileSecurity }
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($sid in $allowedSids) {
        $rights = if ($sid -in $adminSids) { [Security.AccessControl.FileSystemRights]::FullControl } else { [Security.AccessControl.FileSystemRights]::Read }
        $inherit = if ($Directory) { [Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit' } else { [Security.AccessControl.InheritanceFlags]::None }
        $rule = New-Object Security.AccessControl.FileSystemAccessRule((New-Object Security.Principal.SecurityIdentifier($sid)), $rights, $inherit, [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow)
        [void]$acl.AddAccessRule($rule)
    }
    if ($Directory) { [IO.Directory]::SetAccessControl($Path, $acl) } else { [IO.File]::SetAccessControl($Path, $acl) }
    Assert-PrivateAcl $Path
}
function Assert-PrivateAcl([string]$Path) {
    $acl = Get-Acl -LiteralPath $Path
    if (-not $acl.AreAccessRulesProtected) { throw 'Credential ACL inheritance is still enabled.' }
    $rules = @($acl.Access)
    foreach ($rule in $rules) {
        $sid = $rule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value
        if ($sid -notin $allowedSids -or $rule.IsInherited -or $rule.AccessControlType -ne 'Allow') { throw 'Credential ACL contains an unexpected principal or inherited rule.' }
    }
    foreach ($sid in $adminSids) {
        if (-not ($rules | Where-Object { $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value -eq $sid -and ($_.FileSystemRights -band [Security.AccessControl.FileSystemRights]::FullControl) -eq [Security.AccessControl.FileSystemRights]::FullControl })) { throw 'Operator, SYSTEM or Administrators access was not preserved.' }
    }
}
function New-PrivateDirectory([string]$Path) {
    $full = Assert-OrdinaryPath $Path $false
    # Never change an existing unrelated folder, a drive root, user home, or project root.
    if ($full -eq [IO.Path]::GetPathRoot($full) -or $full.TrimEnd('\') -eq $env:USERPROFILE.TrimEnd('\') -or $full.TrimEnd('\') -eq [IO.Path]::GetFullPath($ProjectRoot).TrimEnd('\')) { throw 'Refusing an overbroad private-directory target.' }
    if (Test-Path -LiteralPath $full) {
        if (-not (Test-Path -LiteralPath $full -PathType Container)) { throw 'Private directory path is not a directory.' }
        Assert-PrivateAcl $full
    } else {
        [void](New-Item -ItemType Directory -Path $full)
        Set-PrivateAcl $full $true
    }
    return $full
}
function Get-Digest([byte[]]$Bytes) {
    $sha = [Security.Cryptography.SHA256]::Create()
    try { return [Convert]::ToBase64String($sha.ComputeHash($Bytes)) } finally { $sha.Dispose() }
}
function Write-NewPrivate([string]$Path, [byte[]]$Bytes) {
    $stream = [IO.File]::Open($Path, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    try { $stream.Write($Bytes, 0, $Bytes.Length); $stream.Flush($true) } finally { $stream.Dispose() }
    Set-PrivateAcl $Path
}
function Open-CredentialBackup($Entry, [string]$Directory) {
    if ($Entry.file -notmatch '^(env|runtime|recovery|deployer|snapshot-\d+)\.dpapi\.json$') { throw 'Invalid backup filename.' }
    $file = Assert-OrdinaryPath (Join-Path $Directory $Entry.file)
    Assert-PrivateAcl $file
    $envelope = [IO.File]::ReadAllText($file) | ConvertFrom-Json
    if ($envelope.format -ne 'onerub-local-credential-dpapi-v1' -or $envelope.ownerSid -ne $operatorSid -or $envelope.scope -ne 'CurrentUser') { throw 'Backup requires its original Windows user profile and DPAPI master key.' }
    $bytes = [Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String($envelope.ciphertext), $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
    if ((Get-Digest $bytes) -ne $Entry.sha256 -or $bytes.Length -ne $Entry.length) { [Array]::Clear($bytes, 0, $bytes.Length); throw 'Decrypted backup integrity failed.' }
    return ,$bytes
}
$targets = @(
    [pscustomobject]@{ id = 'env'; path = (Join-Path $ProjectRoot '.env.local') },
    [pscustomobject]@{ id = 'runtime'; path = (Join-Path $ProjectRoot '.local/marketplace-runtime-secrets.json') },
    [pscustomobject]@{ id = 'recovery'; path = $RecoveryFile }
)
if ($IncludeDeployer) { $targets += [pscustomobject]@{ id = 'deployer'; path = 'D:/NXR/secrets/agentopia-oracle.json' } }
$index = 0
foreach ($snapshot in $EncryptedSnapshotFile) {
    $full = [IO.Path]::GetFullPath($snapshot)
    if ((Split-Path -Parent $full) -ne [IO.Path]::GetFullPath((Join-Path $ProjectRoot '.local/backups')) -or (Split-Path -Leaf $full) -notmatch '^marketplace-\d+\.encrypted\.json$') { throw 'Only an exact existing project marketplace encrypted snapshot is accepted.' }
    $targets += [pscustomobject]@{ id = ('snapshot-' + $index); path = $full }; $index++
}
if ($Action -in @('Verify', 'Restore')) {
    if (-not $BackupManifest) { throw 'An explicit backup manifest is required.' }
    $manifestPath = Assert-OrdinaryPath $BackupManifest
    Assert-PrivateAcl $manifestPath
    $manifest = [IO.File]::ReadAllText($manifestPath) | ConvertFrom-Json
    if ($manifest.format -ne 'onerub-local-credential-manifest-v1' -or $manifest.ownerSid -ne $operatorSid) { throw 'Unsupported credential backup manifest.' }
    $directory = Split-Path -Parent $manifestPath
    if ($Action -eq 'Restore') {
        if (-not $RestoreId -or -not $RestoreDirectory) { throw 'Restore requires RestoreId and a NEW isolated RestoreDirectory; live originals are never overwritten.' }
        if (Test-Path -LiteralPath $RestoreDirectory) { throw 'Restore directory must not already exist.' }
        $restoreRoot = New-PrivateDirectory $RestoreDirectory
        $selected = @($manifest.entries | Where-Object { $_.id -eq $RestoreId })
        if ($selected.Count -ne 1) { throw 'Restore selection is invalid.' }
    } else { $selected = @($manifest.entries) }
    $checked = @()
    foreach ($entry in $selected) {
        $bytes = Open-CredentialBackup $entry $directory
        try {
            if ($Action -eq 'Restore') {
                $restoredPath = Join-Path $restoreRoot ($entry.id + '.restored')
                Write-NewPrivate $restoredPath $bytes
                if ((Get-FileHash -LiteralPath $restoredPath -Algorithm SHA256).Hash -ne ([BitConverter]::ToString([Convert]::FromBase64String($entry.sha256))).Replace('-', '')) { throw 'On-disk restored bytes failed verification.' }
            }
            if ($RequireOriginalMatch) {
                $original = Assert-OrdinaryPath $entry.originalPath
                Assert-PrivateAcl $original
                $originalBytes = [IO.File]::ReadAllBytes($original)
                try { if ((Get-Digest $originalBytes) -ne $entry.sha256) { throw 'Original changed since this verified backup. Create a fresh backup before migration.' } } finally { [Array]::Clear($originalBytes, 0, $originalBytes.Length) }
            }
            $checked += [pscustomobject]@{ id = $entry.id; originalPath = $entry.originalPath; hashMatched = $true; originalMatched = [bool]$RequireOriginalMatch; restored = ($Action -eq 'Restore') }
        } finally { [Array]::Clear($bytes, 0, $bytes.Length) }
    }
    [pscustomobject]@{ action = $Action; verified = $checked; originalsOverwritten = $false } | ConvertTo-Json -Depth 5
    return
}
$before = @()
foreach ($target in $targets) {
    $target.path = Assert-OrdinaryPath $target.path
    $before += Get-Metadata $target.path
}
if ($Action -eq 'Audit') {
    [pscustomobject]@{ action = $Action; operatorSid = $operatorSid; files = $before } | ConvertTo-Json -Depth 7
    return
}
# Secure the exact files first; never recurse or change their parent ACLs.
foreach ($target in $targets) { Set-PrivateAcl $target.path }
$vault = New-PrivateDirectory $VaultDirectory
$run = New-PrivateDirectory (Join-Path $vault ([Guid]::NewGuid().ToString('N')))
$entries = @()
foreach ($target in $targets) {
    $bytes = [IO.File]::ReadAllBytes($target.path)
    try {
        $digest = Get-Digest $bytes
        $cipher = [Security.Cryptography.ProtectedData]::Protect($bytes, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
        $envelope = [ordered]@{ format = 'onerub-local-credential-dpapi-v1'; scope = 'CurrentUser'; ownerSid = $operatorSid; ciphertext = [Convert]::ToBase64String($cipher) }
        $entry = [pscustomobject]@{ id = $target.id; file = ($target.id + '.dpapi.json'); originalPath = $target.path; length = $bytes.Length; sha256 = $digest }
        Write-NewPrivate (Join-Path $run $entry.file) ([Text.Encoding]::UTF8.GetBytes(($envelope | ConvertTo-Json -Compress)))
        $restored = Open-CredentialBackup $entry $run
        try { if ((Get-Digest $restored) -ne $digest) { throw 'Recovery backup roundtrip failed.' } } finally { [Array]::Clear($restored, 0, $restored.Length) }
        $entries += $entry
    } finally { [Array]::Clear($bytes, 0, $bytes.Length) }
}
$manifestPath = Join-Path $run 'manifest.json'
$manifest = [ordered]@{ format = 'onerub-local-credential-manifest-v1'; ownerSid = $operatorSid; entries = $entries; beforeAcl = $before }
Write-NewPrivate $manifestPath ([Text.Encoding]::UTF8.GetBytes(($manifest | ConvertTo-Json -Depth 8)))
# ACL metadata is non-secret. Never output hashes, secret names/values, ciphertext or decrypted bytes.
[pscustomobject]@{ action = $Action; operatorSid = $operatorSid; before = $before; after = @($targets | ForEach-Object { Get-Metadata $_.path }); backupManifest = $manifestPath; verifiedFiles = $entries.Count; originalBytesRetained = $true; encryption = 'DPAPI CurrentUser (Windows profile required)' } | ConvertTo-Json -Depth 8
