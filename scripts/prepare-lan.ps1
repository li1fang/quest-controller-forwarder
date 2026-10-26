param([Parameter(Mandatory=$true)][string]$HostAddress, [string]$Directory = '.local\lan')
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\resolve-node.ps1"
$nodeExecutable = Find-QuestNode
$project = Split-Path $PSScriptRoot -Parent
$openssl = Join-Path $env:ProgramFiles 'Git\usr\bin\openssl.exe'
if (!(Test-Path -LiteralPath $openssl)) { $openssl = (Get-Command openssl -ErrorAction Stop).Source }
Push-Location $project
try {
    $result = & $nodeExecutable "$project\pc\prepare-lan.mjs" $HostAddress $Directory $openssl
    if ($LASTEXITCODE -ne 0) { throw 'LAN pairing preparation failed.' }
    $prepared = $result | ConvertFrom-Json
    # Current Windows account only. Do not print the pairing token or server key.
    $accountSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    & icacls.exe $prepared.directory /inheritance:r /grant:r "*$($accountSid):(OI)(CI)F" '*S-1-5-18:(OI)(CI)F' /Q
    if ($LASTEXITCODE -ne 0) { throw 'Could not restrict LAN pairing directory permissions.' }
    & "$PSScriptRoot\build.ps1" -LanConfig $prepared.appConfig
} finally { Pop-Location }
