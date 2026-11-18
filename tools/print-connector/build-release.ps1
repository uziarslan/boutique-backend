param(
  [string]$Configuration = 'Release',
  [string]$CertificateThumbprint = $env:CENCISS_SIGNING_CERT_THUMBPRINT,
  [switch]$UnsignedDevelopmentBuild
)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$appProject = Join-Path $root 'app\CencissPrintConnector.csproj'
$appPublish = Join-Path $root 'app\publish'
$setupProject = Join-Path $root 'installer\CencissPrintConnectorSetup.csproj'
$setupPublish = Join-Path $root 'installer\publish'
$releaseDirectory = Join-Path $root 'release'
$releaseSetup = Join-Path $releaseDirectory 'Cenciss-Print-Connector-Setup-1.4.3.exe'
$frontendDownloads = [IO.Path]::GetFullPath((Join-Path $root '..\..\..\frontend\public\downloads'))

New-Item -ItemType Directory -Force -Path $releaseDirectory | Out-Null

dotnet publish $appProject -c $Configuration -r win-x64 --self-contained true -o $appPublish
if ($LASTEXITCODE -ne 0) { throw 'The connector application build failed.' }

$signTool = Get-Command 'signtool.exe' -ErrorAction SilentlyContinue
if (!$UnsignedDevelopmentBuild) {
  if ([string]::IsNullOrWhiteSpace($CertificateThumbprint)) {
    throw 'A production build requires CENCISS_SIGNING_CERT_THUMBPRINT. Use -UnsignedDevelopmentBuild only for local testing.'
  }
  if ($null -eq $signTool) { throw 'signtool.exe was not found. Install the Windows SDK before creating a production release.' }
  & $signTool.Source sign /sha1 $CertificateThumbprint /fd SHA256 /tr 'http://timestamp.digicert.com' /td SHA256 (Join-Path $appPublish 'CencissPrintConnector.exe')
  if ($LASTEXITCODE -ne 0) { throw 'Signing the connector application failed.' }
}

dotnet publish $setupProject -c $Configuration -r win-x64 --self-contained true -o $setupPublish -p:SkipConnectorRuntimePublish=true
if ($LASTEXITCODE -ne 0) { throw 'The connector setup build failed.' }

Copy-Item (Join-Path $setupPublish 'CencissPrintConnectorSetup.exe') $releaseSetup -Force
if (!$UnsignedDevelopmentBuild) {
  & $signTool.Source sign /sha1 $CertificateThumbprint /fd SHA256 /tr 'http://timestamp.digicert.com' /td SHA256 $releaseSetup
  if ($LASTEXITCODE -ne 0) { throw 'Signing the connector setup failed.' }
  & $signTool.Source verify /pa /all $releaseSetup
  if ($LASTEXITCODE -ne 0) { throw 'The connector setup signature could not be verified.' }
}

if (Test-Path $frontendDownloads) {
  Copy-Item $releaseSetup (Join-Path $frontendDownloads 'Cenciss-Print-Connector-Setup-1.4.3.exe') -Force
  Copy-Item $releaseSetup (Join-Path $frontendDownloads 'Cenciss-Print-Connector-Setup.exe') -Force
}

$hash = Get-FileHash $releaseSetup -Algorithm SHA256
Write-Host "Release: $releaseSetup"
Write-Host "SHA256: $($hash.Hash)"
