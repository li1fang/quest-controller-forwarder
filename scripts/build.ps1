param([string]$Sdk = 'C:\Android\Sdk', [string]$Jdk = 'C:\Android\jdk-21', [string]$LanConfig)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$project = Split-Path $PSScriptRoot -Parent
$build = Join-Path $project 'build'
$dist = Join-Path $project 'dist'
$ndk = Join-Path $Sdk 'ndk\27.2.12479018'
$cmake = Join-Path $Sdk 'cmake\3.22.1\bin\cmake.exe'
$tools = Join-Path $Sdk 'build-tools\35.0.0'
$env:JAVA_HOME = $Jdk
$env:Path = "$Jdk\bin;$env:Path"
New-Item -ItemType Directory -Force -Path $build,$dist | Out-Null

function Run([string]$Executable, [string[]]$Arguments) {
    & $Executable @Arguments
    if ($LASTEXITCODE -ne 0) { throw "Failed ($LASTEXITCODE): $Executable" }
}

$loader = Join-Path $project 'third_party\openxr'
if (!(Test-Path -LiteralPath "$loader\jni\arm64-v8a\libopenxr_loader.so")) {
    $archive = Join-Path $build 'openxr-loader-1.1.65.aar'
    Run 'curl.exe' @('--fail','--location','--silent','--show-error','--retry','3','-o',$archive,
        'https://repo.maven.apache.org/maven2/org/khronos/openxr/openxr_loader_for_android/1.1.65/openxr_loader_for_android-1.1.65.aar')
    if ((Get-FileHash $archive -Algorithm SHA256).Hash -ne 'a298c326085b09181c85235fb04d37510939bd30938ed4322c093c09780e8643') { throw 'OpenXR archive checksum mismatch' }
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [IO.Compression.ZipFile]::ExtractToDirectory($archive, $loader)
}
Run $cmake @('-S',$project,'-B',"$build\native",'-G','Ninja',
    "-DCMAKE_MAKE_PROGRAM=$Sdk/cmake/3.22.1/bin/ninja.exe", "-DCMAKE_TOOLCHAIN_FILE=$ndk/build/cmake/android.toolchain.cmake",
    '-DANDROID_ABI=arm64-v8a','-DANDROID_PLATFORM=android-29','-DANDROID_STL=c++_static','-DCMAKE_BUILD_TYPE=Release')
Run $cmake @('--build',"$build\native",'--parallel')

# A small Java helper uses Android's TLS provider; tracking remains native OpenXR.
$classes = Join-Path $build 'java-classes'
$dex = Join-Path $build 'dex'
New-Item -ItemType Directory -Force -Path $classes,$dex | Out-Null
$javaSources = @(Get-ChildItem -LiteralPath "$project\app\java" -Recurse -Filter '*.java' | ForEach-Object { $_.FullName })
Run "$Jdk\bin\javac.exe" (@('--release','8','-classpath',"$Sdk\platforms\android-34\android.jar",'-d',$classes) + $javaSources)
$javaClasses = @(Get-ChildItem -LiteralPath $classes -Recurse -Filter '*.class' | ForEach-Object { $_.FullName })
Run "$tools\d8.bat" (@('--lib',"$Sdk\platforms\android-34\android.jar",'--min-api','29','--output',$dex) + $javaClasses)
$unsigned = Join-Path $build 'quest-usb-unsigned.apk'
$aligned = Join-Path $build 'quest-usb-aligned.apk'
$apk = Join-Path $dist 'quest-usb-forwarder.apk'
$manifest = "$project\app\AndroidManifest.xml"
if ($LanConfig) {
    if (!(Test-Path -LiteralPath $LanConfig)) { throw 'LAN configuration missing. Run prepare-lan.ps1 first.' }
    $manifest = Join-Path $build 'AndroidManifest-lan.xml'
    (Get-Content -LiteralPath "$project\app\AndroidManifest.xml" -Raw).Replace('dev.quest.usbforwarder','dev.quest.lanforwarder').Replace('Quest USB Forwarder','Quest LAN Forwarder') | Set-Content -LiteralPath $manifest -Encoding UTF8
    $apk = Join-Path $dist 'quest-lan-forwarder.apk'
}
Run "$tools\aapt2.exe" @('link','--manifest',$manifest,'-I',"$Sdk\platforms\android-34\android.jar",'-o',$unsigned)
$packageRoot = Join-Path $build 'package'
$libDir = Join-Path $packageRoot 'lib\arm64-v8a'
New-Item -ItemType Directory -Force -Path $libDir | Out-Null
Copy-Item -LiteralPath "$build\native\libquest_forwarder.so" -Destination $libDir -Force
Copy-Item -LiteralPath "$loader\jni\arm64-v8a\libopenxr_loader.so" -Destination $libDir -Force
Copy-Item -LiteralPath "$dex\classes.dex" -Destination $packageRoot -Force
$legal = Join-Path $packageRoot 'META-INF'
New-Item -ItemType Directory -Force -Path $legal | Out-Null
Copy-Item -LiteralPath "$project\LICENSE" -Destination (Join-Path $legal 'LICENSE.quest.txt') -Force
Copy-Item -LiteralPath "$project\THIRD_PARTY_NOTICES.md" -Destination $legal -Force
Copy-Item -LiteralPath "$project\third_party\licenses" -Destination $legal -Recurse -Force
Push-Location $packageRoot
try {
    Run "$Jdk\bin\jar.exe" @('uf',$unsigned,'classes.dex','lib/arm64-v8a/libquest_forwarder.so','lib/arm64-v8a/libopenxr_loader.so')
    Run "$Jdk\bin\jar.exe" @('uf',$unsigned,'META-INF/LICENSE.quest.txt','META-INF/THIRD_PARTY_NOTICES.md','META-INF/licenses')
    if ($LanConfig) {
        New-Item -ItemType Directory -Force -Path (Join-Path $packageRoot 'assets') | Out-Null
        Copy-Item -LiteralPath $LanConfig -Destination (Join-Path $packageRoot 'assets\lan-config.json') -Force
        Run "$Jdk\bin\jar.exe" @('uf',$unsigned,'assets/lan-config.json')
    }
}
finally { Pop-Location }
Run "$tools\zipalign.exe" @('-f','-p','4',$unsigned,$aligned)
$key = Join-Path $build 'debug.keystore'
if (!(Test-Path -LiteralPath $key)) {
    Run "$Jdk\bin\keytool.exe" @('-genkeypair','-noprompt','-keystore',$key,'-storepass','android','-keypass','android',
        '-alias','androiddebugkey','-keyalg','RSA','-keysize','2048','-validity','10000','-dname','CN=Quest USB Development')
}
Run "$tools\apksigner.bat" @('sign','--ks',$key,'--ks-key-alias','androiddebugkey','--ks-pass','pass:android','--key-pass','pass:android','--v2-signing-enabled','true','--v3-signing-enabled','true','--out',$apk,$aligned)
Run "$tools\apksigner.bat" @('verify','--verbose',$apk)
Run "$tools\aapt2.exe" @('dump','badging',$apk)
Write-Host "Built and verified: $apk"
