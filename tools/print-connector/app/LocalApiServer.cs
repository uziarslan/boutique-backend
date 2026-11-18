using System.Net;
using System.Collections.Concurrent;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace Cenciss.PrintConnector;

internal sealed class LocalApiServer : IAsyncDisposable
{
    private const int MaximumRequestBytes = 1_000_000;
    private readonly ConnectorConfigStore _config;
    private readonly PrinterService _printers;
    private readonly CloudPrintWorker _cloudWorker;
    private readonly ConnectorLogger _logger;
    private readonly HttpListener _listener = new();
    private readonly CancellationTokenSource _stop = new();
    private readonly ConcurrentDictionary<long, Task> _activeRequests = new();
    private long _requestSequence;
    private Task? _listenerLoop;

    public LocalApiServer(
        ConnectorConfigStore config,
        PrinterService printers,
        CloudPrintWorker cloudWorker,
        ConnectorLogger logger)
    {
        _config = config;
        _printers = printers;
        _cloudWorker = cloudWorker;
        _logger = logger;
        _listener.Prefixes.Add($"http://127.0.0.1:{AppPaths.Port}/");
        _listener.IgnoreWriteExceptions = true;
    }

    public bool IsListening => _listener.IsListening;

    public void Start()
    {
        _listener.Start();
        _listenerLoop = Task.Run(() => ListenAsync(_stop.Token));
        _ = _listenerLoop.ContinueWith(
            task =>
            {
                _logger.Error($"Local API stopped unexpectedly: {task.Exception?.GetBaseException().Message ?? "unknown failure"}");
                Environment.Exit(1);
            },
            CancellationToken.None,
            TaskContinuationOptions.OnlyOnFaulted,
            TaskScheduler.Default);
        _logger.Info($"Connector {AppPaths.Version} started on 127.0.0.1:{AppPaths.Port}");
    }

    public async ValueTask DisposeAsync()
    {
        _stop.Cancel();
        if (_listener.IsListening) _listener.Stop();
        _listener.Close();
        if (_listenerLoop is not null)
        {
            try { await _listenerLoop.ConfigureAwait(false); }
            catch (OperationCanceledException) { }
            catch (HttpListenerException) { }
            catch (ObjectDisposedException) { }
        }
        var activeRequests = _activeRequests.Values.ToArray();
        if (activeRequests.Length > 0)
        {
            try { await Task.WhenAll(activeRequests).WaitAsync(TimeSpan.FromSeconds(5)).ConfigureAwait(false); }
            catch { }
        }
        _stop.Dispose();
        _logger.Info("Connector local API stopped.");
    }

    private async Task ListenAsync(CancellationToken cancellationToken)
    {
        while (!cancellationToken.IsCancellationRequested && _listener.IsListening)
        {
            HttpListenerContext context;
            try
            {
                context = await _listener.GetContextAsync().WaitAsync(cancellationToken).ConfigureAwait(false);
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested) { break; }
            catch (HttpListenerException) when (!_listener.IsListening) { break; }
            catch (ObjectDisposedException) { break; }

            var requestId = Interlocked.Increment(ref _requestSequence);
            var requestTask = Task.Run(() => HandleContextAsync(context, cancellationToken), CancellationToken.None);
            _activeRequests[requestId] = requestTask;
            _ = requestTask.ContinueWith(
                _ =>
                {
                    _activeRequests.TryRemove(requestId, out var removedRequest);
                },
                CancellationToken.None,
                TaskContinuationOptions.ExecuteSynchronously,
                TaskScheduler.Default);
        }
    }

    private async Task HandleContextAsync(HttpListenerContext context, CancellationToken cancellationToken)
    {
        try
        {
            AddCorsHeaders(context);
            if (context.Request.HttpMethod.Equals("OPTIONS", StringComparison.OrdinalIgnoreCase))
            {
                await SendJsonAsync(context, 204, new { ok = true }, cancellationToken).ConfigureAwait(false);
                return;
            }

            var path = context.Request.Url?.AbsolutePath.TrimEnd('/') ?? string.Empty;
            var method = context.Request.HttpMethod.ToUpperInvariant();
            if (path.Equals("/health", StringComparison.OrdinalIgnoreCase) && method == "GET")
            {
                await SendJsonAsync(context, 200, new
                {
                    ok = true,
                    product = AppPaths.ProductName,
                    version = AppPaths.Version,
                    windowsUser = $"{Environment.UserDomainName}\\{Environment.UserName}",
                    cloud = _config.Snapshot().ToPublicCloudStatus(),
                }, cancellationToken).ConfigureAwait(false);
                return;
            }

            if (!ConnectorKeyMatches(context.Request.Headers["X-Cenciss-Connector-Key"], _config.Snapshot().Secret))
            {
                await SendJsonAsync(context, 401, new
                {
                    ok = false,
                    message = "This key does not match the running connector. Open Cenciss Print Connector from the Windows tray and copy its connector key.",
                }, cancellationToken).ConfigureAwait(false);
                return;
            }

            if (path.Equals("/printers", StringComparison.OrdinalIgnoreCase) && method == "GET")
            {
                await SendJsonAsync(context, 200, new { ok = true, printers = _printers.GetInstalledPrinters() }, cancellationToken).ConfigureAwait(false);
                return;
            }

            if (path.Equals("/print", StringComparison.OrdinalIgnoreCase) && method == "POST")
            {
                var request = await ReadJsonAsync<PrintRequest>(context.Request, cancellationToken).ConfigureAwait(false);
                await _printers.PrintTextAsync(
                    request.PrinterName,
                    request.Text,
                    request.JobName,
                    request.Copies,
                    cancellationToken).ConfigureAwait(false);
                _logger.Info($"Printed '{SanitizeForLog(request.JobName)}' to '{SanitizeForLog(request.PrinterName)}'.");
                await SendJsonAsync(context, 200, new
                {
                    ok = true,
                    printerName = request.PrinterName,
                    confirmation = "windows-spooler-accepted",
                }, cancellationToken).ConfigureAwait(false);
                return;
            }

            if (path.Equals("/cloud-config", StringComparison.OrdinalIgnoreCase) && method == "GET")
            {
                await SendJsonAsync(context, 200, new { ok = true, cloud = _config.Snapshot().ToPublicCloudStatus() }, cancellationToken).ConfigureAwait(false);
                return;
            }

            if (path.Equals("/cloud-config", StringComparison.OrdinalIgnoreCase) && method == "POST")
            {
                var request = await ReadJsonAsync<CloudConfigurationRequest>(context.Request, cancellationToken).ConfigureAwait(false);
                var apiBase = CloudPrintWorker.ValidateApiBase(request.ApiBase);
                var status = await _cloudWorker.TestCredentialsAsync(apiBase, request.StationToken, cancellationToken).ConfigureAwait(false);
                _config.SetCloudConfiguration(apiBase, request.StationToken);
                _cloudWorker.NotifyConfigurationChanged();
                _logger.Info($"Cloud print station configured for '{new Uri(apiBase).Host}'.");
                await SendJsonAsync(context, 200, new
                {
                    ok = true,
                    station = status.Station,
                    queue = status.Queue,
                    cloud = _config.Snapshot().ToPublicCloudStatus(),
                }, cancellationToken).ConfigureAwait(false);
                return;
            }

            if (path.Equals("/cloud-config", StringComparison.OrdinalIgnoreCase) && method == "DELETE")
            {
                _config.ClearCloudConfiguration();
                _cloudWorker.NotifyConfigurationChanged();
                _logger.Info("Cloud print station disconnected.");
                await SendJsonAsync(context, 200, new { ok = true, cloud = _config.Snapshot().ToPublicCloudStatus() }, cancellationToken).ConfigureAwait(false);
                return;
            }

            await SendJsonAsync(context, 404, new { ok = false, message = "Endpoint not found." }, cancellationToken).ConfigureAwait(false);
        }
        catch (RequestException exception)
        {
            await TrySendErrorAsync(context, exception.StatusCode, exception.Message, cancellationToken).ConfigureAwait(false);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            TryClose(context.Response);
        }
        catch (Exception exception)
        {
            var message = SafeMessage(exception);
            _logger.Warn($"Local request failed: {message}");
            await TrySendErrorAsync(context, 500, message, cancellationToken).ConfigureAwait(false);
        }
    }

    private static async Task<T> ReadJsonAsync<T>(HttpListenerRequest request, CancellationToken cancellationToken)
    {
        if (request.ContentLength64 > MaximumRequestBytes) throw new RequestException(413, "Request is too large.");
        await using var buffer = new MemoryStream();
        var chunk = new byte[8192];
        while (true)
        {
            var count = await request.InputStream.ReadAsync(chunk.AsMemory(0, chunk.Length), cancellationToken).ConfigureAwait(false);
            if (count == 0) break;
            if (buffer.Length + count > MaximumRequestBytes) throw new RequestException(413, "Request is too large.");
            await buffer.WriteAsync(chunk.AsMemory(0, count), cancellationToken).ConfigureAwait(false);
        }
        if (buffer.Length == 0) throw new RequestException(400, "Request body is required.");
        buffer.Position = 0;
        try
        {
            return await JsonSerializer.DeserializeAsync<T>(buffer, JsonOptions, cancellationToken).ConfigureAwait(false)
                ?? throw new RequestException(400, "Request body is invalid.");
        }
        catch (JsonException)
        {
            throw new RequestException(400, "Request body is invalid.");
        }
    }

    private static async Task SendJsonAsync(HttpListenerContext context, int statusCode, object body, CancellationToken cancellationToken)
    {
        context.Response.StatusCode = statusCode;
        if (statusCode == 204)
        {
            context.Response.ContentLength64 = 0;
            context.Response.Close();
            return;
        }
        var bytes = JsonSerializer.SerializeToUtf8Bytes(body, JsonOptions);
        context.Response.ContentType = "application/json; charset=utf-8";
        context.Response.ContentEncoding = Encoding.UTF8;
        context.Response.ContentLength64 = bytes.Length;
        await context.Response.OutputStream.WriteAsync(bytes, cancellationToken).ConfigureAwait(false);
        context.Response.Close();
    }

    private static async Task TrySendErrorAsync(HttpListenerContext context, int statusCode, string message, CancellationToken cancellationToken)
    {
        try { await SendJsonAsync(context, statusCode, new { ok = false, message }, cancellationToken).ConfigureAwait(false); }
        catch { TryClose(context.Response); }
    }

    private static void AddCorsHeaders(HttpListenerContext context)
    {
        var origin = context.Request.Headers["Origin"];
        if (!string.IsNullOrWhiteSpace(origin)) context.Response.Headers["Access-Control-Allow-Origin"] = origin;
        context.Response.Headers["Access-Control-Allow-Headers"] = "Content-Type, X-Cenciss-Connector-Key";
        context.Response.Headers["Access-Control-Allow-Methods"] = "GET, POST, DELETE, OPTIONS";
        if (context.Request.Headers["Access-Control-Request-Private-Network"]?.Equals("true", StringComparison.OrdinalIgnoreCase) == true)
            context.Response.Headers["Access-Control-Allow-Private-Network"] = "true";
        context.Response.Headers["Vary"] = "Origin";
    }

    private static bool ConnectorKeyMatches(string? supplied, string expected)
    {
        if (string.IsNullOrEmpty(supplied) || supplied.Length != expected.Length) return false;
        return CryptographicOperations.FixedTimeEquals(Encoding.UTF8.GetBytes(supplied), Encoding.UTF8.GetBytes(expected));
    }

    private static void TryClose(HttpListenerResponse response)
    {
        try { response.Close(); } catch { }
    }

    private static string SanitizeForLog(string? value) => (value ?? string.Empty).Replace('\r', ' ').Replace('\n', ' ');
    private static string SafeMessage(Exception exception) => string.IsNullOrWhiteSpace(exception.Message) ? exception.GetType().Name : SanitizeForLog(exception.Message);

    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        PropertyNameCaseInsensitive = true,
    };

    private sealed record PrintRequest(string PrinterName, string Text, string? JobName, int Copies = 1);
    private sealed record CloudConfigurationRequest(string ApiBase, string StationToken);
    private sealed class RequestException(int statusCode, string message) : Exception(message)
    {
        public int StatusCode { get; } = statusCode;
    }
}
