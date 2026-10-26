param([string]$ReadOnlySerial)
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\pin-store.ps1"
if ($ReadOnlySerial) {
    if ($ReadOnlySerial -cnotmatch '\ACREDENTIAL-TEST-[a-f0-9]{32}\z') { throw 'Probe accepts synthetic test targets only.' }
    $probePin = Get-QuestStoredPin $ReadOnlySerial
    try { if (!$probePin -or $probePin.Length -ne 4) { throw 'Cross-process credential read failed.' } }
    finally { if ($probePin) { $probePin.Dispose() } }
    exit 0
}
$passed = 0
function Assert-True($Condition, [string]$Message) { if (!$Condition) { throw $Message } }
function Assert-Throws([scriptblock]$Action, [string]$Pattern) {
    try { & $Action } catch { Assert-True ($_.Exception.Message -match $Pattern) 'Unexpected error'; return }
    throw 'Expected an error.'
}
function Pass([string]$Name) { $script:passed++; Write-Host "PASS $Name" }

# Actual Windows credential API, but ONLY uniquely named synthetic test entries.
$serialA = 'CREDENTIAL-TEST-' + [guid]::NewGuid().ToString('N')
$serialB = 'CREDENTIAL-TEST-' + [guid]::NewGuid().ToString('N')
$pin = ConvertTo-SecureString '0397' -AsPlainText -Force
$loaded = $null
try {
    $targetA = Get-QuestPinTarget $serialA; $targetB = Get-QuestPinTarget $serialB
    Assert-True ($targetA -ne $targetB -and $targetA -notmatch $serialA) 'Device isolation or target hashing failed'
    Assert-Throws { Get-QuestPinTarget "bad`nserial" } 'Invalid device serial'
    Pass 'Device-specific target names are hashed and validated'

    Assert-True ($null -eq (Get-QuestStoredPin $serialA)) 'Unique test credential should not exist'
    Save-QuestStoredPin $serialA $pin
    $loaded = Get-QuestStoredPin $serialA
    Assert-True ($loaded -is [Security.SecureString] -and $loaded.Length -eq 4 -and $loaded.IsReadOnly()) 'Credential read did not return a protected value'
    # Compare the synthetic fixture entirely in memory; print no secret values.
    $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($loaded)
    try { Assert-True ([Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer) -ceq '0397') 'Round trip failed' }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }
    Pass 'Windows Credential Manager round-trips a SecureString including its leading zero'

    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $PSCommandPath -ReadOnlySerial $serialA
    Assert-True ($LASTEXITCODE -eq 0) 'A new PowerShell process could not read the saved synthetic credential'
    Pass 'A separate Windows process can reuse the saved credential without a prompt'

    Assert-True ($null -eq (Get-QuestStoredPin $serialB)) 'Credential leaked to a different headset target'
    $names = [QuestUsbForwarder.PinVault]::Targets()
    Assert-True ($names -contains $targetA -and $names -notcontains $targetB) 'App-scoped enumeration failed'
    $again = Get-QuestStoredPin $serialA
    try { Assert-True ($again.Length -eq 4) 'Clearing temporary native buffers altered the stored entry' } finally { $again.Dispose() }
    Pass 'Another device cannot accidentally select this PIN; enumeration returns names only'

    Assert-Throws { [QuestUsbForwarder.PinVault]::Read('UnrelatedApplication/Password') } 'app-owned'
    Assert-Throws { [QuestUsbForwarder.PinVault]::Delete('UnrelatedApplication/Password') } 'app-owned'
    Assert-Throws { [QuestUsbForwarder.PinVault]::Read($targetA + "`n") } 'app-owned'
    Pass 'Native helper refuses unrelated credential targets and malformed suffixes'

    Assert-True (Remove-QuestStoredPin $serialA) 'Delete failed'
    Assert-True ($null -eq (Get-QuestStoredPin $serialA)) 'Deleted credential still returned'
    Assert-True (!(Remove-QuestStoredPin $serialA)) 'Deleting an absent credential should be harmless'
    Pass 'Forgetting a credential removes only its app-owned device target'
} finally {
    $null = Remove-QuestStoredPin $serialA
    $null = Remove-QuestStoredPin $serialB
    if ($loaded) { $loaded.Dispose() }
    $pin.Dispose()
}
Write-Host "$passed pin-store tests passed."
