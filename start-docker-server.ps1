<#
Starts the Phone Backup Server production stack with Docker Desktop.

The stack includes an interactive app API and an isolated sync/upload API.
Nginx path-routes phone uploads so feed/reels/library stay responsive during sync.

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

function Get-ContainerHealthByName([string]$ContainerName) {
    try {
        $health = (& docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' $ContainerName 2>$null | Out-String).Trim()
        if (-not $health) { return 'missing' }
        return $health.ToLowerInvariant()
    } catch {
        return 'missing'
    }
}

function Test-ServiceHealthy([string]$ServiceName, [string]$ContainerName) {
    # Prefer fixed container names (stable across Compose versions on Windows).
    $health = Get-ContainerHealthByName $ContainerName
    if ($health -eq 'missing' -or $health -eq 'unknown') {
        try {
            $raw = & docker compose ps --format json $ServiceName 2>$null
            if ($raw) {
                $line = @($raw | Where-Object { $_ -and $_.Trim() } | Select-Object -First 1)
                if ($line) {
                    $row = $line | ConvertFrom-Json
                    if ($row.Health) { $health = ([string]$row.Health).ToLowerInvariant() }
                    elseif ($row.State) { $health = ([string]$row.State).ToLowerInvariant() }
                }
            }
        } catch {
            # keep prior health
        }
    }
    return @('healthy', 'running') -contains $health
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

Write-Host 'Waiting for app-api, sync-api, and nginx to become ready...'
$headers = @{ Authorization = "Bearer $apiKey" }
$healthy = $false
$ping = $null
for ($attempt = 1; $attempt -le 36; $attempt++) {
    $apiOk = Test-ServiceHealthy 'api' 'backup_api'
    $syncOk = Test-ServiceHealthy 'sync_api' 'backup_sync_api'
    $nginxOk = Test-ServiceHealthy 'nginx' 'backup_nginx'
    try {
        $ping = Invoke-RestMethod -Headers $headers -Uri 'http://127.0.0.1/ping' -TimeoutSec 5
        $pingOk = ($ping.status -eq 'ok')
    } catch {
        $pingOk = $false
    }

    if ($apiOk -and $syncOk -and $nginxOk -and $pingOk) {
        $healthy = $true
        break
    }
    Start-Sleep -Seconds 5
}

& docker compose ps
if (-not $healthy) {
    Write-Error @'
The stack started, but app-api / sync-api / nginx did not become healthy within three minutes.
Inspect logs with:
  docker compose logs --follow api sync_api nginx
'@
    exit 1
}

# Soft check: sync surface should answer through nginx path routing.
try {
    $syncProbe = Invoke-WebRequest -UseBasicParsing -Headers $headers -Uri 'http://127.0.0.1/files/check' -Method POST `
        -ContentType 'application/json' -Body '{"device_id":"health-probe","files":[]}' -TimeoutSec 5
    $role = $syncProbe.Headers['X-Service-Role']
    if ($role -and ($role -ne 'sync')) {
        Write-Warning "Expected X-Service-Role=sync for /files/check, got '$role'. Check nginx routing."
    }
} catch {
    # 401/403 still prove nginx reached sync-api; connection failures are the real problem.
    $statusCode = $null
    try { $statusCode = [int]$_.Exception.Response.StatusCode } catch { }
    if (-not $statusCode) {
        Write-Warning 'Could not reach /files/check through nginx. Sync uploads may be unavailable — check: docker compose logs sync_api nginx'
    }
}

Write-Host "Phone Backup Server is running (version $($ping.version)) at http://localhost/" -ForegroundColor Green
Write-Host 'Sync uploads are isolated on sync_api; feed/reels/library use app-api.'
Write-Host 'To inspect it later: docker compose ps'
Write-Host 'To follow API logs: docker compose logs --follow api sync_api'
Write-Host 'To stop without deleting data: docker compose down'
