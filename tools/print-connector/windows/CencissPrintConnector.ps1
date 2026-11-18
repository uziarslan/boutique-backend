param(
  [string]$InstallDir = "$env:ProgramData\Cenciss\PrintConnector"
)

$ErrorActionPreference = 'Stop'
$Port = 17873
$ConfigPath = Join-Path $InstallDir 'config.json'
$CompletedJobsPath = Join-Path $InstallDir 'completed-jobs.json'
$LogPath = Join-Path $InstallDir 'connector.log'
$CloudPollSeconds = 1

Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Net.Http

$script:CloudHttpClient = New-Object System.Net.Http.HttpClient
$script:CloudHttpClient.Timeout = [TimeSpan]::FromSeconds(35)
$script:CloudClaimTask = $null
$script:CloudClaimRequest = $null

function Write-Log([string]$Message) {
  $line = "$(Get-Date -Format o) $Message"
  Add-Content -Path $LogPath -Value $line -Encoding UTF8
}

if (!(Test-Path $ConfigPath)) { throw "Missing connector configuration: $ConfigPath" }
$script:Config = Get-Content $ConfigPath -Raw | ConvertFrom-Json
$Secret = [string]$script:Config.secret
if ([string]::IsNullOrWhiteSpace($Secret)) { throw 'Connector secret is missing.' }

function Set-ConfigValue([string]$Name, $Value) {
  if ($script:Config.PSObject.Properties.Name -contains $Name) {
    $script:Config.$Name = $Value
  } else {
    $script:Config | Add-Member -NotePropertyName $Name -NotePropertyValue $Value
  }
}

function Save-Config {
  $script:Config | ConvertTo-Json -Depth 8 | Set-Content $ConfigPath -Encoding UTF8
}

function Send-Json($Context, [int]$Status, $Body) {
  $origin = $Context.Request.Headers['Origin']
  if ($origin) { $Context.Response.Headers['Access-Control-Allow-Origin'] = $origin }
  $Context.Response.Headers['Access-Control-Allow-Headers'] = 'Content-Type, X-Cenciss-Connector-Key'
  $Context.Response.Headers['Access-Control-Allow-Methods'] = 'GET, POST, DELETE, OPTIONS'
  if ($Context.Request.Headers['Access-Control-Request-Private-Network'] -eq 'true') {
    $Context.Response.Headers['Access-Control-Allow-Private-Network'] = 'true'
  }
  $Context.Response.Headers['Vary'] = 'Origin'
  $Context.Response.StatusCode = $Status
  if ($Status -eq 204) {
    $Context.Response.ContentLength64 = 0
    $Context.Response.OutputStream.Close()
    return
  }
  $json = $Body | ConvertTo-Json -Depth 8 -Compress
  $bytes = [Text.Encoding]::UTF8.GetBytes($json)
  $Context.Response.ContentType = 'application/json; charset=utf-8'
  $Context.Response.ContentLength64 = $bytes.Length
  $Context.Response.OutputStream.Write($bytes, 0, $bytes.Length)
  $Context.Response.OutputStream.Close()
}

function Read-RequestJson($Context) {
  $reader = New-Object IO.StreamReader($Context.Request.InputStream, $Context.Request.ContentEncoding)
  try {
    $text = $reader.ReadToEnd()
    if ([string]::IsNullOrWhiteSpace($text)) { return [pscustomobject]@{} }
    return $text | ConvertFrom-Json
  } finally {
    $reader.Dispose()
  }
}

function Get-InstalledPrinters {
  try {
    return @(Get-Printer | Sort-Object Name | ForEach-Object {
      [pscustomobject]@{
        name = $_.Name
        driverName = $_.DriverName
        portName = $_.PortName
        shared = [bool]$_.Shared
        type = [string]$_.Type
      }
    })
  } catch {
    return @(Get-CimInstance Win32_Printer | Sort-Object Name | ForEach-Object {
      [pscustomobject]@{
        name = $_.Name
        driverName = $_.DriverName
        portName = $_.PortName
        shared = [bool]$_.Shared
        type = 'Windows'
      }
    })
  }
}

function Print-Text([string]$PrinterName, [string]$Text, [string]$JobName, [int]$Copies = 1) {
  $available = @(Get-InstalledPrinters | Where-Object { $_.name -eq $PrinterName })
  if ($available.Count -eq 0) { throw "Windows printer '$PrinterName' is not installed." }
  if ([string]::IsNullOrWhiteSpace($Text)) { throw 'Print job is empty.' }

  $document = New-Object System.Drawing.Printing.PrintDocument
  $document.PrinterSettings.PrinterName = $PrinterName
  $document.PrinterSettings.Copies = [Math]::Max(1, [Math]::Min(10, $Copies))
  $document.DocumentName = $(if ($JobName) { $JobName } else { 'Cenciss KOT' })
  $document.PrintController = New-Object System.Drawing.Printing.StandardPrintController
  $document.DefaultPageSettings.Margins = New-Object System.Drawing.Printing.Margins(4, 4, 4, 4)
  $font = New-Object System.Drawing.Font('Consolas', 10, [Drawing.FontStyle]::Regular)
  $lines = @($Text -split "`r?`n")
  $script:lineIndex = 0

  $handler = [System.Drawing.Printing.PrintPageEventHandler]{
    param($sender, $eventArgs)
    $y = $eventArgs.MarginBounds.Top
    $height = [Math]::Ceiling($font.GetHeight($eventArgs.Graphics))
    while ($script:lineIndex -lt $lines.Count) {
      if (($y + $height) -gt $eventArgs.MarginBounds.Bottom) {
        $eventArgs.HasMorePages = $true
        return
      }
      $eventArgs.Graphics.DrawString($lines[$script:lineIndex], $font, [Drawing.Brushes]::Black, $eventArgs.MarginBounds.Left, $y)
      $script:lineIndex++
      $y += $height
    }
    $eventArgs.HasMorePages = $false
  }

  $document.add_PrintPage($handler)
  try { $document.Print() }
  finally {
    $document.remove_PrintPage($handler)
    $font.Dispose()
    $document.Dispose()
  }
}

function Get-CompletedJobIds {
  if (!(Test-Path $CompletedJobsPath)) { return @() }
  try { return @((Get-Content $CompletedJobsPath -Raw | ConvertFrom-Json).jobIds) }
  catch { return @() }
}

function Add-CompletedJobId([string]$JobId) {
  $ids = @(Get-CompletedJobIds | Where-Object { $_ -and $_ -ne $JobId })
  $ids += $JobId
  if ($ids.Count -gt 1000) { $ids = @($ids | Select-Object -Last 1000) }
  @{ jobIds = $ids; updatedAt = (Get-Date).ToString('o') } |
    ConvertTo-Json -Depth 4 |
    Set-Content $CompletedJobsPath -Encoding UTF8
}

function Get-CloudConfiguration {
  return [pscustomobject]@{
    configured = !([string]::IsNullOrWhiteSpace([string]$script:Config.apiBase)) -and
      !([string]::IsNullOrWhiteSpace([string]$script:Config.stationToken))
    apiBase = [string]$script:Config.apiBase
    stationTokenSet = !([string]::IsNullOrWhiteSpace([string]$script:Config.stationToken))
    configuredAt = [string]$script:Config.cloudConfiguredAt
    lastPollAt = [string]$script:Config.lastCloudPollAt
    lastSuccessAt = [string]$script:Config.lastCloudSuccessAt
    lastError = [string]$script:Config.lastCloudError
  }
}

function Invoke-CloudRequest([string]$Method, [string]$Path, $Body = $null, [string]$ApiBase = '', [string]$StationToken = '', [int]$RequestTimeoutSec = 8) {
  if ([string]::IsNullOrWhiteSpace($ApiBase)) { $ApiBase = [string]$script:Config.apiBase }
  if ([string]::IsNullOrWhiteSpace($StationToken)) { $StationToken = [string]$script:Config.stationToken }
  $uri = "$($ApiBase.TrimEnd('/'))$Path"
  $params = @{
    Uri = $uri
    Method = $Method
    Headers = @{ 'X-Print-Station-Token' = $StationToken }
    TimeoutSec = $RequestTimeoutSec
    UseBasicParsing = $true
  }
  if ($null -ne $Body) {
    $params['ContentType'] = 'application/json'
    $params['Body'] = ($Body | ConvertTo-Json -Depth 8 -Compress)
  }
  $response = Invoke-RestMethod @params
  return $response
}

function Test-CloudCredentials([string]$ApiBase, [string]$StationToken) {
  $candidate = $null
  try { $candidate = [Uri]$ApiBase } catch { throw 'Cloud API URL is invalid.' }
  if (!$candidate.IsAbsoluteUri -or -not (@('http', 'https') -contains $candidate.Scheme)) {
    throw 'Cloud API URL must begin with https:// (or http:// for local development).'
  }
  if ([string]::IsNullOrWhiteSpace($StationToken)) { throw 'Print station token is required.' }
  $status = Invoke-CloudRequest 'GET' '/api/print-agent/status' $null $ApiBase.TrimEnd('/') $StationToken.Trim()
  return $status
}

function Start-CloudPoll {
  $cloud = Get-CloudConfiguration
  if (!$cloud.configured -or $null -ne $script:CloudClaimTask) { return }
  Set-ConfigValue 'lastCloudPollAt' (Get-Date).ToString('o')
  $uri = "$(([string]$script:Config.apiBase).TrimEnd('/'))/api/print-agent/jobs/claim?wait=25"
  $request = New-Object System.Net.Http.HttpRequestMessage([System.Net.Http.HttpMethod]::Post, $uri)
  $request.Headers.Add('X-Print-Station-Token', [string]$script:Config.stationToken)
  $request.Content = New-Object System.Net.Http.StringContent('{}', [Text.Encoding]::UTF8, 'application/json')
  $script:CloudClaimRequest = $request
  $script:CloudClaimTask = $script:CloudHttpClient.SendAsync($request)
}

function Complete-CloudPoll {
  if ($null -eq $script:CloudClaimTask -or !$script:CloudClaimTask.IsCompleted) { return }
  $saveStatus = $false
  $previousError = [string]$script:Config.lastCloudError
  $response = $null
  try {
    $response = $script:CloudClaimTask.GetAwaiter().GetResult()
    $response.EnsureSuccessStatusCode() | Out-Null
    $claimJson = $response.Content.ReadAsStringAsync().GetAwaiter().GetResult()
    $claim = $claimJson | ConvertFrom-Json
    $job = $claim.job
    Set-ConfigValue 'lastCloudSuccessAt' (Get-Date).ToString('o')
    Set-ConfigValue 'lastCloudError' ''
    if (![string]::IsNullOrWhiteSpace($previousError)) {
      $saveStatus = $true
      Write-Log 'Cloud print station connection recovered.'
    }
    if ($null -eq $job) { return }
    $saveStatus = $true

    $jobId = [string]$job._id
    if (@(Get-CompletedJobIds) -contains $jobId) {
      Invoke-CloudRequest 'POST' "/api/print-agent/jobs/$jobId/complete" @{
        confirmation = 'windows-spooler-accepted-recovered'
      } | Out-Null
      Write-Log "Recovered acknowledgement for cloud job '$jobId'."
      return
    }

    try {
      Print-Text ([string]$job.printerName) ([string]$job.text) ([string]$job.jobName) ([int]$(if ($job.copies) { $job.copies } else { 1 }))
      # Persist the spooler acceptance before acknowledging the server. If the
      # acknowledgement is interrupted, the next claim is acknowledged without
      # physically printing the same job again.
      Add-CompletedJobId $jobId
      Invoke-CloudRequest 'POST' "/api/print-agent/jobs/$jobId/complete" @{
        confirmation = 'windows-spooler-accepted'
      } | Out-Null
      Write-Log "Printed cloud job '$($job.jobName)' to '$($job.printerName)' id=$jobId"
    } catch {
      $failure = $_.Exception.Message
      try {
        Invoke-CloudRequest 'POST' "/api/print-agent/jobs/$jobId/fail" @{ error = $failure } | Out-Null
      } catch {
        Write-Log "Could not report cloud job failure for '$jobId': $($_.Exception.Message)"
      }
      throw $failure
    }
  } catch {
    $currentError = $_.Exception.Message
    Set-ConfigValue 'lastCloudError' $currentError
    if ($currentError -ne $previousError) {
      $saveStatus = $true
      Write-Log "Cloud poll failed: $currentError"
    }
  } finally {
    if ($null -ne $response) { $response.Dispose() }
    if ($null -ne $script:CloudClaimRequest) { $script:CloudClaimRequest.Dispose() }
    $script:CloudClaimRequest = $null
    $script:CloudClaimTask = $null
    # Avoid rewriting config.json after every idle long poll.
    # Persist only meaningful job/error state; in-memory health timestamps are
    # still returned by /health during the current connector process.
    if ($saveStatus) { Save-Config }
  }
}

function Handle-LocalRequest($Context) {
  try {
    if ($Context.Request.HttpMethod -eq 'OPTIONS') {
      Send-Json $Context 204 @{ ok = $true }
      return
    }

    $path = $Context.Request.Url.AbsolutePath.TrimEnd('/')
    if ($path -eq '/health' -and $Context.Request.HttpMethod -eq 'GET') {
      Send-Json $Context 200 @{
        ok = $true
        product = 'Cenciss Print Connector'
        version = '1.3.0'
        windowsUser = [Security.Principal.WindowsIdentity]::GetCurrent().Name
        cloud = Get-CloudConfiguration
      }
      return
    }

    if ($Context.Request.Headers['X-Cenciss-Connector-Key'] -ne $Secret) {
      Send-Json $Context 401 @{
        ok = $false
        message = 'This key does not match the running connector. Run the latest connector installer again, then paste the newly created Cenciss Connector Key.txt.'
      }
      return
    }

    if ($path -eq '/printers' -and $Context.Request.HttpMethod -eq 'GET') {
      Send-Json $Context 200 @{ ok = $true; printers = @(Get-InstalledPrinters) }
      return
    }

    if ($path -eq '/print' -and $Context.Request.HttpMethod -eq 'POST') {
      $payload = Read-RequestJson $Context
      Print-Text ([string]$payload.printerName) ([string]$payload.text) ([string]$payload.jobName) ([int]$(if ($payload.copies) { $payload.copies } else { 1 }))
      Write-Log "Printed '$($payload.jobName)' to '$($payload.printerName)'"
      Send-Json $Context 200 @{ ok = $true; printerName = $payload.printerName; confirmation = 'windows-spooler-accepted' }
      return
    }

    if ($path -eq '/cloud-config' -and $Context.Request.HttpMethod -eq 'GET') {
      Send-Json $Context 200 @{ ok = $true; cloud = Get-CloudConfiguration }
      return
    }

    if ($path -eq '/cloud-config' -and $Context.Request.HttpMethod -eq 'POST') {
      $payload = Read-RequestJson $Context
      $apiBase = ([string]$payload.apiBase).Trim().TrimEnd('/')
      $stationToken = ([string]$payload.stationToken).Trim()
      $status = Test-CloudCredentials $apiBase $stationToken
      Set-ConfigValue 'apiBase' $apiBase
      Set-ConfigValue 'stationToken' $stationToken
      Set-ConfigValue 'cloudConfiguredAt' (Get-Date).ToString('o')
      Set-ConfigValue 'lastCloudError' ''
      Save-Config
      Write-Log "Cloud print station configured for '$apiBase' station='$($status.station.label)'."
      Send-Json $Context 200 @{
        ok = $true
        station = $status.station
        queue = $status.queue
        cloud = Get-CloudConfiguration
      }
      return
    }

    if ($path -eq '/cloud-config' -and $Context.Request.HttpMethod -eq 'DELETE') {
      Set-ConfigValue 'apiBase' ''
      Set-ConfigValue 'stationToken' ''
      Set-ConfigValue 'cloudConfiguredAt' ''
      Set-ConfigValue 'lastCloudError' ''
      Save-Config
      Write-Log 'Cloud print station disconnected.'
      Send-Json $Context 200 @{ ok = $true; cloud = Get-CloudConfiguration }
      return
    }

    Send-Json $Context 404 @{ ok = $false; message = 'Endpoint not found.' }
  } catch {
    Write-Log "Local request failed: $($_.Exception.Message)"
    try { Send-Json $Context 500 @{ ok = $false; message = $_.Exception.Message } } catch {}
  }
}

$listener = New-Object Net.HttpListener
$listener.Prefixes.Add("http://127.0.0.1:$Port/")
$listener.Start()
Write-Log "Connector 1.3.0 started on 127.0.0.1:$Port"

try {
  $contextTask = $listener.GetContextAsync()
  $nextCloudPoll = Get-Date
  while ($listener.IsListening) {
    Complete-CloudPoll
    if ($contextTask.IsCompleted) {
      $ctx = $contextTask.GetAwaiter().GetResult()
      Handle-LocalRequest $ctx
      $contextTask = $listener.GetContextAsync()
    }
    if ($null -eq $script:CloudClaimTask -and (Get-Date) -ge $nextCloudPoll) {
      Start-CloudPoll
      $nextCloudPoll = (Get-Date).AddSeconds($CloudPollSeconds)
    }
    Start-Sleep -Milliseconds 100
  }
} finally {
  $listener.Stop()
  $listener.Close()
  if ($null -ne $script:CloudClaimRequest) { $script:CloudClaimRequest.Dispose() }
  $script:CloudHttpClient.Dispose()
  Write-Log 'Connector stopped.'
}
