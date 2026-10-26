$ErrorActionPreference = 'Stop'
$project = Split-Path $PSScriptRoot -Parent
. "$PSScriptRoot\resolve-node.ps1"
$nodeExecutable = Find-QuestNode
$pnpmTool = Get-Command pnpm -ErrorAction SilentlyContinue
$npmTool = Get-Command npm -ErrorAction SilentlyContinue
$nodeRoot = Split-Path (Split-Path $nodeExecutable -Parent) -Parent
$bundledPnpm = Join-Path $nodeRoot 'node_modules\pnpm\bin\pnpm.cjs'
Push-Location $project
try {
    if ($pnpmTool) { & $pnpmTool.Source install --frozen-lockfile --ignore-scripts }
    elseif (Test-Path -LiteralPath $bundledPnpm) { & $nodeExecutable $bundledPnpm install --frozen-lockfile --ignore-scripts }
    elseif ($npmTool) { & $npmTool.Source install --ignore-scripts --package-lock=false }
    else { throw 'Install pnpm or npm, then install the pinned project dependency.' }
    if ($LASTEXITCODE -ne 0) { throw "Dependency installation failed with exit code $LASTEXITCODE" }
} finally { Pop-Location }
