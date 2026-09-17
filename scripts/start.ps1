param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('server', 'desktop')]
    [string]$Target
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent

if ($Target -eq 'server') {
    Push-Location (Join-Path $projectRoot 'server')
    try {
        & ./.venv/Scripts/python.exe -m app.migrate
        if ($LASTEXITCODE) { throw 'Database migration failed' }
        & ./.venv/Scripts/python.exe -m uvicorn app.main:app --host 127.0.0.1 --port 8000 --no-access-log --no-proxy-headers --limit-concurrency 64 --backlog 128 --timeout-keep-alive 5
    } finally {
        Pop-Location
    }
    exit $LASTEXITCODE
}

Push-Location (Join-Path $projectRoot 'desktop')
try {
    & npm.cmd start
} finally {
    Pop-Location
}
