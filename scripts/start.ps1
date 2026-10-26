$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\env.ps1"
$project = Split-Path $PSScriptRoot -Parent
Push-Location $project
try {
    & node "$project\pc\usb.mjs" @args
    if ($LASTEXITCODE -ne 0) { throw "USB forwarder exited with code $LASTEXITCODE" }
} finally { Pop-Location }
