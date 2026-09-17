param([switch]$RequireSigned, [string]$Installer)
$ErrorActionPreference='Stop'
$projectRoot=Split-Path $PSScriptRoot -Parent
$manifest=Get-Content -LiteralPath (Join-Path $projectRoot 'desktop/package.json') -Raw | ConvertFrom-Json
if (-not $Installer) { $Installer=Join-Path $projectRoot ('desktop/release/TaskLink Setup ' + $manifest.version + '.exe') }
$installerPath=(Resolve-Path -LiteralPath $Installer).Path
$executablePath=Join-Path $projectRoot 'desktop/release/win-unpacked/TaskLink.exe'
$results=@()
foreach ($filename in @($installerPath,$executablePath)) {
  $signature=Get-AuthenticodeSignature -LiteralPath $filename
  $results += [pscustomobject]@{File=$filename;Sha256=(Get-FileHash -LiteralPath $filename -Algorithm SHA256).Hash;Signature=[string]$signature.Status;Publisher=if ($signature.SignerCertificate) {$signature.SignerCertificate.Subject} else {$null}}
}
$auditDirectory=Join-Path $projectRoot 'work/release-check'
New-Item -ItemType Directory -Path $auditDirectory -Force | Out-Null
$report=[pscustomobject]@{Version=$manifest.version;CheckedAt=(Get-Date -Format o);RequireSigned=[bool]$RequireSigned;Files=$results;PublicReleaseReady=$false}
$report | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $auditDirectory ('release-' + $manifest.version + '.json')) -Encoding UTF8
$results | Select-Object File,Signature,Sha256 | Format-List
if ($RequireSigned -and ($results | Where-Object {$_.Signature -ne 'Valid'})) {
  throw 'Formal release blocked: both executable and installer need valid trusted signatures. Local unsigned build is not a public release.'
}
Write-Host 'Local files inspected. Independently verify publisher, fuses, update flow and clean-machine acceptance before publication.'
