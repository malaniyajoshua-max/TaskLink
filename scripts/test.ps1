$ErrorActionPreference='Stop'
$root=Split-Path $PSScriptRoot -Parent
Push-Location (Join-Path $root 'server')
try {
    & ./.venv/Scripts/python.exe -m app.migrate; if ($LASTEXITCODE) { throw 'Migration failed' }
    & ./.venv/Scripts/python.exe -m alembic check; if ($LASTEXITCODE) { throw 'Schema drift detected' }
    & ./.venv/Scripts/python.exe -m black --check app tests alembic; if ($LASTEXITCODE) { throw 'Python formatting failed' }
    & ./.venv/Scripts/python.exe -m pytest -q; if ($LASTEXITCODE) { throw 'pytest failed' }
} finally { Pop-Location }
Push-Location (Join-Path $root 'desktop')
try {
    npm.cmd run format:check; if ($LASTEXITCODE) { throw 'Desktop formatting failed' }
    npm.cmd test; if ($LASTEXITCODE) { throw 'Vitest failed' }
    npm.cmd run build; if ($LASTEXITCODE) { throw 'Build failed' }
    npm.cmd run test:e2e; if ($LASTEXITCODE) { throw 'Electron E2E failed' }
} finally { Pop-Location }
