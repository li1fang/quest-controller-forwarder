param(
    [Parameter(Mandatory=$true)][ValidatePattern('^[A-Za-z0-9._-]+$')][string]$Serial,
    [string]$Adb = 'C:\Android\Sdk\platform-tools\adb.exe'
)
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\env.ps1"
$project = Split-Path $PSScriptRoot -Parent
$suffix = [Guid]::NewGuid().ToString('N')
$remoteProbe = "/data/local/tmp/quest-adb-xml-probe-$suffix.dex"
if ($remoteProbe -cnotmatch '^/data/local/tmp/quest-adb-xml-probe-[0-9a-f]{32}\.dex$') { throw 'Unsafe temporary probe path.' }
$work = Join-Path $project ".local\firmware-probes\$suffix"
$null = New-Item -ItemType Directory -Path "$work\classes","$work\dex" -Force
$pushed = $false

function Invoke-ProbeAdb([string[]]$DeviceArgs, [int]$Timeout = 6000) {
    $process = New-Object System.Diagnostics.Process
    try {
        $process.StartInfo.FileName = $Adb
        $arguments = @('-s',$Serial)+$DeviceArgs | ForEach-Object {
            if ($_.Contains('"')) { throw 'Unexpected quote in diagnostic argument.' }
            if ($_ -match '\s') { '"' + $_ + '"' } else { $_ }
        }
        $process.StartInfo.Arguments = $arguments -join ' '
        $process.StartInfo.UseShellExecute = $false
        $process.StartInfo.CreateNoWindow = $true
        $process.StartInfo.RedirectStandardOutput = $true
        $process.StartInfo.RedirectStandardError = $true
        $null = $process.Start()
        $stdout = $process.StandardOutput.ReadToEndAsync()
        $stderr = $process.StandardError.ReadToEndAsync()
        if (!$process.WaitForExit($Timeout)) { $process.Kill(); throw 'Probe ADB command timed out.' }
        if ($process.ExitCode -ne 0) { throw 'Probe ADB command failed; no permission elevation attempted.' }
        return $stdout.GetAwaiter().GetResult().Trim()
    } finally { $process.Dispose() }
}

try {
    if ((Invoke-ProbeAdb @('shell','getprop','ro.serialno')) -cne $Serial) { throw 'Physical headset identity mismatch.' }
    $beforeWifi = Invoke-ProbeAdb @('shell','settings','get','global','adb_wifi_enabled')
    $beforeBinary = Invoke-ProbeAdb @('shell','getprop','persist.sys.binary_xml')
    $servicesHash = (Invoke-ProbeAdb @('shell','sha256sum','/system/framework/services.jar')).Split(' ')[0]
    & "$env:JAVA_HOME\bin\javac.exe" --release 8 -Xlint:-options -classpath "$env:ANDROID_HOME\platforms\android-34\android.jar" -d "$work\classes" "$project\diagnostics\AdbXmlParserProbe.java"
    if ($LASTEXITCODE -ne 0) { throw 'Probe Java compilation failed.' }
    & "$env:ANDROID_HOME\build-tools\35.0.0\d8.bat" --min-api 34 --lib "$env:ANDROID_HOME\platforms\android-34\android.jar" --output "$work\dex" "$work\classes\AdbXmlParserProbe.class"
    if ($LASTEXITCODE -ne 0) { throw 'Probe DEX compilation failed.' }
    # ADB writes normal copy progress to stderr. Inspect the exit code through
    # Process rather than PowerShell's NativeCommandError handling.
    $pushed = $true
    $null = Invoke-ProbeAdb @('push',"$work\dex\classes.dex",$remoteProbe) 10000
    $null = Invoke-ProbeAdb @('shell','chmod','0444',$remoteProbe)
    $text = Invoke-ProbeAdb @('shell',"CLASSPATH=$($remoteProbe):/system/framework/services.jar",'app_process','/system/bin','AdbXmlParserProbe') 15000
    $line = @($text -split '\r?\n' | Where-Object { $_.StartsWith('QUEST_XML_PROBE=') })[-1]
    if (!$line) { throw 'Probe returned no structured result.' }
    $result = $line.Substring('QUEST_XML_PROBE='.Length) | ConvertFrom-Json
    $result | Add-Member -NotePropertyName device_serial -NotePropertyValue $Serial
    $result | Add-Member -NotePropertyName firmware_services_sha256 -NotePropertyValue $servicesHash
    $result | Add-Member -NotePropertyName build_incremental -NotePropertyValue (Invoke-ProbeAdb @('shell','getprop','ro.build.version.incremental'))
    $result | Add-Member -NotePropertyName observer_checked_at_utc -NotePropertyValue (Get-Date).ToUniversalTime().ToString('o')
    $result | Add-Member -NotePropertyName adb_wifi_enabled_before -NotePropertyValue $beforeWifi
    $result | Add-Member -NotePropertyName adb_wifi_enabled_after -NotePropertyValue (Invoke-ProbeAdb @('shell','settings','get','global','adb_wifi_enabled'))
    $result | Add-Member -NotePropertyName binary_xml_setting_before -NotePropertyValue $beforeBinary
    $result | Add-Member -NotePropertyName binary_xml_setting_after -NotePropertyValue (Invoke-ProbeAdb @('shell','getprop','persist.sys.binary_xml'))
    $result | ConvertTo-Json -Depth 14 | Set-Content "$work\result.json" -Encoding UTF8
    $result | ConvertTo-Json -Depth 14
    Write-Host "Local result: $work\result.json"
} finally {
    if ($pushed) {
        try { $null = Invoke-ProbeAdb @('shell','rm','-f',$remoteProbe) }
        catch { Write-Warning "Temporary probe cleanup not verified: $remoteProbe" }
    }
}
