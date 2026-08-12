<#
.SYNOPSIS
  Baut ngspice mit der Shared-Library-Schnittstelle nach WebAssembly (lokal,
  via Docker) und legt die Artefakte fuer den Echtzeit-PoC bereit.

.DESCRIPTION
  Spiegelt exakt die Schritte aus .github/workflows/build-ngspice-wasm.yml,
  laeuft aber lokal ueber Docker Desktop, ohne GitHub-Actions-Lauf abzuwarten.
  Details/Hintergrund: POC-ECHTZEIT-NGSPICE.md.

  Ergebnis: poc/spice-shared.mjs + poc/spice-shared.wasm
  (genau die Dateien, die ngspice-rt-poc.html per <input id="mjs"> erwartet).

.PARAMETER NgspiceRef
  Git-Tag/Branch im Mirror danchitnis/ngspice-sf-mirror. Default: ngspice-44.2

.PARAMETER EmsdkVersion
  Emscripten-SDK-Version, muss mit dem Basisimage-Tag im Dockerfile
  uebereinstimmen. Default: 3.1.61

.PARAMETER NoCache
  Erzwingt einen Docker-Build ohne Layer-Cache (frischer Quellcode-Clone etc.).

.EXAMPLE
  ./build-ngspice-wasm.ps1

.EXAMPLE
  ./build-ngspice-wasm.ps1 -NgspiceRef ngspice-43 -NoCache
#>

[CmdletBinding()]
param(
  [string]$NgspiceRef = "ngspice-44.2",
  [string]$EmsdkVersion = "3.1.61",
  [switch]$NoCache
)

$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$DockerfilePath = Join-Path $ScriptDir "Dockerfile.ngspice-wasm"
$ImageTag = "ngspice-wasm-shared:local"
$ContainerName = "ngspice-wasm-extract-$([guid]::NewGuid().ToString('N').Substring(0,8))"
$OutDir = Join-Path $ScriptDir "wasm-out"

function Assert-DockerAvailable {
  $null = Get-Command docker -ErrorAction SilentlyContinue
  if (-not $?) {
    throw "Docker wurde nicht gefunden. Docker Desktop installieren/starten und erneut versuchen."
  }
  try {
    docker info *> $null
  } catch {
    throw "Docker daemon nicht erreichbar. Ist Docker Desktop gestartet?"
  }
}

Write-Host "== ngspice WASM Build (lokal via Docker) ==" -ForegroundColor Cyan
Write-Host "ngspice ref     : $NgspiceRef"
Write-Host "emscripten      : $EmsdkVersion"
Write-Host "Dockerfile      : $DockerfilePath"
Write-Host ""

Assert-DockerAvailable

if (-not (Test-Path $DockerfilePath)) {
  throw "Dockerfile nicht gefunden: $DockerfilePath"
}

# ---- Build -----------------------------------------------------------
$buildArgs = @(
  "build"
  "-f", $DockerfilePath
  "--build-arg", "NGSPICE_REF=$NgspiceRef"
  "--build-arg", "EMSDK_VERSION=$EmsdkVersion"
  "-t", $ImageTag
)
if ($NoCache) { $buildArgs += "--no-cache" }
$buildArgs += $ScriptDir   # Build-Context: poc/

Write-Host "-- docker build --" -ForegroundColor Yellow
& docker @buildArgs
if ($LASTEXITCODE -ne 0) {
  throw "docker build fehlgeschlagen (Exit-Code $LASTEXITCODE). Siehe Ausgabe oben; haeufigste Ursache: ngspice-Tag/Emscripten-Version-Kombination baut nicht sauber (siehe POC-ECHTZEIT-NGSPICE.md, Abschnitt 8.3)."
}

# ---- Artefakte extrahieren ---------------------------------------------
Write-Host ""
Write-Host "-- Artefakte extrahieren --" -ForegroundColor Yellow

# Aufraeumen, falls ein vorheriger Lauf abgebrochen ist.
docker rm -f $ContainerName *> $null

& docker create --name $ContainerName $ImageTag bash | Out-Null
if ($LASTEXITCODE -ne 0) { throw "docker create fehlgeschlagen (Exit-Code $LASTEXITCODE)." }

if (Test-Path $OutDir) { Remove-Item -Recurse -Force $OutDir }
& docker cp "${ContainerName}:/wasm-out" $OutDir
if ($LASTEXITCODE -ne 0) {
  docker rm -f $ContainerName *> $null
  throw "docker cp fehlgeschlagen (Exit-Code $LASTEXITCODE)."
}
docker rm -f $ContainerName *> $null

# ---- Artefakte an den Ort kopieren, den ngspice-rt-poc.html erwartet ---
$mjsSrc = Join-Path $OutDir "spice-shared.mjs"
$wasmSrc = Join-Path $OutDir "spice-shared.wasm"
if (-not (Test-Path $mjsSrc) -or -not (Test-Path $wasmSrc)) {
  throw "Erwartete Artefakte fehlen in $OutDir (spice-shared.mjs / .wasm)."
}
Copy-Item $mjsSrc (Join-Path $ScriptDir "spice-shared.mjs") -Force
Copy-Item $wasmSrc (Join-Path $ScriptDir "spice-shared.wasm") -Force

Write-Host ""
Write-Host "== Fertig ==" -ForegroundColor Green
Write-Host "Artefakte liegen in: $ScriptDir"
Write-Host "  - spice-shared.mjs"
Write-Host "  - spice-shared.wasm"
Write-Host ""
Write-Host "Naechster Schritt: aus $ScriptDir einen lokalen Webserver starten" -ForegroundColor Cyan
Write-Host "  (WASM/ES-Module/Worker brauchen http(s), nicht file://):"
Write-Host "    python -m http.server -d `"$ScriptDir`" 8000"
Write-Host "  dann im Browser oeffnen:"
Write-Host "    http://localhost:8000/ngspice-rt-poc.html"
