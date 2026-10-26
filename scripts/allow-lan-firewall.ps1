# Run as Administrator once, only if the independent device-to-PC probe times out.
param([string]$HostAddress, [string]$RemoteSubnet, [int]$Port = 19428)
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\resolve-node.ps1"
$nodeExecutable = Find-QuestNode
if (!$HostAddress) {
    $config = Join-Path (Split-Path $PSScriptRoot -Parent) '.local\lan\receiver.json'
    if (!(Test-Path -LiteralPath $config)) { throw 'Prepare LAN pairing first or pass -HostAddress and -RemoteSubnet.' }
    $HostAddress = (Get-Content -LiteralPath $config -Raw | ConvertFrom-Json).host
}
$interface = Get-NetIPAddress -IPAddress $HostAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue | Select-Object -First 1
if (!$interface) { throw 'This IPv4 is not assigned to the computer.' }
if (!$RemoteSubnet) {
    if ($interface.PrefixLength -ne 24) { throw 'Automatic firewall setup supports /24 networks only. Inspect the network and supply an appropriate scoped rule manually.' }
    $RemoteSubnet = (($HostAddress -split '\.')[0..2] -join '.') + '.0/24'
}
if ($HostAddress -notmatch '^(10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.)' -or $Port -ne 19428 -or $RemoteSubnet -notmatch '^(10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.)\d{1,3}(\.\d{1,3}){0,2}/24$') { throw 'Private IPv4, private /24 subnet and port 19428 required.' }
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (!$isAdmin) { throw 'Use Run as Administrator. Windows requires elevation to add an inbound firewall rule.' }
$name = 'Quest-LAN-TLS-19428'
$existing = Get-NetFirewallRule -Name $name -ErrorAction SilentlyContinue
if ($existing) { throw 'Quest LAN rule already exists; inspect it before making changes.' }
New-NetFirewallRule -Name $name -DisplayName 'Quest LAN TLS (local subnet, TCP 19428)' -Direction Inbound -Action Allow -Protocol TCP -LocalPort $Port -LocalAddress $HostAddress -RemoteAddress $RemoteSubnet -Program $nodeExecutable -Profile Any | Out-Null
Write-Host "Allowed only $HostAddress`:$Port from $RemoteSubnet for the configured Node executable."
Write-Host 'To remove: Remove-NetFirewallRule -Name Quest-LAN-TLS-19428 (Administrator).'
