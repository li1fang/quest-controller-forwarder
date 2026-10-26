. "$PSScriptRoot\dialog-settings.ps1"
. "$PSScriptRoot\pin-store.ps1"

function Get-QuestUsbSerial([string]$Adb, [string]$RequestedSerial) {
    if (!$Adb -or !(Test-Path -LiteralPath $Adb)) { throw 'ADB was not found.' }
    $serial = (& $Adb -d get-serialno 2>&1 | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or $serial -cnotmatch '^[A-Za-z0-9._:-]+$') { throw 'Connect one authorized USB headset before enabling dialog mode.' }
    if ($RequestedSerial -and $RequestedSerial -ne $serial) { throw 'The selected serial is not the physical USB headset.' }
    return $serial
}

function Get-QuestDialogJournal([string]$Project, [string]$Serial) {
    $safeName = $Serial -replace '[^A-Za-z0-9._-]', '_'
    return Join-Path $Project ".local\dialog-mode\$safeName.json"
}

function Test-QuestDialogOwner($Journal) {
    try {
        $owner = Get-Process -Id $Journal.owner_pid -ErrorAction Stop
        return $owner.StartTime.ToUniversalTime().Ticks -eq $Journal.owner_started_ticks
    } catch { return $false }
}

function Write-QuestDialogJournal([string]$Path, $Journal) {
    $null = New-Item -ItemType Directory -Path (Split-Path $Path -Parent) -Force
    $Journal | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath "$Path.tmp" -Encoding UTF8
    Move-Item -LiteralPath "$Path.tmp" -Destination $Path -Force
}

function Read-QuestDialogJournal([string]$Path, [string]$Serial) {
    $journal = Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
    if ($journal.schema -ne 1 -or $journal.property -ne 'disable_dialogs' -or $journal.serial -ne $Serial -or $journal.before.disable_dialogs -isnot [bool]) {
        throw 'Invalid dialog restoration journal. No property was written.'
    }
    return $journal
}

function Complete-QuestDialogRestore([string]$Adb, [string]$Serial, $Before, [System.Security.SecureString]$Pin, [string]$JournalPath, [bool]$SaveVerifiedPin = $false) {
    $replacement = $null
    $activePin = $Pin
    try {
    while ($true) {
        try {
            $current = Get-QuestTestProperties $Adb $Serial
            if ($current.disable_dialogs -ne $Before.disable_dialogs) { Set-QuestDialogs $Adb $Serial $Before.disable_dialogs $activePin }
            $after = Get-QuestTestProperties $Adb $Serial
            if ($after.disable_dialogs -ne $Before.disable_dialogs) { throw 'Restoration was not verified.' }
            # Other settings may have been changed by their owner while capture ran.
            # Report such drift; never overwrite an unrelated setting to hide it.
            try { Assert-QuestOtherProperties $Before $after } catch { Write-Warning $_.Exception.Message }
            if ($replacement) {
                try { Save-QuestStoredPin $Serial $replacement.Pin } catch { Write-Warning 'Setting restored, but the replacement PIN could not be saved.' }
            } elseif ($SaveVerifiedPin -and $activePin) {
                try { Save-QuestStoredPin $Serial $activePin } catch { Write-Warning 'Setting restored, but the verified PIN could not be saved.' }
            }
            if (Test-Path -LiteralPath $JournalPath) { Remove-Item -LiteralPath $JournalPath }
            Write-Host "Restored disable_dialogs=$($Before.disable_dialogs.ToString().ToLowerInvariant())."
            return
        } catch {
            if (Test-QuestPinRejected $_) {
                $null = Remove-QuestStoredPin $Serial
                if ($replacement) { $replacement.Pin.Dispose() }
                Write-Warning 'The Store PIN was rejected while restoring. Enter the current PIN locally.'
                $replacement = Get-QuestDialogCredential $Serial 'Restore'
                $activePin = $replacement.Pin
                continue
            }
            Write-Warning 'Could not verify disable_dialogs restoration. The recovery journal is retained.'
            Add-Type -AssemblyName System.Windows.Forms
            [void][System.Windows.Forms.MessageBox]::Show('Reconnect the same USB headset, then press OK to retry restoring disable_dialogs. The original value is recorded locally; the PIN stays only in memory.', 'Quest - restoration required')
        }
    }
    } finally { if ($replacement) { $replacement.Pin.Dispose() } }
}

function Repair-QuestDialogMode([string]$Project, [string]$Adb, [string]$Serial) {
    $journalPath = Get-QuestDialogJournal $Project $Serial
    if (!(Test-Path -LiteralPath $journalPath)) { return }
    $journal = Read-QuestDialogJournal $journalPath $Serial
    if (Test-QuestDialogOwner $journal) { return }
    $before = @{}
    foreach ($property in $journal.before.PSObject.Properties) { $before[$property.Name] = $property.Value }
    $pin = $null
    $credential = $null
    try {
        $current = Get-QuestTestProperties $Adb $Serial
        if ($current.disable_dialogs -ne $before.disable_dialogs) {
            Write-Host 'Restoring the original value from a previous dialog-mode run.'
            $credential = Get-QuestDialogCredential $Serial 'Restore'
            $pin = $credential.Pin
        }
        Complete-QuestDialogRestore $Adb $Serial $before $pin $journalPath ([bool]($credential -and $credential.NeedsSave))
    } finally { if ($pin) { $pin.Dispose() } }
}

function Invoke-QuestDialogMode([string]$Project, [string]$Adb, [string]$Serial, [scriptblock]$Run) {
    $mutex = New-Object System.Threading.Mutex($false, "Local\QuestUsbDialogs-$Serial")
    $owned = $false
    $pin = $null
    $credential = $null
    $before = $null
    $writeAttempted = $false
    $journalPath = Get-QuestDialogJournal $Project $Serial
    try {
        try { $owned = $mutex.WaitOne(0) } catch [System.Threading.AbandonedMutexException] { $owned = $true }
        if (!$owned) { Write-Host 'A dialog-mode launch is already in progress. Use its existing window.'; return }
        Repair-QuestDialogMode $Project $Adb $Serial
        $before = Get-QuestTestProperties $Adb $Serial
        if (!$before.disable_dialogs) { $credential = Get-QuestDialogCredential $Serial; $pin = $credential.Pin }
        $owner = Get-Process -Id $PID
        $journal = [ordered]@{ schema = 1; property = 'disable_dialogs'; serial = $Serial; owner_pid = $PID;
            owner_started_ticks = $owner.StartTime.ToUniversalTime().Ticks; before = $before; stage = 'applying' }
        Write-QuestDialogJournal $journalPath $journal
        $writeAttempted = $true
        if (!$before.disable_dialogs) {
            try { Set-QuestDialogs $Adb $Serial $true $pin }
            catch {
                if (!$credential.FromStore -or !(Test-QuestPinRejected $_)) { throw }
                $null = Remove-QuestStoredPin $Serial
                $pin.Dispose(); $pin = $null
                Write-Warning 'Saved Store PIN was rejected. Enter the current PIN locally.'
                $credential = Get-QuestDialogCredential $Serial
                $pin = $credential.Pin
                Set-QuestDialogs $Adb $Serial $true $pin
            }
        }
        $during = Get-QuestTestProperties $Adb $Serial
        if (!$during.disable_dialogs) { throw 'Could not verify disable_dialogs=true.' }
        Assert-QuestOtherProperties $before $during
        if ($credential -and $credential.NeedsSave) {
            Save-QuestStoredPin $Serial $pin
            Write-Host 'Verified PIN saved in Windows Credential Manager for future launches.'
        }
        # Cancel only the previously identified controller-required check. The
        # setting prevents a NEW check; it does not dismiss an existing one.
        $activities = & $Adb -s $Serial shell dumpsys activity activities 2>&1 | Out-String
        if ($LASTEXITCODE -ne 0) { throw 'Cannot inspect the controller check.' }
        if ($activities -match 'topResumedActivity=.*LaunchCheckControllerRequiredDialogActivity') {
            $null = & $Adb -s $Serial shell input keyevent KEYCODE_BACK 2>&1
            if ($LASTEXITCODE -ne 0) { throw 'Cannot cancel the old controller check.' }
            Start-Sleep -Milliseconds 500
            $activities = & $Adb -s $Serial shell dumpsys activity activities 2>&1 | Out-String
            if ($activities -match 'topResumedActivity=.*LaunchCheckControllerRequiredDialogActivity') { throw 'Old controller check is still open.' }
        }
        $journal.stage = 'running'
        Write-QuestDialogJournal $journalPath $journal
        Write-Host 'Temporary dialog mode enabled. It will be restored when capture stops.'
        & $Run
    } finally {
        try {
            if ($writeAttempted) { Complete-QuestDialogRestore $Adb $Serial $before $pin $journalPath }
        } finally {
            if ($pin) { $pin.Dispose() }
            if ($owned) { $mutex.ReleaseMutex() }
            $mutex.Dispose()
        }
    }
}
