$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\dialog-settings.ps1"
$passed = 0
function Assert-True($Condition, [string]$Message) { if (!$Condition) { throw $Message } }
function Assert-Throws([scriptblock]$Action, [string]$Pattern) {
    try { & $Action } catch { Assert-True ($_.Exception.Message -match $Pattern) 'Unexpected error'; return }
    throw 'Expected an error.'
}
function Pass([string]$Name) { $script:passed++; Write-Host "PASS $Name" }

$parsed = ConvertFrom-QuestTestProperties 'Result: Bundle[{disable_guardian=true, set_proximity_close=false, disable_dialogs=false, disable_autosleep=false}]'
Assert-True (!$parsed.disable_dialogs -and $parsed.disable_guardian -and !$parsed.disable_autosleep) 'Incorrect property parsing'
Assert-Throws { ConvertFrom-QuestTestProperties 'Result: Bundle[{Success=false}]' } 'does not expose'
Pass 'Reads real Bundle format and refuses an unknown property state'

# Fixed synthetic PIN fixture only; never a user credential.
$command = New-QuestDialogsCommand $true '0397'
Assert-True ($command -match "disable_dialogs:b:true" -and ([regex]::Matches($command, '--extra')).Count -eq 2) 'Unexpected write arguments'
Assert-True ($command -notmatch 'guardian|autosleep|proximity') 'Another property is present in the write'
Assert-Throws { New-QuestDialogsCommand $true 'invalid' } 'four digits'
Assert-Throws { Set-QuestDialogs 'unused' 'bad serial' $true $null } 'Invalid USB serial'
Assert-Throws { Set-QuestDialogs 'unused' 'TEST-USB' $true $null } 'locally entered'
Pass 'Writes only disable_dialogs and PIN, and rejects malformed input before spawning ADB'

# Simulated property transport: these tests never invoke a physical headset.
$script:writes = @()
$script:state = $parsed.Clone()
function Get-QuestTestProperties { return $script:state.Clone() }
function Set-QuestDialogs([string]$Adb, [string]$Serial, [bool]$Value, $Pin) {
    $script:writes += $Value
    $script:state.disable_dialogs = $Value
}
$script:state.disable_dialogs = $true
$restored = Restore-QuestDialogs 'unused' 'TEST-USB' $parsed $null
Assert-True (!$restored.disable_dialogs -and $restored.disable_guardian -and !$restored.disable_autosleep) 'Original values were not restored'
Assert-True ($script:writes.Count -eq 1 -and $script:writes[0] -eq $false) 'Wrong restoration write'
Pass 'Restores original false without touching the other properties'

$beforeTrue = $parsed.Clone(); $beforeTrue.disable_dialogs = $true
$script:state = $beforeTrue.Clone(); $script:writes = @()
$null = Restore-QuestDialogs 'unused' 'TEST-USB' $beforeTrue $null
Assert-True ($script:writes.Count -eq 0 -and $script:state.disable_dialogs) 'A preexisting true value must be preserved'
Pass 'Preserves preexisting true without a write or PIN'

$script:state = $parsed.Clone(); $script:state.disable_dialogs = $true; $script:state.disable_autosleep = $true
Assert-Throws { Restore-QuestDialogs 'unused' 'TEST-USB' $parsed $null } 'changed externally: disable_autosleep'
Assert-True $script:state.disable_autosleep 'Must not overwrite another property to hide drift'
Assert-True (!$script:state.disable_dialogs) 'Own change must still be restored on drift'
Pass 'Reports external drift after restoring its own flag'

function Get-QuestTestProperties { throw 'USB disconnected' }
Assert-Throws { Restore-QuestDialogs 'unused' 'TEST-USB' $parsed $null } 'USB disconnected'
Pass 'A disconnected headset cannot be reported as restored'
Write-Host "$passed dialog-settings tests passed."
