param([switch]$UseMirror)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
Push-Location $projectRoot
try {
    & node --version
    if ($LASTEXITCODE) { throw 'Install Node.js 24 first' }
    & python --version
    if ($LASTEXITCODE) { throw 'Install Python 3.13 first' }
    if (-not (Test-Path -LiteralPath 'server/.venv/Scripts/python.exe')) {
        & python -m venv server/.venv
        if ($LASTEXITCODE) { throw 'Python environment creation failed' }
    }
    & ./server/.venv/Scripts/python.exe -m pip install --upgrade pip==26.2
    if ($LASTEXITCODE) { throw 'Python package manager upgrade failed' }
    & ./server/.venv/Scripts/python.exe -m pip install -r server/requirements.lock.txt
    if ($LASTEXITCODE) { throw 'Python dependency installation failed' }
    Push-Location server
    try {
        & ./.venv/Scripts/python.exe -m app.migrate
        if ($LASTEXITCODE) { throw 'Database migration failed' }
    } finally { Pop-Location }
    Push-Location desktop
    $previousElectronMirror = $env:ELECTRON_MIRROR
    try {
        if ($UseMirror) { $env:ELECTRON_MIRROR = 'https://cdn.npmmirror.com/binaries/electron/' }
        & npm.cmd ci
        if ($LASTEXITCODE) { throw 'Desktop dependency installation failed' }
        & node node_modules/electron/install.js
        if ($LASTEXITCODE) { throw 'Electron runtime download failed' }
        & npm.cmd run build
        if ($LASTEXITCODE) { throw 'Desktop production build failed' }
    } finally {
        $env:ELECTRON_MIRROR = $previousElectronMirror
        Pop-Location
    }
    Write-Host 'Ready. Configure TLS SMTP as described in docs/DEPLOYMENT.md to send email verification codes.'
    Write-Host 'Then run scripts/start.ps1 -Target server and scripts/start.ps1 -Target desktop in two terminals.'
    Write-Host 'Choose Register account and request a verification code from the app. No invitation code is required.'
} finally { Pop-Location }
