param([int]$UiPort = 8787)
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\env.ps1"
. "$PSScriptRoot\dialog-settings.ps1"
$project = Split-Path $PSScriptRoot -Parent
$directory = Join-Path $project '.local\dialog-test'
$null = New-Item -ItemType Directory -Path $directory -Force
$statusFile = Join-Path $directory 'status.json'
$adb = Join-Path $env:ANDROID_HOME 'platform-tools\adb.exe'
$report = [ordered]@{ phase = 'checking'; property = 'disable_dialogs'; pin_saved = $false }
function Save-Status([string]$Phase) {
    $report.phase = $Phase
    $report.updated_at_utc = [DateTime]::UtcNow.ToString('o')
    $report | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath "$statusFile.tmp" -Encoding UTF8
    Move-Item -LiteralPath "$statusFile.tmp" -Destination $statusFile -Force
}
function Get-ControllerDialog {
    $activities = & $adb -s $serial shell dumpsys activity activities 2>&1 | Out-String
    if ($LASTEXITCODE -ne 0) { throw 'Cannot inspect the controller launch dialog.' }
    return $activities -match 'topResumedActivity=.*LaunchCheckControllerRequiredDialogActivity'
}
$pin = $null
$before = $null
$writeAttempted = $false
try {
    Save-Status 'checking'
    $serial = (& $adb -d get-serialno | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or $serial -cnotmatch '^[A-Za-z0-9._:-]+$') { throw 'Connect one authorized USB headset.' }
    $before = Get-QuestTestProperties $adb $serial
    $report.before = $before
    $state = Invoke-RestMethod "http://127.0.0.1:$UiPort/api/state" -TimeoutSec 3
    if ($state.application.id -ne 'quest-usb-monitor' -or !$state.startup.managed -or $state.source.mode -ne 'live') { throw 'Start the live one-click monitor first.' }
    if ($before.disable_dialogs) { throw 'This test needs an original disable_dialogs=false value.' }
    Save-Status 'waiting_local_pin'
    $pin = Read-QuestStorePin
    # A controller may have woken while PIN entry was being prepared. Reproduce
    # the normal blocking launch before touching the property, or stay inconclusive.
    $baselineDeadline = [DateTime]::UtcNow.AddSeconds(180)
    $baselineAttempts = 0
    $lastBaselineLaunch = [DateTime]::MinValue
    $report.baseline_dialog_visible = Get-ControllerDialog
    while (!$report.baseline_dialog_visible -and [DateTime]::UtcNow -lt $baselineDeadline) {
        Save-Status 'waiting_controllers_sleep'
        $state = Invoke-RestMethod "http://127.0.0.1:$UiPort/api/state" -TimeoutSec 3
        if ($baselineAttempts -lt 3 -and ([DateTime]::UtcNow - $lastBaselineLaunch).TotalSeconds -ge 15 -and $state.frame.kind -eq 'frame' -and $state.frame.focused -and !$state.frame.left.pose_active -and !$state.frame.right.pose_active) {
            $null = & $adb -s $serial shell am start -S -a android.intent.action.MAIN -c android.intent.category.LAUNCHER -n dev.quest.usbforwarder/android.app.NativeActivity 2>&1
            $baselineAttempts++
            $lastBaselineLaunch = [DateTime]::UtcNow
        }
        Start-Sleep -Seconds 3
        $report.baseline_dialog_visible = Get-ControllerDialog
    }
    if (!$report.baseline_dialog_visible) { throw 'Inconclusive: the normal launch did not reproduce the controller dialog. No property was changed.' }
    $state = Invoke-RestMethod "http://127.0.0.1:$UiPort/api/state" -TimeoutSec 3
    $report.baseline_frame_count = $state.frame_count
    $report.baseline_has_fresh_focused_frame = [bool]($state.frame.kind -eq 'frame' -and $state.frame.focused -and ($state.server_time_ms - $state.frame_received_at_ms) -lt 1500)
    # Cancel the old check; the flag is tested against a NEW launch, not asked
    # to retroactively dismiss a dialog that was already created.
    $null = & $adb -s $serial shell input keyevent KEYCODE_BACK 2>&1
    Start-Sleep -Milliseconds 500
    $report.old_dialog_cancelled_before_write = !(Get-ControllerDialog)
    if (!$report.old_dialog_cancelled_before_write) { throw 'Inconclusive: cannot cancel the preexisting controller dialog.' }
    $null = & $adb -s $serial shell am force-stop dev.quest.usbforwarder 2>&1
    $report.fresh_launch_used = $true
    $writeAttempted = $true
    Save-Status 'applying'
    Set-QuestDialogs $adb $serial $true $pin
    $disabled = Get-QuestTestProperties $adb $serial
    $report.during = $disabled
    if (!$disabled.disable_dialogs) { throw 'disable_dialogs=true was not verified.' }
    Assert-QuestOtherProperties $before $disabled
    Save-Status 'testing_launch'
    $null = & $adb -s $serial shell am start -S -a android.intent.action.MAIN -c android.intent.category.LAUNCHER -n dev.quest.usbforwarder/android.app.NativeActivity 2>&1
    if ($LASTEXITCODE -ne 0) { throw 'App launch command failed.' }
    $deadline = [DateTime]::UtcNow.AddSeconds(35)
    $report.skipped_controller_dialog = $false
    do {
        Start-Sleep -Seconds 1
        $state = Invoke-RestMethod "http://127.0.0.1:$UiPort/api/state" -TimeoutSec 3
        $report.dialog_visible_during = Get-ControllerDialog
        $report.frame_count_during = $state.frame_count
        $report.focused_during = [bool]$state.frame.focused
        $report.left_pose_active = [bool]$state.frame.left.pose_active
        $report.right_pose_active = [bool]$state.frame.right.pose_active
        $report.skipped_controller_dialog = !$report.dialog_visible_during -and $state.transport_connected -and $state.frame.kind -eq 'frame' -and $state.frame.focused -and ($state.server_time_ms - $state.frame_received_at_ms) -lt 1500
        Save-Status 'testing_launch'
    } while (!$report.skipped_controller_dialog -and [DateTime]::UtcNow -lt $deadline)
    $report.test_result = if ($report.skipped_controller_dialog) { 'passed' } else { 'not_effective' }
} catch {
    # Never include native process command lines or raw SET_PROPERTY output.
    $report.error = $_.Exception.Message
    $report.test_result = 'failed'
} finally {
    if ($before -and $writeAttempted) {
        Save-Status 'restoring'
        try {
            $report.after = Restore-QuestDialogs $adb $serial $before $pin
            $report.original_value_restored = $true
            $report.other_properties_unchanged = $true
        } catch {
            $report.original_value_restored = $false
            $report.restore_error = $_.Exception.Message
            Save-Status 'restore_failed'
            Add-Type -AssemblyName System.Windows.Forms
            while (!$report.original_value_restored) {
                [void][System.Windows.Forms.MessageBox]::Show('Could not verify disable_dialogs restoration. Reconnect the headset, then press OK to retry. Keep this window open until the headset is connected.', 'Quest - restoration required')
                try {
                    $report.after = Restore-QuestDialogs $adb $serial $before $pin
                    $report.original_value_restored = $true
                    $report.other_properties_unchanged = $true
                } catch { $report.restore_error = $_.Exception.Message; Save-Status 'restore_failed' }
            }
        }
    }
    if ($pin) { $pin.Dispose() }
    Save-Status $(if ($report.original_value_restored -or !$writeAttempted) { 'finished' } else { 'restore_failed' })
}
