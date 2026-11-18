using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;

namespace Cenciss.PrintConnector;

internal sealed record CloudCredentialStatus(JsonElement Station, JsonElement Queue);

internal sealed class CloudPrintWorker : IAsyncDisposable
{
    private readonly ConnectorConfigStore _config;
    private readonly CompletedJobStore _completedJobs;
    private readonly PrinterService _printers;
    private readonly ConnectorLogger _logger;
    private readonly HttpClient _httpClient;
    private readonly CancellationTokenSource _stop = new();
    private readonly SemaphoreSlim _configurationChanged = new(0, 1);
    private readonly object _claimGate = new();
    private CancellationTokenSource? _activeClaimCancellation;
    private Task? _worker;

    public CloudPrintWorker(
        ConnectorConfigStore config,
        CompletedJobStore completedJobs,
        PrinterService printers,
        ConnectorLogger logger)
    {
        _config = config;
        _completedJobs = completedJobs;
        _printers = printers;
        _logger = logger;
        _httpClient = new HttpClient(new SocketsHttpHandler
        {
            PooledConnectionLifetime = TimeSpan.FromMinutes(10),
            ConnectTimeout = TimeSpan.FromSeconds(8),
        })
        {
            Timeout = TimeSpan.FromSeconds(40),
        };
        _httpClient.DefaultRequestHeaders.UserAgent.Add(new ProductInfoHeaderValue("CencissPrintConnector", AppPaths.Version));
    }

    public void Start() => _worker ??= Task.Run(() => RunAsync(_stop.Token));

    public void NotifyConfigurationChanged()
    {
        lock (_claimGate) _activeClaimCancellation?.Cancel();
        try
        {
            if (_configurationChanged.CurrentCount == 0) _configurationChanged.Release();
        }
        catch (SemaphoreFullException) { }
    }

    public async Task<CloudCredentialStatus> TestCredentialsAsync(
        string apiBase,
        string stationToken,
        CancellationToken cancellationToken)
    {
        apiBase = ValidateApiBase(apiBase);
        if (string.IsNullOrWhiteSpace(stationToken)) throw new InvalidOperationException("Print station token is required.");
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeout.CancelAfter(TimeSpan.FromSeconds(10));
        using var document = await SendForJsonAsync(
            HttpMethod.Get,
            $"{apiBase}/api/print-agent/status",
            stationToken.Trim(),
            null,
            timeout.Token).ConfigureAwait(false);
        var root = document.RootElement;
        var station = root.TryGetProperty("station", out var stationValue) ? stationValue.Clone() : EmptyObject();
        var queue = root.TryGetProperty("queue", out var queueValue) ? queueValue.Clone() : EmptyObject();
        return new CloudCredentialStatus(station, queue);
    }

    public static string ValidateApiBase(string apiBase)
    {
        if (string.IsNullOrWhiteSpace(apiBase)) throw new InvalidOperationException("Cloud API URL is required.");
        apiBase = apiBase.Trim().TrimEnd('/');
        if (!Uri.TryCreate(apiBase, UriKind.Absolute, out var uri)) throw new InvalidOperationException("Cloud API URL is invalid.");
        var localDevelopment = uri.IsLoopback && uri.Scheme.Equals(Uri.UriSchemeHttp, StringComparison.OrdinalIgnoreCase);
        if (!uri.Scheme.Equals(Uri.UriSchemeHttps, StringComparison.OrdinalIgnoreCase) && !localDevelopment)
            throw new InvalidOperationException("Cloud API URL must use https:// (http:// is allowed only for local development).");
        return apiBase;
    }

    public async ValueTask DisposeAsync()
    {
        _stop.Cancel();
        NotifyConfigurationChanged();
        if (_worker is not null)
        {
            try { await _worker.ConfigureAwait(false); }
            catch (OperationCanceledException) { }
        }
        lock (_claimGate)
        {
            _activeClaimCancellation?.Dispose();
            _activeClaimCancellation = null;
        }
        _configurationChanged.Dispose();
        _stop.Dispose();
        _httpClient.Dispose();
    }

    private async Task RunAsync(CancellationToken cancellationToken)
    {
        var consecutiveFailures = 0;
        while (!cancellationToken.IsCancellationRequested)
        {
            var current = _config.Snapshot();
            if (!current.CloudConfigured)
            {
                consecutiveFailures = 0;
                await WaitForConfigurationOrDelayAsync(TimeSpan.FromMinutes(5), cancellationToken).ConfigureAwait(false);
                continue;
            }

            CancellationTokenSource claimCancellation;
            lock (_claimGate)
            {
                _activeClaimCancellation?.Dispose();
                _activeClaimCancellation = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
                claimCancellation = _activeClaimCancellation;
            }

            try
            {
                _config.UpdateCloudStatus(lastPollAt: DateTimeOffset.UtcNow.ToString("O"));
                using var document = await SendForJsonAsync(
                    HttpMethod.Post,
                    $"{current.ApiBase}/api/print-agent/jobs/claim?wait=25",
                    current.StationToken,
                    "{}",
                    claimCancellation.Token).ConfigureAwait(false);

                var previousError = current.LastCloudError;
                _config.UpdateCloudStatus(
                    lastSuccessAt: DateTimeOffset.UtcNow.ToString("O"),
                    lastError: string.Empty,
                    persist: !string.IsNullOrWhiteSpace(previousError));
                if (!string.IsNullOrWhiteSpace(previousError)) _logger.Info("Cloud print station connection recovered.");
                consecutiveFailures = 0;

                if (!document.RootElement.TryGetProperty("job", out var job) || job.ValueKind is JsonValueKind.Null or JsonValueKind.Undefined)
                    continue;
                await ProcessJobAsync(current, job, cancellationToken).ConfigureAwait(false);
            }
            catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
            {
                // A station configuration change intentionally cancels the old long poll.
            }
            catch (Exception exception) when (!cancellationToken.IsCancellationRequested)
            {
                consecutiveFailures++;
                var message = SafeMessage(exception);
                var priorError = _config.Snapshot().LastCloudError;
                _config.UpdateCloudStatus(lastError: message, persist: !string.Equals(message, priorError, StringComparison.Ordinal));
                if (!string.Equals(message, priorError, StringComparison.Ordinal)) _logger.Warn($"Cloud poll failed: {message}");
                var delaySeconds = Math.Min(30, Math.Max(1, (int)Math.Pow(2, Math.Min(consecutiveFailures - 1, 5))));
                await WaitForConfigurationOrDelayAsync(TimeSpan.FromSeconds(delaySeconds), cancellationToken).ConfigureAwait(false);
            }
            finally
            {
                lock (_claimGate)
                {
                    if (ReferenceEquals(_activeClaimCancellation, claimCancellation))
                    {
                        _activeClaimCancellation.Dispose();
                        _activeClaimCancellation = null;
                    }
                }
            }
        }
    }

    private async Task ProcessJobAsync(
        ConnectorConfigSnapshot current,
        JsonElement job,
        CancellationToken cancellationToken)
    {
        var jobId = RequiredString(job, "_id");
        var printerName = RequiredString(job, "printerName");
        var text = RequiredString(job, "text");
        var jobName = OptionalString(job, "jobName");
        var copies = job.TryGetProperty("copies", out var copiesValue) && copiesValue.TryGetInt32(out var parsedCopies)
            ? parsedCopies
            : 1;

        if (_completedJobs.Contains(jobId))
        {
            using var recoveredAcknowledgement = await SendForJsonAsync(
                HttpMethod.Post,
                $"{current.ApiBase}/api/print-agent/jobs/{Uri.EscapeDataString(jobId)}/complete",
                current.StationToken,
                JsonSerializer.Serialize(new { confirmation = "windows-spooler-accepted-recovered" }),
                cancellationToken).ConfigureAwait(false);
            _logger.Info($"Recovered acknowledgement for cloud job '{jobId}'.");
            return;
        }

        try
        {
            await _printers.PrintTextAsync(printerName, text, jobName, copies, cancellationToken).ConfigureAwait(false);
            _completedJobs.Add(jobId);
            using var acknowledgement = await SendForJsonAsync(
                HttpMethod.Post,
                $"{current.ApiBase}/api/print-agent/jobs/{Uri.EscapeDataString(jobId)}/complete",
                current.StationToken,
                JsonSerializer.Serialize(new { confirmation = "windows-spooler-accepted" }),
                cancellationToken).ConfigureAwait(false);
            _logger.Info($"Printed cloud job '{jobName}' to '{printerName}' id={jobId}");
        }
        catch (Exception exception) when (exception is not OperationCanceledException)
        {
            var failure = SafeMessage(exception);
            try
            {
                using var ignored = await SendForJsonAsync(
                    HttpMethod.Post,
                    $"{current.ApiBase}/api/print-agent/jobs/{Uri.EscapeDataString(jobId)}/fail",
                    current.StationToken,
                    JsonSerializer.Serialize(new { error = failure }),
                    cancellationToken).ConfigureAwait(false);
            }
            catch (Exception reportException)
            {
                _logger.Warn($"Could not report cloud job failure for '{jobId}': {SafeMessage(reportException)}");
            }
            throw;
        }
    }

    private async Task<JsonDocument> SendForJsonAsync(
        HttpMethod method,
        string uri,
        string stationToken,
        string? jsonBody,
        CancellationToken cancellationToken)
    {
        using var request = new HttpRequestMessage(method, uri);
        request.Headers.TryAddWithoutValidation("X-Print-Station-Token", stationToken);
        if (jsonBody is not null) request.Content = new StringContent(jsonBody, Encoding.UTF8, "application/json");
        using var response = await _httpClient.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, cancellationToken).ConfigureAwait(false);
        var responseBody = await response.Content.ReadAsStringAsync(cancellationToken).ConfigureAwait(false);
        if (!response.IsSuccessStatusCode)
            throw new HttpRequestException($"Cloud returned {(int)response.StatusCode} {response.ReasonPhrase}.");
        return JsonDocument.Parse(string.IsNullOrWhiteSpace(responseBody) ? "{}" : responseBody);
    }

    private async Task WaitForConfigurationOrDelayAsync(TimeSpan delay, CancellationToken cancellationToken)
    {
        await _configurationChanged.WaitAsync(delay, cancellationToken).ConfigureAwait(false);
    }

    private static string RequiredString(JsonElement root, string name)
    {
        var value = OptionalString(root, name);
        return string.IsNullOrWhiteSpace(value) ? throw new InvalidOperationException($"Cloud print job is missing {name}.") : value;
    }

    private static string OptionalString(JsonElement root, string name) =>
        root.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String
            ? value.GetString() ?? string.Empty
            : string.Empty;

    private static JsonElement EmptyObject()
    {
        using var document = JsonDocument.Parse("{}");
        return document.RootElement.Clone();
    }

    private static string SafeMessage(Exception exception) =>
        string.IsNullOrWhiteSpace(exception.Message) ? exception.GetType().Name : exception.Message.Replace('\r', ' ').Replace('\n', ' ');
}
