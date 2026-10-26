param([string]$InstallRoot = 'C:\Android', [switch]$AcceptSdkLicenses)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$downloads = Join-Path $InstallRoot 'downloads'
$sdk = Join-Path $InstallRoot 'Sdk'
New-Item -ItemType Directory -Force -Path $downloads, $sdk | Out-Null

function Get-Archive([string]$Url, [string]$Path, [string]$Sha256 = '') {
    if (!(Test-Path -LiteralPath $Path)) {
        & curl.exe --fail --location --silent --show-error --retry 3 --connect-timeout 30 --output $Path $Url
        if ($LASTEXITCODE -ne 0) { throw "Download failed: $Url" }
    }
    if ($Sha256 -and (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash -ne $Sha256) {
        throw "Checksum mismatch: $Path"
    }
}

$jdk = Join-Path $InstallRoot 'jdk-21'
if (!(Test-Path -LiteralPath (Join-Path $jdk 'bin\java.exe'))) {
    $metadata = Invoke-RestMethod 'https://api.adoptium.net/v3/assets/latest/21/hotspot?architecture=x64&image_type=jdk&os=windows&vendor=eclipse'
    $package = $metadata[0].binary.package
    $archive = Join-Path $downloads $package.name
    Write-Host 'Downloading verified Eclipse Temurin JDK 21...'
    Get-Archive $package.link $archive $package.checksum
    $staging = Join-Path $InstallRoot 'jdk-extract'
    Expand-Archive -LiteralPath $archive -DestinationPath $staging -Force
    $extracted = Get-ChildItem -LiteralPath $staging -Directory | Select-Object -First 1
    if (!$extracted) { throw 'JDK archive contains no directory' }
    # Both paths are direct children of the explicitly chosen installation root.
    Move-Item -LiteralPath $extracted.FullName -Destination $jdk
}
$env:JAVA_HOME = $jdk
$env:ANDROID_HOME = $sdk
$env:ANDROID_SDK_ROOT = $sdk
$env:Path = "$jdk\bin;$sdk\platform-tools;$env:Path"

$manager = Join-Path $sdk 'cmdline-tools\latest\bin\sdkmanager.bat'
if (!(Test-Path -LiteralPath $manager)) {
    $toolsArchive = Join-Path $downloads 'commandlinetools-win-15859902_latest.zip'
    Write-Host 'Downloading verified Android SDK command-line tools...'
    Get-Archive 'https://dl.google.com/android/repository/commandlinetools-win-15859902_latest.zip' $toolsArchive '90ae805d20434428bffcb699c290860f19bb5f66a67e6b330067e3de801fb04a'
    $toolsStaging = Join-Path $InstallRoot 'commandline-extract'
    Expand-Archive -LiteralPath $toolsArchive -DestinationPath $toolsStaging -Force
    New-Item -ItemType Directory -Force -Path (Join-Path $sdk 'cmdline-tools') | Out-Null
    Move-Item -LiteralPath (Join-Path $toolsStaging 'cmdline-tools') -Destination (Join-Path $sdk 'cmdline-tools\latest')
}

Write-Host 'Review Android SDK licenses, then install platform tools, build tools, SDK, NDK and CMake...'
if ($AcceptSdkLicenses) { 1..100 | ForEach-Object { 'y' } | & $manager "--sdk_root=$sdk" --licenses }
else { & $manager "--sdk_root=$sdk" --licenses }
if ($LASTEXITCODE -ne 0) { throw 'SDK license setup failed' }
& $manager "--sdk_root=$sdk" 'platform-tools' 'platforms;android-34' 'build-tools;35.0.0' 'ndk;27.2.12479018' 'cmake;3.22.1'
if ($LASTEXITCODE -ne 0) { throw 'SDK package installation failed' }

[Environment]::SetEnvironmentVariable('JAVA_HOME', $jdk, 'User')
[Environment]::SetEnvironmentVariable('ANDROID_HOME', $sdk, 'User')
[Environment]::SetEnvironmentVariable('ANDROID_SDK_ROOT', $sdk, 'User')
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
$parts = @($userPath -split ';' | Where-Object { $_ })
foreach ($entry in @("$jdk\bin", "$sdk\platform-tools", "$sdk\cmdline-tools\latest\bin")) {
    if ($parts -notcontains $entry) { $parts += $entry }
}
[Environment]::SetEnvironmentVariable('Path', ($parts -join ';'), 'User')
& "$jdk\bin\java.exe" -version
& "$sdk\platform-tools\adb.exe" version
Write-Host "Toolchain ready at $InstallRoot. New terminals inherit the user environment settings."
