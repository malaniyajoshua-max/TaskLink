param(
    [Parameter(Mandatory=$true)][string]$ValidationRoot
)
$ErrorActionPreference='Stop'
$projectRoot=(Resolve-Path -LiteralPath (Split-Path $PSScriptRoot -Parent)).Path
$workRoot=[IO.Path]::GetFullPath((Join-Path $projectRoot 'work'))
$validationPath=(Resolve-Path -LiteralPath $ValidationRoot).Path
if (-not $validationPath.StartsWith($workRoot + '\',[StringComparison]::OrdinalIgnoreCase)) {
    throw 'ValidationRoot must be inside the project work directory'
}
$appPath=(Resolve-Path -LiteralPath (Join-Path $validationPath 'app')).Path
$profilePath=(Resolve-Path -LiteralPath (Join-Path $validationPath 'profile')).Path
foreach ($target in @($validationPath,$appPath,$profilePath)) {
    if (($target -ne $validationPath -and -not $target.StartsWith($validationPath + '\',[StringComparison]::OrdinalIgnoreCase)) -or ((Get-Item -LiteralPath $target).Attributes -band [IO.FileAttributes]::ReparsePoint)) {
        throw 'Validation paths must be ordinary directories inside the test root'
    }
}
$exePath=Join-Path $appPath 'TaskLink.exe'
if (Get-Process | Where-Object { try { $_.Path -eq $exePath } catch { $false } }) {
    throw 'Close the validation application before uninstalling it'
}
# electron-builder resolves the installation from its registry entry during
# initialization. Refuse an already-unregistered installation: a retry could
# otherwise fall back to the default install directory instead of this test.
$registered=@(Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*' -ErrorAction SilentlyContinue | Where-Object {
    $_.UninstallString -and $_.UninstallString.Contains($appPath)
})
if ($registered.Count -ne 1) { throw 'Expected one registered installation at the validation path' }
function ProfileHashes {
    @(Get-ChildItem -LiteralPath $profilePath -File -Recurse | Sort-Object FullName | ForEach-Object {
        [pscustomobject]@{File=$_.FullName.Substring($profilePath.Length+1);Sha256=(Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash}
    })
}
$before=ProfileHashes
if ($before.Count -eq 0) { throw 'No profile evidence exists' }
$uninstaller=Join-Path $appPath 'Uninstall TaskLink.exe'
$runner=Join-Path $validationPath ('uninstall-runner-' + [guid]::NewGuid().ToString('N') + '.exe')
# _?= disables NSIS's automatic temporary copy. Execute an explicit copy outside
# appPath so RMDir can remove the entire installation, including its uninstaller.
# Waiting on this copy also captures the actual uninstall exit code; waiting on
# the normal launcher alone only tells us whether its temporary copy started.
# https://nsis.sourceforge.io/Docs/AppendixD.html#D.1
Copy-Item -LiteralPath $uninstaller -Destination $runner
$process=Start-Process -FilePath $runner -ArgumentList ('/S _?=' + $appPath) -WorkingDirectory $validationPath -WindowStyle Hidden -PassThru -Wait
$after=ProfileHashes
$report=[pscustomobject]@{
    CheckedAt=(Get-Date -Format o)
    ExitCode=$process.ExitCode
    ExecutableRemoved=(-not (Test-Path -LiteralPath $exePath))
    UninstallerRemoved=(-not (Test-Path -LiteralPath $uninstaller))
    PayloadRemoved=(-not (Test-Path -LiteralPath (Join-Path $appPath 'resources\app.asar')))
    ProfilePreserved=(($before | ConvertTo-Json -Compress) -eq ($after | ConvertTo-Json -Compress))
    ProfileFileCount=$after.Count
    Scope='Isolated per-user installation on the current Windows machine'
}
$report | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $validationPath 'uninstall.json') -Encoding UTF8
$report | Format-List
if ($report.ExitCode -ne 0 -or -not $report.ExecutableRemoved -or -not $report.UninstallerRemoved -or -not $report.PayloadRemoved -or -not $report.ProfilePreserved) {
    throw 'Uninstall validation failed; files and report retained'
}

