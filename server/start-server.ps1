<#
.SYNOPSIS
  Startet den optionalen lokalen TurmericLab-Server (server/server.py).

.EXAMPLE
  .\server\start-server.ps1
  .\server\start-server.ps1 -Port 8766 -NoBrowser
#>
param(
    [int]$Port = 8765,
    [string]$BindHost = '127.0.0.1',
    [switch]$NoBrowser
)

$ErrorActionPreference = 'Stop'

$python = Get-Command python -ErrorAction SilentlyContinue
if (-not $python) { $python = Get-Command py -ErrorAction SilentlyContinue }
if (-not $python) { throw 'Python wurde nicht gefunden (python oder py im PATH erforderlich).' }

$script = Join-Path $PSScriptRoot 'server.py'
$url = "http://localhost:$Port/schematics.html"

if (-not $NoBrowser) {
    # Browser kurz verzoegert oeffnen, damit der Server schon lauscht
    Start-Job -ScriptBlock { param($u) Start-Sleep -Seconds 1; Start-Process $u } -ArgumentList $url | Out-Null
}

Write-Host "Starte Server: $url (Strg+C zum Beenden)"
& $python.Source $script $Port --host $BindHost
