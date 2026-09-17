$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
Push-Location (Join-Path $projectRoot 'server')
try {
    & ./.venv/Scripts/python.exe -m app.export_contract
    if ($LASTEXITCODE) { throw 'OpenAPI export failed' }
} finally { Pop-Location }
Push-Location (Join-Path $projectRoot 'desktop')
try {
    & npm.cmd run contracts
    if ($LASTEXITCODE) { throw 'Type generation failed' }
    & npm.cmd run typecheck
    if ($LASTEXITCODE) { throw 'Contract verification failed' }
} finally { Pop-Location }
