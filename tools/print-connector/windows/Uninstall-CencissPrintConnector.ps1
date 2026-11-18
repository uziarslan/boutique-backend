$ErrorActionPreference = 'SilentlyContinue'
$TaskName = 'Cenciss Print Connector'
$InstallDir = "$env:ProgramData\Cenciss\PrintConnector"
Stop-ScheduledTask -TaskName $TaskName
Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
& netsh http delete urlacl url=http://127.0.0.1:17873/ | Out-Null
Remove-Item $InstallDir -Recurse -Force
Write-Host 'Cenciss Print Connector removed.' -ForegroundColor Green
