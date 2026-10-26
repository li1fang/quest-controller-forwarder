param([string]$Jdk = 'C:\Android\jdk-21')
$ErrorActionPreference = 'Stop'
$project = Split-Path $PSScriptRoot -Parent
$classes = Join-Path $project 'build\pairing-policy-tests'
New-Item -ItemType Directory -Force -Path $classes | Out-Null
& "$Jdk\bin\javac.exe" --release 8 -d $classes "$project\app\java\dev\quest\usbforwarder\LanPairing.java" "$project\diagnostics\LanPairingTest.java"
if ($LASTEXITCODE -ne 0) { throw 'Pairing policy compilation failed' }
& "$Jdk\bin\java.exe" -cp $classes LanPairingTest
if ($LASTEXITCODE -ne 0) { throw 'Pairing policy failed' }
