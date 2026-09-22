<#
Starts the Phone Backup Server production stack with Docker Desktop.

Run from PowerShell after Docker Desktop reports that it is running:
    .\start-docker-server.ps1
#>

[CmdletBinding()]
param(
    [switch]$NoBuild
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$projectRoot = $PSScriptRoot
Set-Location $projectRoot

function Require-Command([string]$Name, [string]$Hint) {
    if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
        throw "$Name was not found. $Hint"
    }
}

Require-Command docker 'Install and start Docker Desktop, then open a new PowerShell window.'

try {
    docker info *> $null
} catch {
    throw 'Docker Desktop is installed but its engine is not running. Start Docker Desktop and wait until it says it is running.'
}

if (-not (Test-Path '.env')) {
    throw 'Missing .env. Copy .env.example to .env and replace all placeholder secrets before starting the server.'
}

$apiKeyLine = Get-Content '.env' | Where-Object { $_ -match '^API_KEY=.+$' } | Select-Object -First 1
if (-not $apiKeyLine) {
    throw 'The .env file does not contain API_KEY.'
}

$apiKey = $apiKeyLine.Substring('API_KEY='.Length)
if ($apiKey -match '^replace-with-') {
    throw 'Replace the API_KEY placeholder in .env with a long random secret before starting the server.'
}

Require-Command python 'Install Python 3.10 or newer and ensure it is on PATH.'
& python scripts/sync_version.py
if ($LASTEXITCODE -ne 0) { throw 'Version synchronization failed.' }

$composeArgs = @('compose', 'up', '-d')
if (-not $NoBuild) { $composeArgs += '--build' }
& docker @composeArgs
if ($LASTEXITCODE -ne 0) { throw 'Docker Compose could not start the server stack.' }

Write-Host 'Waiting for the API to become healthy...'
$headers = @{ Authorization = "Bearer $apiKey" }
$healthy = $false
for ($attempt = 1; $attempt -le 36; $attempt++) {
    try {
        $ping = Invoke-RestMethod -Headers $headers -Uri 'http://127.0.0.1/ping' -TimeoutSec 5
        $healthy = $true
        break
    } catch {
        Start-Sleep -Seconds 5
    }
}

& docker compose ps
if (-not $healthy) {
    Write-Error 'The stack started, but the API did not become healthy within three minutes. Run: docker compose logs --follow api'
    exit 1
}

Write-Host "Phone Backup Server is running (version $($ping.version)) at http://localhost/" -ForegroundColor Green
Write-Host 'To inspect it later: docker compose ps'
Write-Host 'To follow API logs: docker compose logs --follow api'
Write-Host 'To stop without deleting data: docker compose down'
