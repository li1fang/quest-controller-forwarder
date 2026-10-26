function Initialize-QuestPinVault {
    if ($env:OS -ne 'Windows_NT') { throw 'Saved PINs require Windows Credential Manager.' }
    if (!('QuestUsbForwarder.PinVault' -as [type])) { Add-Type -Path "$PSScriptRoot\quest-pin-vault.cs" }
}
function Get-QuestPinTarget([string]$Serial) {
    if ($Serial -cnotmatch '\A[A-Za-z0-9._:-]{1,256}\z') { throw 'Invalid device serial for PIN storage.' }
    $hash = [Security.Cryptography.SHA256]::Create()
    try { $digest = [BitConverter]::ToString($hash.ComputeHash([Text.Encoding]::UTF8.GetBytes($Serial))).Replace('-', '').ToLowerInvariant() }
    finally { $hash.Dispose() }
    return "QuestUsbForwarder/MetaStorePIN/$digest"
}
function Get-QuestStoredPin([string]$Serial) {
    $target = Get-QuestPinTarget $Serial
    Initialize-QuestPinVault
    return [QuestUsbForwarder.PinVault]::Read($target)
}
function Save-QuestStoredPin([string]$Serial, [Security.SecureString]$Pin) {
    $target = Get-QuestPinTarget $Serial
    Initialize-QuestPinVault
    [QuestUsbForwarder.PinVault]::Save($target, $Pin)
}
function Remove-QuestStoredPin([string]$Serial) {
    $target = Get-QuestPinTarget $Serial
    Initialize-QuestPinVault
    return [QuestUsbForwarder.PinVault]::Delete($target)
}
function Get-QuestDialogCredential([string]$Serial, [string]$Action = 'Start') {
    $pin = $null
    try { $pin = Get-QuestStoredPin $Serial } catch { Write-Warning 'Saved Quest PIN could not be read; enter it locally again.' }
    if ($pin) {
        Write-Host 'Using saved Store PIN from Windows Credential Manager.'
        return @{ Pin = $pin; FromStore = $true; NeedsSave = $false }
    }
    $pin = Read-QuestStorePin -ButtonText "Save + $Action" -Purpose 'Save in Windows Credential Manager after headset verification.' -Footer 'Saved encrypted for your Windows account on this PC.'
    return @{ Pin = $pin; FromStore = $false; NeedsSave = $true }
}
function Test-QuestPinRejected($ErrorRecord) {
    $exception = $ErrorRecord.Exception
    while ($exception) {
        if ($exception.Data['QuestPropertyRejected']) { return $true }
        $exception = $exception.InnerException
    }
    return $false
}
