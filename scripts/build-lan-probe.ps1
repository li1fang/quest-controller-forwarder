param([string]$Sdk = 'C:\Android\Sdk', [string]$Jdk = 'C:\Android\jdk-21')
$ErrorActionPreference = 'Stop'
$project = Split-Path $PSScriptRoot -Parent
$probe = Join-Path $project 'build\lan-probe'
New-Item -ItemType Directory -Force -Path "$probe\classes","$probe\dex" | Out-Null
$env:JAVA_HOME = $Jdk
$javaSources = @(Get-ChildItem -LiteralPath "$project\app\java" -Recurse -Filter '*.java' | ForEach-Object { $_.FullName })
& "$Jdk\bin\javac.exe" --release 8 -classpath "$Sdk\platforms\android-34\android.jar" -d "$probe\classes" @javaSources "$project\diagnostics\LanTlsProbe.java"
if ($LASTEXITCODE -ne 0) { throw 'Probe javac failed.' }
$classes = @(Get-ChildItem -LiteralPath "$probe\classes" -Recurse -Filter '*.class' | ForEach-Object { $_.FullName })
& "$Sdk\build-tools\35.0.0\d8.bat" --lib "$Sdk\platforms\android-34\android.jar" --min-api 29 --output "$probe\dex" @classes
if ($LASTEXITCODE -ne 0) { throw 'Probe DEX build failed.' }
Write-Host "Probe ready: $probe\dex\classes.dex"
