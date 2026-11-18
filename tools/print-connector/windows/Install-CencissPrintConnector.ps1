param(
  [string]$KeyOutputPath = (Join-Path ([Environment]::GetFolderPath('Desktop')) 'Cenciss Connector Key.txt')
)

$ErrorActionPreference = 'Stop'
$InstallDir = "$env:ProgramData\Cenciss\PrintConnector"
$TaskName = 'Cenciss Print Connector'

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
if (!$principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Start-Process powershell.exe -Verb RunAs -ArgumentList "-ExecutionPolicy Bypass -File `"$PSCommandPath`" -KeyOutputPath `"$KeyOutputPath`""
  exit
}

# Printer queues can be installed only for the signed-in POS user. When a
# standard Windows user enters separate Administrator credentials at the UAC
# prompt, the elevated installer identity is not that POS user. Bind the task
# and URL reservation to the interactive user so Get-Printer sees the same
# queues that Windows shows in Settings.
$interactiveUser = [string](Get-CimInstance Win32_ComputerSystem).UserName
if ([string]::IsNullOrWhiteSpace($interactiveUser)) {
  $interactiveUser = "$env:USERDOMAIN\$env:USERNAME"
}

New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
Copy-Item (Join-Path $PSScriptRoot 'CencissPrintConnector.ps1') (Join-Path $InstallDir 'CencissPrintConnector.ps1') -Force
# A limited interactive user needs write access for connector.log and read
# access to config.json. Limit the ACL grant to this connector directory.
& icacls $InstallDir /grant "${interactiveUser}:(OI)(CI)M" /T /C | Out-Null

$existingConfigPath = Join-Path $InstallDir 'config.json'
$existingConfig = $null
$secret = $null
if (Test-Path $existingConfigPath) {
  try {
    $existingConfig = Get-Content $existingConfigPath -Raw | ConvertFrom-Json
    $secret = [string]$existingConfig.secret
  } catch {
    $existingConfig = $null
    $secret = $null
  }
}
if ([string]::IsNullOrWhiteSpace($secret)) {
  $secretBytes = New-Object byte[] 24
  [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($secretBytes)
  $secret = [Convert]::ToBase64String($secretBytes)
}
$newConfig = [ordered]@{
  secret = $secret
  installedAt = (Get-Date).ToString('o')
}
# Preserve the station pairing when upgrading the connector. Regenerating the
# local connector key must not silently disconnect reception from cloud orders.
if ($null -ne $existingConfig) {
  foreach ($name in @('apiBase', 'stationToken', 'cloudConfiguredAt', 'lastCloudPollAt', 'lastCloudSuccessAt', 'lastCloudError')) {
    if ($existingConfig.PSObject.Properties.Name -contains $name) {
      $newConfig[$name] = $existingConfig.$name
    }
  }
}
$newConfig | ConvertTo-Json -Depth 8 | Set-Content (Join-Path $InstallDir 'config.json') -Encoding UTF8

# HttpListener requires a one-time local URL reservation. This grants only the
# signed-in Windows user permission to host the loopback connector endpoint.
& netsh http delete urlacl url=http://127.0.0.1:17873/ 2>$null | Out-Null
& netsh http add urlacl url=http://127.0.0.1:17873/ user="$interactiveUser" | Out-Null

$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$InstallDir\CencissPrintConnector.ps1`""
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $interactiveUser
$taskPrincipal = New-ScheduledTaskPrincipal -UserId $interactiveUser -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero)
Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
Get-CimInstance Win32_Process -Filter "Name = 'powershell.exe'" | Where-Object {
  [string]$_.CommandLine -like "*$InstallDir\CencissPrintConnector.ps1*"
} | ForEach-Object {
  Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
}
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $taskPrincipal -Settings $settings -Description 'Windows printer bridge and cloud kitchen-ticket worker for Cenciss POS.' -Force | Out-Null
Start-ScheduledTask -TaskName $TaskName

$keyFile = $KeyOutputPath
$secret | Set-Content $keyFile -Encoding UTF8

# Do not report a successful installation while an old process is still
# serving a different key, or while the new task failed to start. This request
# also proves that printer enumeration works under the task's user account.
$verified = $false
$verificationError = 'Connector did not start.'
$printerResult = $null
for ($attempt = 1; $attempt -le 20; $attempt++) {
  try {
    $printerResult = Invoke-RestMethod -Uri 'http://127.0.0.1:17873/printers' -Headers @{ 'X-Cenciss-Connector-Key' = $secret } -TimeoutSec 2
    $verified = [bool]$printerResult.ok
    if ($verified) { break }
  } catch {
    $verificationError = $_.Exception.Message
    Start-Sleep -Milliseconds 500
  }
}
if (!$verified) {
  $logDetail = ''
  $logPath = Join-Path $InstallDir 'connector.log'
  if (Test-Path $logPath) {
    $logDetail = "`n`nConnector log:`n" + ((Get-Content $logPath -Tail 8) -join "`n")
  }
  throw "The connector was installed but failed its key/printer self-check: $verificationError$logDetail"
}

$printerNames = @($printerResult.printers | ForEach-Object { [string]$_.name } | Where-Object { $_ })
Write-Host 'Cenciss Print Connector installed and started.' -ForegroundColor Green
Write-Host "Running as Windows user: $interactiveUser"
Write-Host "Windows printers found: $($printerNames.Count)"
if ($printerNames.Count -gt 0) {
  Write-Host ($printerNames -join ', ')
} else {
  Write-Host 'No printers are visible to this Windows user. Add/test the printer in Windows Settings, then run this installer again.'
}
Write-Host "Connector key saved to: $keyFile"
