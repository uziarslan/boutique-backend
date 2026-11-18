namespace Cenciss.PrintConnector;

internal sealed record ConnectorRuntimeSnapshot(
    bool LocalOnline,
    DateTimeOffset StartedAt,
    ConnectorConfigSnapshot Configuration,
    IReadOnlyList<WindowsPrinter> Printers);

internal sealed class ConnectorRuntime : IAsyncDisposable
{
    private readonly ConnectorLogger _logger;
    private readonly ConnectorConfigStore _config;
    private readonly CompletedJobStore _completedJobs;
    private readonly PrinterService _printers;
    private readonly CloudPrintWorker _cloudWorker;
    private readonly LocalApiServer _localServer;
    private bool _started;

    public ConnectorRuntime()
    {
        _logger = new ConnectorLogger();
        _config = new ConnectorConfigStore(_logger);
        _completedJobs = new CompletedJobStore();
        _printers = new PrinterService();
        _cloudWorker = new CloudPrintWorker(_config, _completedJobs, _printers, _logger);
        _localServer = new LocalApiServer(_config, _printers, _cloudWorker, _logger);
        StartedAt = DateTimeOffset.Now;
    }

    public DateTimeOffset StartedAt { get; }
    public string ConnectorKey => _config.Snapshot().Secret;

    public void Start()
    {
        if (_started) return;
        _localServer.Start();
        _cloudWorker.Start();
        _started = true;
        _logger.Info($"{AppPaths.ProductName} {AppPaths.Version} running as {Environment.UserDomainName}\\{Environment.UserName}.");
    }

    public ConnectorRuntimeSnapshot Snapshot(bool includePrinters = true)
    {
        IReadOnlyList<WindowsPrinter> printers;
        try { printers = includePrinters ? _printers.GetInstalledPrinters() : Array.Empty<WindowsPrinter>(); }
        catch { printers = Array.Empty<WindowsPrinter>(); }
        return new ConnectorRuntimeSnapshot(_localServer.IsListening, StartedAt, _config.Snapshot(), printers);
    }

    public Task PrintTestPageAsync(string printerName, CancellationToken cancellationToken) =>
        _printers.PrintTestPageAsync(printerName, cancellationToken);

    public async ValueTask DisposeAsync()
    {
        if (!_started)
        {
            _printers.Dispose();
            return;
        }
        await _localServer.DisposeAsync().ConfigureAwait(false);
        await _cloudWorker.DisposeAsync().ConfigureAwait(false);
        _printers.Dispose();
        _started = false;
        _logger.Info($"{AppPaths.ProductName} stopped.");
    }
}
