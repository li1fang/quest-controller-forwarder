param([string]$Config = '.local\lan\receiver.json', [string]$Serial, [string]$Adb = 'C:\Android\Sdk\platform-tools\adb.exe', [switch]$Install, [switch]$NoLaunch, [switch]$Plan)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
. "$PSScriptRoot\resolve-node.ps1"
$nodeExecutable = Find-QuestNode
$project = Split-Path $PSScriptRoot -Parent
Push-Location $project
try {
    # Validate without passing credentials on a command line or printing them.
    $summary = & $nodeExecutable "$project\pc\pair-lan.mjs" --config $Config
    if ($LASTEXITCODE -ne 0) { throw 'Invalid receiver pairing; nothing sent to the headset.' }
    $prepared = $summary | ConvertFrom-Json
    Write-Host "Receiver: $($prepared.endpoint)"
    Write-Host "TLS SHA-256: $($prepared.cert_sha256)"
    if ($Plan) { Write-Host 'Plan only: no ADB commands, install, file transfer or app launch.'; return }
    if (!(Test-Path -LiteralPath $Adb)) { $Adb = (Get-Command adb -ErrorAction Stop).Source }
    $devices = & $Adb devices
    if ($LASTEXITCODE -ne 0) { throw 'ADB inventory failed.' }
    $authorizedUsb = @($devices | Where-Object { $_ -match '^([^\s:]+)\s+device\s*$' -and $_ -notmatch '_adb-tls-' } | ForEach-Object { ($_ -split '\s+')[0] })
    if ($Serial) {
        if ($authorizedUsb -notcontains $Serial) { throw 'Requested device is not an authorized USB device.' }
    } elseif ($authorizedUsb.Count -eq 1) { $Serial = $authorizedUsb[0] }
    else { throw 'Connect exactly one authorized USB headset, or select -Serial. No device was modified.' }
    function Run-Adb([string[]]$Arguments) {
        & $Adb -s $Serial @Arguments
        if ($LASTEXITCODE -ne 0) { throw 'ADB pairing step failed. No existing pairing was deleted.' }
    }
    $model = (& $Adb -s $Serial shell getprop ro.product.model | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or $model -notmatch '^Quest (Pro|2|3|3S)$') { throw 'Selected USB device is not an identified Quest headset. Nothing installed or transferred.' }
    try {
        $state = Invoke-RestMethod -Uri 'http://127.0.0.1:8787/api/state' -TimeoutSec 2
        if ($state.application.id -eq 'quest-usb-monitor' -and $state.source.mode -eq 'live') {
            throw 'End the live receiver service and release keepalive before installing or pairing. Offline annotation may remain open.'
        }
    } catch [System.Net.WebException] { # No local receiver is fine; no device state is inferred from this.
    }
    $packageName = 'dev.quest.lanforwarder'
    if ($Install) {
        $apk = Join-Path $project 'dist\quest-lan-forwarder.apk'
        if (!(Test-Path -LiteralPath $apk)) { throw 'Build the universal APK first: scripts/build.ps1 -Lan' }
        Add-Type -AssemblyName System.IO.Compression.FileSystem
        $archive = [IO.Compression.ZipFile]::OpenRead($apk)
        try {
            if (@($archive.Entries | Where-Object { $_.FullName -match '(lan-config|receiver|lan-pairing)\.json$|\.(pem|key|keystore)$' }).Count -ne 0) { throw 'Personalized APK refused. Build the universal variant with build.ps1 -Lan' }
        } finally { $archive.Dispose() }
        Run-Adb @('install','-r',$apk)
    }
    $packageInfo = (& $Adb -s $Serial shell dumpsys package $packageName | Out-String)
    if ($LASTEXITCODE -ne 0 -or $packageInfo -notmatch 'versionCode=(\d+)\s' -or [int]$Matches[1] -lt 8 -or $packageInfo -notmatch 'dev\.quest\.usbforwarder\.PairingActivity') {
        throw 'Installed app does not support runtime pairing. Update with the universal APK first.'
    }
    # App-scoped external staging is read only by the setup panel, then moved to private storage after confirmation.
    $remoteDirectory = "/sdcard/Android/data/$packageName/files"
    Run-Adb @('shell','mkdir','-p',$remoteDirectory)
    Run-Adb @('push',$prepared.app_config,"$remoteDirectory/pairing-import.pending")
    Run-Adb @('shell','mv',"$remoteDirectory/pairing-import.pending","$remoteDirectory/pairing-import.json")
    if (!$NoLaunch) { Run-Adb @('shell','am','start','-n',"$packageName/dev.quest.usbforwarder.PairingActivity",'-a','dev.quest.forwarder.CONFIGURE') }
    Write-Host 'Pairing staged. Confirm the receiver and fingerprint in the headset, then select Trust and save.'
    Write-Host 'After this one-time setup, daily capture needs no PC USB or rebuild.'
} finally { Pop-Location }
