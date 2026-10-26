$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\resolve-node.ps1"
$nodeExecutable = Find-QuestNode
$project = Split-Path $PSScriptRoot -Parent
Push-Location $project
try {
    & $nodeExecutable "$project\pc\start-lan.mjs" @args
    if ($LASTEXITCODE -ne 0) { throw "LAN receiver failed ($LASTEXITCODE)." }
} finally { Pop-Location }
