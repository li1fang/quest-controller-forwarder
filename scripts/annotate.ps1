$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\resolve-node.ps1"
$nodeExecutable = Find-QuestNode
$project = Split-Path $PSScriptRoot -Parent
Push-Location $project
try {
    & $nodeExecutable "$project\pc\annotation-server.mjs" @args
    if ($LASTEXITCODE -ne 0) { throw "Annotation workspace failed ($LASTEXITCODE)." }
} finally { Pop-Location }
