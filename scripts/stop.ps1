param([string]$Serial, [int]$UiPort = 8787)
$ErrorActionPreference = 'Stop'
$monitorState = $null
try {
    $monitorState = Invoke-RestMethod "http://127.0.0.1:$UiPort/api/state" -TimeoutSec 2
} catch { # Fall back to the standalone forwarder's cleanup when no managed server is available.
}
if ($monitorState -and $monitorState.application.id -eq 'quest-usb-monitor' -and $monitorState.startup.managed -and $monitorState.controls.can_stop -and (!$Serial -or $monitorState.startup.device_serial -eq $Serial)) {
    $null = Invoke-RestMethod "http://127.0.0.1:$UiPort/api/stop" -Method Post -Headers @{ 'X-Quest-Token' = $monitorState.controls.token } -TimeoutSec 3
    Write-Host 'Requested managed monitor shutdown and device cleanup.'
    exit 0
}
. "$PSScriptRoot\env.ps1"
[string[]]$adbTargetArguments = @('-d')
if ($Serial) { $adbTargetArguments = @('-s', $Serial) }
$adbExecutable = Join-Path $env:ANDROID_HOME 'platform-tools\adb.exe'
function Invoke-StopAdb([string[]]$CommandArguments) {
    & $adbExecutable @adbTargetArguments @CommandArguments
    if ($LASTEXITCODE -ne 0) { throw "ADB cleanup failed with exit code $LASTEXITCODE" }
}
Invoke-StopAdb @('shell', 'am', 'force-stop', 'dev.quest.usbforwarder')
Invoke-StopAdb @('shell', 'am', 'broadcast', '-a', 'com.oculus.vrpowermanager.automation_disable')
$mappings = & $adbExecutable @adbTargetArguments reverse --list
if ($LASTEXITCODE -ne 0) { throw 'Unable to inspect USB forwarding mappings' }
if ($mappings -match '\btcp:19427\s+tcp:19427\b') { Invoke-StopAdb @('reverse', '--remove', 'tcp:19427') }
Write-Host 'Stopped the app, requested normal proximity behavior and cleaned up the USB forwarding mapping.'
. "$PSScriptRoot\dialog-mode.ps1"
$selectedSerial = (& $adbExecutable @adbTargetArguments get-serialno | Out-String).Trim()
if ($LASTEXITCODE -eq 0 -and $selectedSerial -cmatch '^[A-Za-z0-9._:-]+$') {
    $project = Split-Path $PSScriptRoot -Parent
    Repair-QuestDialogMode $project $adbExecutable $selectedSerial
}
