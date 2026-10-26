param([string]$Serial)
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\pin-store.ps1"
if ($Serial) {
    $removed = [int](Remove-QuestStoredPin $Serial)
} else {
    Initialize-QuestPinVault
    $removed = 0
    foreach ($target in [QuestUsbForwarder.PinVault]::Targets()) {
        if ([QuestUsbForwarder.PinVault]::Delete($target)) { $removed++ }
    }
}
Write-Host "Removed $removed saved Quest PIN credential(s) for this Windows user. The next launch will ask for a PIN."
