function Find-QuestNode {
    $nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
    $nodeCandidates = @()
    if ($nodeCommand) { $nodeCandidates += $nodeCommand.Source }
    $nodeCandidates += @(
        (Join-Path $env:ProgramFiles 'nodejs\node.exe'),
        (Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe')
    )
    foreach ($nodeCandidate in $nodeCandidates) {
        if (Test-Path -LiteralPath $nodeCandidate) {
            $nodeMajor = & $nodeCandidate -p "Number(process.versions.node.split('.')[0])"
            if ($LASTEXITCODE -eq 0 -and [int]$nodeMajor -ge 20) { return $nodeCandidate }
        }
    }
    throw 'Node.js 20+ was not found. Install Node.js or run this script in the Codex terminal.'
}
