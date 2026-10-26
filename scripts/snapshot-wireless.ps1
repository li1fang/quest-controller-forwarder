param(
    [Parameter(Mandatory=$true)][ValidatePattern('^[A-Za-z0-9._-]+$')][string]$Serial,
    [ValidatePattern('^[A-Za-z0-9._:-]+$')][string]$Target,
    [ValidatePattern('^[A-Za-z0-9_-]+$')][string]$Label = 'snapshot',
    [ValidateSet('unknown','table','dock')][string]$Placement = 'unknown',
    [string]$Adb = 'C:\Android\Sdk\platform-tools\adb.exe',
    [switch]$JsonOnly
)
$ErrorActionPreference = 'Stop'
if (!$Target) { $Target = $Serial }
if (!(Test-Path -LiteralPath $Adb)) { throw 'ADB executable not found.' }

function Read-QuestDiagnostic([string[]]$DeviceArgs, [bool]$Unbound = $false) {
    $process = New-Object System.Diagnostics.Process
    try {
        $process.StartInfo.FileName = $Adb
        $prefix = if ($Unbound) { @() } else { @('-s', $Target) }
        $process.StartInfo.Arguments = (@($prefix) + $DeviceArgs) -join ' '
        $process.StartInfo.UseShellExecute = $false
        $process.StartInfo.CreateNoWindow = $true
        $process.StartInfo.RedirectStandardOutput = $true
        $process.StartInfo.RedirectStandardError = $true
        [void]$process.Start()
        $stdout = $process.StandardOutput.ReadToEndAsync()
        $stderr = $process.StandardError.ReadToEndAsync()
        if (!$process.WaitForExit(6000)) { $process.Kill(); throw 'Diagnostic ADB command timed out.' }
        if ($process.ExitCode -ne 0) { throw "Diagnostic ADB command failed: $($stderr.GetAwaiter().GetResult().Trim())" }
        return $stdout.GetAwaiter().GetResult().Trim()
    } finally { $process.Dispose() }
}
function Get-DiagnosticHash([string]$Value) {
    if (!$Value) { return $null }
    $hash = [System.Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($hash.ComputeHash([Text.Encoding]::UTF8.GetBytes($Value)))).Replace('-', '').ToLowerInvariant() }
    finally { $hash.Dispose() }
}

$physical = Read-QuestDiagnostic @('shell','getprop','ro.serialno')
if ($physical -cne $Serial) { throw 'Headset identity mismatch. No diagnostic snapshot saved.' }
$wifi = Read-QuestDiagnostic @('shell','cmd','wifi','status')
$scan = Read-QuestDiagnostic @('shell','cmd','wifi','list-scan-results')
# Filter in memory. Never save or print the ADB dump, which also contains host keys.
$adbDump = Read-QuestDiagnostic @('shell','dumpsys','adb')
$battery = Read-QuestDiagnostic @('shell','dumpsys','battery')
$power = Read-QuestDiagnostic @('shell','dumpsys','power')
$activities = Read-QuestDiagnostic @('shell','dumpsys','activity','activities')
$bssid = [regex]::Match($wifi, '(?i)BSSID:\s*([0-9a-f:]{17})').Groups[1].Value.ToLowerInvariant()
$ssid = [regex]::Match($wifi, 'SSID:\s*"([^"]*)"').Groups[1].Value
$frequency = [regex]::Match($wifi, 'Frequency:\s*(\d+)MHz').Groups[1].Value
$trusted = @([regex]::Matches($adbDump, '<wifiAP\s+bssid="([0-9a-fA-F:]{17})"') | ForEach-Object { $_.Groups[1].Value.ToLowerInvariant() })
$storeVisible = $adbDump -match '<keyStore'
$trustedAps = @($trusted | ForEach-Object {
    $address = $_
    $entry = [regex]::Match($scan, '(?im)^\s*' + [regex]::Escape($address) + '\s+(\d+)\s+')
    [ordered]@{ bssid_sha256=(Get-DiagnosticHash $address); observed_frequency_mhz=$(if ($entry.Success) { [int]$entry.Groups[1].Value } else { $null }) }
})
$supply = [ordered]@{}
foreach ($kind in @('AC','USB','Wireless','Dock')) {
    $value = [regex]::Match($battery, $kind + ' powered:\s*(true|false)')
    $supply[$kind.ToLowerInvariant()] = if ($value.Success) { $value.Groups[1].Value -eq 'true' } else { $null }
}
$snapshot = [ordered]@{
    checked_at_utc=(Get-Date).ToUniversalTime().ToString('o'); label=$Label; device_serial=$physical; adb_target=$Target
    placement_user_reported=$Placement
    boot_id=(Read-QuestDiagnostic @('shell','cat','/proc/sys/kernel/random/boot_id'))
    boot_completed=(Read-QuestDiagnostic @('shell','getprop','sys.boot_completed'))
    uptime=(Read-QuestDiagnostic @('shell','cat','/proc/uptime'))
    wifi=[ordered]@{
        connected=($wifi -match 'Supplicant state:\s*COMPLETED'); ssid_sha256=(Get-DiagnosticHash $ssid)
        bssid_sha256=(Get-DiagnosticHash $bssid); frequency_mhz=$(if ($frequency) { [int]$frequency } else { $null })
        adb_trust_store_visible=$storeVisible
        current_ap_in_adb_trust_store=$(if ($storeVisible -and $bssid) { $trusted -contains $bssid } else { $null })
        trusted_aps=$trustedAps
    }
    power=[ordered]@{
        reported_supply=$supply
        battery_percent=[regex]::Match($battery,'(?m)^\s*level:\s*(\d+)').Groups[1].Value
        wakefulness=[regex]::Match($power,'mWakefulness=(\w+)').Groups[1].Value
        last_sleep_reason=[regex]::Match($power,'mLastSleepReason=(\w+)').Groups[1].Value
    }
    adb_wifi_enabled=(Read-QuestDiagnostic @('shell','settings','get','global','adb_wifi_enabled'))
    mdns_services=@((Read-QuestDiagnostic @('mdns','services') $true) -split '\r?\n' | Where-Object { $_ -match [regex]::Escape($Serial) } | ForEach-Object { $_.Trim() })
    wifi_confirmation_activity_present=($activities -match 'ActivityRecord\{[^\r\n]*WifiDebuggingAlertActivity')
    controller_confirmation_activity_present=($activities -match 'ActivityRecord\{[^\r\n]*LaunchCheckControllerRequiredDialogActivity')
    activities_of_interest=@($activities -split '\r?\n' | Where-Object { $_ -match 'topResumedActivity=.*(WifiDebuggingAlertActivity|LaunchCheckControllerRequiredDialogActivity)' } | ForEach-Object { $_.Trim() })
}
$project = Split-Path $PSScriptRoot -Parent
$directory = Join-Path $project '.local\wireless-diagnostics'
$null = New-Item -ItemType Directory -Path $directory -Force
$path = Join-Path $directory ((Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssfffZ') + '-' + $Label + '.json')
$snapshot | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $path -Encoding UTF8
if (!$JsonOnly) { Write-Host "Read-only snapshot saved: $path" }
$snapshot | ConvertTo-Json -Depth 10
