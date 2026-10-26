$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\env.ps1"
. "$PSScriptRoot\resolve-node.ps1"
$nodeExecutable = Find-QuestNode
$project = Split-Path $PSScriptRoot -Parent
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding
Push-Location $project
try {
    if (!(Test-Path -LiteralPath "$project\node_modules\three\build\three.module.js")) { & "$PSScriptRoot\install-web-deps.ps1" }
    $dialogMode = $args -contains '--disable-dialogs'
    $launchArguments = @($args | Where-Object { $_ -ne '--disable-dialogs' })
    if ($launchArguments -contains '--help' -or $launchArguments -contains '-h') { Write-Host 'Windows option: --disable-dialogs (local Store PIN, restored on stop).' }
    $runMonitor = {
        & $nodeExecutable "$project\pc\start.mjs" @launchArguments
        if ($LASTEXITCODE -ne 0) { throw "Quest viewer exited with code $LASTEXITCODE" }
    }.GetNewClosure()
    if ($dialogMode -and $launchArguments -notcontains '--help' -and $launchArguments -notcontains '-h') {
        $configurationText = & $nodeExecutable "$project\pc\launch-config.mjs" @launchArguments
        if ($LASTEXITCODE -ne 0) { throw 'Invalid launch options.' }
        $configuration = $configurationText | ConvertFrom-Json
        if ($configuration.wifi) { throw 'Wi-Fi validation does not support --disable-dialogs. Store PIN operations remain USB-only.' }
        $uiPort = if ($configuration.'ui-port') { $configuration.'ui-port' } else { 8787 }
        $existing = $null
        try { $existing = Invoke-RestMethod "http://127.0.0.1:$uiPort/api/state" -TimeoutSec 2 } catch {}
        if ($existing.application.id -eq 'quest-usb-monitor' -and $existing.startup.managed -and $existing.source.mode -eq 'live') {
            Write-Host 'Reusing existing capture without changing its dialog mode. Stop it first to change modes.'
            & $runMonitor
        } else {
            . "$PSScriptRoot\dialog-mode.ps1"
            $serial = Get-QuestUsbSerial $configuration.adb $configuration.serial
            Invoke-QuestDialogMode $project $configuration.adb $serial $runMonitor
        }
    } else { & $runMonitor }
} finally { Pop-Location }
