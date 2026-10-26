$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\dialog-mode.ps1"
$passed = 0
function Assert-True($Condition, [string]$Message) { if (!$Condition) { throw $Message } }
function Assert-Throws([scriptblock]$Action, [string]$Pattern) {
    try { & $Action } catch { Assert-True ($_.Exception.Message -match $Pattern) "Unexpected error: $($_.Exception.Message)"; return }
    throw 'Expected an error.'
}
function Pass([string]$Name) { $script:passed++; Write-Host "PASS $Name" }

# All state and credentials below are synthetic. No real ADB command or PIN UI.
$project = Join-Path ([IO.Path]::GetTempPath()) ("quest-dialog-test-" + [guid]::NewGuid().ToString('N'))
$serial = 'TEST-USB'
$journalPath = Get-QuestDialogJournal $project $serial
function Reset-Fixture {
    $script:properties = @{ disable_guardian = $true; disable_autosleep = $false; set_proximity_close = $false; disable_dialogs = $false }
    $script:writes = @(); $script:pinPrompts = 0; $script:cancelPin = $false; $script:loseReply = $false
    $script:hasStoredPin = $false; $script:pinSaves = 0; $script:rejectStored = $false; $script:pinRemovals = 0
    $script:rejectRestore = $false; $script:failSave = $false
}
function Get-QuestTestProperties { return $script:properties.Clone() }
function Set-QuestDialogs([string]$Adb, [string]$Serial, [bool]$Value, $Pin) {
    if (!$Value -and $script:rejectRestore) {
        $script:rejectRestore = $false
        $failure = New-Object System.InvalidOperationException('Simulated PIN rotation during capture')
        $failure.Data['QuestPropertyRejected'] = $true
        throw $failure
    }
    if ($Value -and $script:rejectStored) {
        $script:rejectStored = $false
        $failure = New-Object System.InvalidOperationException('Simulated stored PIN rejection')
        $failure.Data['QuestPropertyRejected'] = $true
        throw $failure
    }
    $script:writes += $Value; $script:properties.disable_dialogs = $Value
    if ($Value -and $script:loseReply) { throw 'Simulated lost reply after write' }
}
function Read-QuestStorePin {
    $script:pinPrompts++
    if ($script:cancelPin) { throw 'Simulated local cancellation' }
    return (ConvertTo-SecureString '0397' -AsPlainText -Force)
}
function Invoke-FakeAdb { $global:LASTEXITCODE = 0; return '' }
function Get-QuestStoredPin { if ($script:hasStoredPin) { return (ConvertTo-SecureString '0397' -AsPlainText -Force) } }
function Save-QuestStoredPin {
    if ($script:failSave) { throw 'Simulated vault failure' }
    $script:pinSaves++; $script:hasStoredPin = $true
}
function Remove-QuestStoredPin { $script:pinRemovals++; $script:hasStoredPin = $false; return $true }
try {
    Reset-Fixture
    Invoke-QuestDialogMode $project 'Invoke-FakeAdb' $serial {
        Assert-True $script:properties.disable_dialogs 'Flag is not enabled during capture'
        $journal = Read-QuestDialogJournal $journalPath $serial
        Assert-True ($journal.stage -eq 'running') 'Missing running journal'
        Assert-True ((Get-Content $journalPath -Raw) -notmatch '0397|SecureString|PIN') 'Credential found in journal'
    }
    Assert-True (!$script:properties.disable_dialogs -and $script:properties.disable_guardian -and !$script:properties.disable_autosleep) 'Incorrect final properties'
    Assert-True ($script:writes.Count -eq 2 -and !(Test-Path $journalPath)) 'Restoration journal was not cleared'
    Pass 'Temporary mode restores the flag and keeps a credential-free recovery journal'

    Reset-Fixture
    Assert-Throws { Invoke-QuestDialogMode $project 'Invoke-FakeAdb' $serial { throw 'Simulated capture failure' } } 'capture failure'
    Assert-True (!$script:properties.disable_dialogs -and !(Test-Path $journalPath)) 'Capture failure left the flag enabled'
    Pass 'A failing capture still restores the original value'

    Reset-Fixture; $script:cancelPin = $true
    Assert-Throws { Invoke-QuestDialogMode $project 'Invoke-FakeAdb' $serial { throw 'Must never run' } } 'cancellation'
    Assert-True ($script:writes.Count -eq 0 -and !(Test-Path $journalPath)) 'PIN cancellation caused a write'
    Pass 'Cancelling local PIN entry causes no device setting write'

    Reset-Fixture; $script:properties.disable_dialogs = $true
    Invoke-QuestDialogMode $project 'Invoke-FakeAdb' $serial {}
    Assert-True ($script:properties.disable_dialogs -and $script:writes.Count -eq 0 -and $script:pinPrompts -eq 0) 'Preexisting true should be preserved without a PIN prompt'
    Pass 'A preexisting enabled value is preserved without a new credential request'

    Reset-Fixture; $script:loseReply = $true
    Assert-Throws { Invoke-QuestDialogMode $project 'Invoke-FakeAdb' $serial {} } 'lost reply'
    Assert-True (!$script:properties.disable_dialogs -and $script:writes.Count -eq 2) 'An uncertain write was not restored'
    Pass 'A lost SET_PROPERTY reply cannot skip cleanup'

    Reset-Fixture
    $before = $script:properties.Clone(); $script:properties.disable_dialogs = $true
    Write-QuestDialogJournal $journalPath @{ schema = 1; property = 'disable_dialogs'; serial = $serial; owner_pid = -1; owner_started_ticks = 0; before = $before }
    Repair-QuestDialogMode $project 'Invoke-FakeAdb' $serial
    Assert-True (!$script:properties.disable_dialogs -and $script:pinPrompts -eq 1 -and !(Test-Path $journalPath)) 'Abandoned session was not repaired'
    Pass 'A crashed session can be restored with a new locally entered PIN'

    Reset-Fixture
    $owner = Get-Process -Id $PID
    Write-QuestDialogJournal $journalPath @{ schema = 1; property = 'disable_dialogs'; serial = $serial; owner_pid = $PID; owner_started_ticks = $owner.StartTime.ToUniversalTime().Ticks; before = $script:properties.Clone() }
    Repair-QuestDialogMode $project 'Invoke-FakeAdb' $serial
    Assert-True ($script:writes.Count -eq 0 -and $script:pinPrompts -eq 0 -and (Test-Path $journalPath)) 'An active owner was interfered with'
    Pass 'Recovery does not touch a running owner session'

    # The active-owner fixture above intentionally retained its journal.
    Remove-Item -LiteralPath $journalPath
    Reset-Fixture; $script:hasStoredPin = $true
    Invoke-QuestDialogMode $project 'Invoke-FakeAdb' $serial {}
    Assert-True ($script:pinPrompts -eq 0 -and $script:pinSaves -eq 0 -and !$script:properties.disable_dialogs) 'Saved PIN did not enable prompt-free start and restoration'
    Pass 'Saved PIN starts and restores without a local prompt'

    Reset-Fixture; $script:hasStoredPin = $true; $script:rejectStored = $true
    Invoke-QuestDialogMode $project 'Invoke-FakeAdb' $serial {}
    Assert-True ($script:pinPrompts -eq 1 -and $script:pinRemovals -eq 1 -and $script:pinSaves -eq 1 -and !$script:properties.disable_dialogs) 'Rejected cached PIN was not replaced safely'
    Pass 'A rejected saved PIN is replaced only after local input and headset acceptance'

    Reset-Fixture; $script:loseReply = $true
    Assert-Throws { Invoke-QuestDialogMode $project 'Invoke-FakeAdb' $serial {} } 'lost reply'
    Assert-True ($script:pinSaves -eq 0 -and !$script:properties.disable_dialogs) 'An unverified PIN was saved'
    Pass 'Unverified credentials are not persisted after an uncertain write'

    Reset-Fixture; $script:hasStoredPin = $true
    $before = $script:properties.Clone(); $script:properties.disable_dialogs = $true
    Write-QuestDialogJournal $journalPath @{ schema = 1; property = 'disable_dialogs'; serial = $serial; owner_pid = -1; owner_started_ticks = 0; before = $before }
    Repair-QuestDialogMode $project 'Invoke-FakeAdb' $serial
    Assert-True ($script:pinPrompts -eq 0 -and !$script:properties.disable_dialogs -and !(Test-Path $journalPath)) 'Crash recovery ignored the stored credential'
    Pass 'Abandoned settings can be restored using the saved PIN without prompting'

    Reset-Fixture; $script:failSave = $true
    Assert-Throws { Invoke-QuestDialogMode $project 'Invoke-FakeAdb' $serial { throw 'Must never run' } } 'vault failure'
    Assert-True (!$script:properties.disable_dialogs -and !(Test-Path $journalPath)) 'Vault failure left the setting enabled'
    Pass 'Credential storage failure still restores the flag before aborting startup'

    Reset-Fixture; $script:hasStoredPin = $true
    Invoke-QuestDialogMode $project 'Invoke-FakeAdb' $serial { $script:rejectRestore = $true }
    Assert-True ($script:pinPrompts -eq 1 -and $script:pinSaves -eq 1 -and !$script:properties.disable_dialogs) 'PIN rotation during restoration was not handled'
    Pass 'A PIN rotated during capture is reentered and verified for restoration'

    Reset-Fixture; $script:hasStoredPin = $true
    Invoke-QuestDialogMode $project 'Invoke-FakeAdb' $serial { $null = Remove-QuestStoredPin $serial }
    Assert-True (!$script:hasStoredPin -and $script:pinSaves -eq 0 -and !$script:properties.disable_dialogs) 'Normal cleanup must not resave a deliberately forgotten PIN'
    Pass 'Forgetting the saved PIN during capture does not prevent restoration or silently resave it'

    Reset-Fixture
    $before = $script:properties.Clone(); $script:properties.disable_dialogs = $true; $script:rejectRestore = $true
    Write-QuestDialogJournal $journalPath @{ schema = 1; property = 'disable_dialogs'; serial = $serial; owner_pid = -1; owner_started_ticks = 0; before = $before }
    Repair-QuestDialogMode $project 'Invoke-FakeAdb' $serial
    Assert-True ($script:pinPrompts -eq 2 -and $script:pinSaves -eq 1 -and !$script:properties.disable_dialogs) 'Recovery saved an older rejected credential over the verified replacement'
    Pass 'Recovery saves the verified replacement once and never overwrites it with the rejected PIN'
} finally {
    $resolved = [IO.Path]::GetFullPath($project)
    if ([IO.Path]::GetDirectoryName($resolved) -ne [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') -or [IO.Path]::GetFileName($resolved) -notlike 'quest-dialog-test-*') { throw 'Unsafe test cleanup target' }
    if (Test-Path -LiteralPath $resolved) { Remove-Item -LiteralPath $resolved -Recurse -Force }
}
Write-Host "$passed dialog-mode tests passed."
