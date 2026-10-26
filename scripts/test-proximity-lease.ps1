param([string]$Jdk = 'C:\Android\jdk-21')
$ErrorActionPreference = 'Stop'
$project = Split-Path $PSScriptRoot -Parent
$classes = Join-Path $project 'build\proximity-policy-tests'
New-Item -ItemType Directory -Force -Path $classes | Out-Null
& "$Jdk\bin\javac.exe" --release 8 -d $classes "$project\app\java\dev\quest\usbforwarder\ProximityLease.java" "$project\diagnostics\ProximityLeaseTest.java"
if ($LASTEXITCODE -ne 0) { throw 'Policy test compilation failed' }
& "$Jdk\bin\java.exe" -cp $classes ProximityLeaseTest
if ($LASTEXITCODE -ne 0) { throw 'Policy tests failed' }
