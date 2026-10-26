param([string]$Serial)
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\env.ps1"
. "$PSScriptRoot\dialog-mode.ps1"
$project = Split-Path $PSScriptRoot -Parent
$adb = Join-Path $env:ANDROID_HOME 'platform-tools\adb.exe'
$selectedSerial = Get-QuestUsbSerial $adb $Serial
$journalPath = Get-QuestDialogJournal $project $selectedSerial
if (!(Test-Path -LiteralPath $journalPath)) { Write-Host 'No pending dialog-mode restoration.'; exit 0 }
$journal = Read-QuestDialogJournal $journalPath $selectedSerial
if (Test-QuestDialogOwner $journal) { Write-Host 'A dialog-mode session is still active. Stop capture normally; its owner will restore the setting.'; exit 0 }
Repair-QuestDialogMode $project $adb $selectedSerial
