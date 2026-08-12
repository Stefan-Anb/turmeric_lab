<#
.SYNOPSIS
  Startet einen einfachen lokalen Webserver fuer den poc/-Ordner, damit
  ngspice-rt-poc.html im Browser getestet werden kann (WASM/ES-Module/Worker
  brauchen http(s), file:// funktioniert nicht).

.DESCRIPTION
  Reiner PowerShell-Server (System.Net.HttpListener), keine externen
  Abhaengigkeiten (kein Python noetig). Serviert alle Dateien aus diesem
  Ordner (poc/) mit den richtigen Content-Types - insbesondere wichtig fuer
  .mjs (text/javascript) und .wasm (application/wasm), da manche Browser bei
  falschem Content-Type das WASM-Modul ablehnen.

.PARAMETER Port
  TCP-Port, Default 8000.

.PARAMETER NoBrowser
  Oeffnet den Browser NICHT automatisch.

.EXAMPLE
  ./serve-poc.ps1

.EXAMPLE
  ./serve-poc.ps1 -Port 9000 -NoBrowser
#>

[CmdletBinding()]
param(
  [int]$Port = 8000,
  [switch]$NoBrowser
)

$ErrorActionPreference = "Stop"
$RootDir = Split-Path -Parent $MyInvocation.MyCommand.Path

$MimeTypes = @{
  ".html" = "text/html; charset=utf-8"
  ".htm"  = "text/html; charset=utf-8"
  ".js"   = "text/javascript; charset=utf-8"
  ".mjs"  = "text/javascript; charset=utf-8"
  ".wasm" = "application/wasm"
  ".json" = "application/json; charset=utf-8"
  ".css"  = "text/css; charset=utf-8"
  ".map"  = "application/json; charset=utf-8"
  ".svg"  = "image/svg+xml"
  ".png"  = "image/png"
  ".ico"  = "image/x-icon"
  ".txt"  = "text/plain; charset=utf-8"
}

function Get-ContentType([string]$Path) {
  $ext = [System.IO.Path]::GetExtension($Path).ToLowerInvariant()
  if ($MimeTypes.ContainsKey($ext)) { return $MimeTypes[$ext] }
  return "application/octet-stream"
}

$prefix = "http://localhost:$Port/"
$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add($prefix)

try {
  $listener.Start()
} catch {
  throw "Konnte nicht auf $prefix lauschen (Port belegt oder Berechtigung fehlt): $($_.Exception.Message)"
}

Write-Host "== ngspice PoC Webserver ==" -ForegroundColor Cyan
Write-Host "Wurzelverzeichnis: $RootDir"
Write-Host "URL:               ${prefix}ngspice-rt-poc.html" -ForegroundColor Green
Write-Host "Beenden mit Strg+C"
Write-Host ""

if (-not $NoBrowser) {
  Start-Process "${prefix}ngspice-rt-poc.html"
}

try {
  while ($listener.IsListening) {
    $context = $listener.GetContext()
    $request = $context.Request
    $response = $context.Response

    # Kein Caching, damit Aenderungen an den Dateien sofort sichtbar sind.
    $response.Headers.Add("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
    $response.Headers.Add("Pragma", "no-cache")

    $urlPath = [System.Uri]::UnescapeDataString($request.Url.AbsolutePath)
    if ($urlPath -eq "/") { $urlPath = "/ngspice-rt-poc.html" }

    # Traversal-Schutz: aufgeloester Pfad muss unterhalb von $RootDir liegen.
    $relativePath = $urlPath.TrimStart("/") -replace "/", [System.IO.Path]::DirectorySeparatorChar
    $filePath = [System.IO.Path]::GetFullPath((Join-Path $RootDir $relativePath))

    $status = 200
    if (-not $filePath.StartsWith([System.IO.Path]::GetFullPath($RootDir), [System.StringComparison]::OrdinalIgnoreCase)) {
      $status = 403
    } elseif (-not (Test-Path $filePath -PathType Leaf)) {
      $status = 404
    }

    if ($status -ne 200) {
      $response.StatusCode = $status
      $msg = [System.Text.Encoding]::UTF8.GetBytes("$status")
      $response.ContentLength64 = $msg.Length
      $response.OutputStream.Write($msg, 0, $msg.Length)
      Write-Host "$status  $urlPath" -ForegroundColor DarkYellow
    } else {
      $bytes = [System.IO.File]::ReadAllBytes($filePath)
      $response.ContentType = Get-ContentType $filePath
      $response.ContentLength64 = $bytes.Length
      $response.OutputStream.Write($bytes, 0, $bytes.Length)
      Write-Host "200  $urlPath" -ForegroundColor DarkGray
    }
    $response.OutputStream.Close()
  }
} finally {
  $listener.Stop()
  $listener.Close()
}
