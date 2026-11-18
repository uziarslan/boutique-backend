using System.Diagnostics;

namespace Cenciss.PrintConnector;

internal sealed class TrayApplicationContext : ApplicationContext
{
    private readonly ConnectorRuntime _runtime;
    private readonly DiagnosticsForm _diagnostics;
    private readonly NotifyIcon _trayIcon;
    private readonly EventWaitHandle _showWindowEvent;
    private readonly RegisteredWaitHandle _showWindowRegistration;
    private bool _shuttingDown;

    public TrayApplicationContext(IReadOnlyList<string> args)
    {
        _runtime = new ConnectorRuntime();
        _diagnostics = new DiagnosticsForm(_runtime);
        _diagnostics.RestartRequested += (_, _) => Shutdown(restart: true);

        var menu = new ContextMenuStrip();
        menu.Items.Add("Open status", null, (_, _) => ShowDiagnostics());
        menu.Items.Add("Open logs", null, (_, _) => OpenDataDirectory());
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("Restart connector", null, (_, _) => Shutdown(restart: true));
        menu.Items.Add("Exit", null, (_, _) => ConfirmExit());
        _trayIcon = new NotifyIcon
        {
            Icon = SystemIcons.Application,
            Text = "Cenciss Print Connector — starting",
            ContextMenuStrip = menu,
            Visible = true,
        };
        _trayIcon.DoubleClick += (_, _) => ShowDiagnostics();

        _showWindowEvent = new EventWaitHandle(false, EventResetMode.AutoReset, Program.ShowWindowEventName);
        _showWindowRegistration = ThreadPool.RegisterWaitForSingleObject(
            _showWindowEvent,
            (_, _) =>
            {
                try { _diagnostics.BeginInvoke(ShowDiagnostics); } catch { }
            },
            null,
            Timeout.Infinite,
            executeOnlyOnce: false);

        Application.ThreadException += OnThreadException;
        AppDomain.CurrentDomain.UnhandledException += OnUnhandledException;

        _runtime.Start();
        UpdateTrayStatus();
        var timer = new System.Windows.Forms.Timer { Interval = 10_000 };
        timer.Tick += (_, _) => UpdateTrayStatus();
        timer.Start();
        _diagnostics.Disposed += (_, _) => timer.Dispose();

        if (args.Any(argument => argument.Equals("--open", StringComparison.OrdinalIgnoreCase))) ShowDiagnostics();
    }

    public int ExitCode { get; private set; }

    protected override void Dispose(bool disposing)
    {
        if (disposing)
        {
            Application.ThreadException -= OnThreadException;
            AppDomain.CurrentDomain.UnhandledException -= OnUnhandledException;
            _showWindowRegistration.Unregister(null);
            _showWindowEvent.Dispose();
            _trayIcon.Visible = false;
            _trayIcon.Dispose();
            _diagnostics.Dispose();
        }
        base.Dispose(disposing);
    }

    private void ShowDiagnostics()
    {
        if (_diagnostics.Visible)
        {
            if (_diagnostics.WindowState == FormWindowState.Minimized) _diagnostics.WindowState = FormWindowState.Normal;
            _diagnostics.Activate();
            return;
        }
        _diagnostics.Show();
        _diagnostics.Activate();
    }

    private void UpdateTrayStatus()
    {
        try
        {
            var snapshot = _runtime.Snapshot(includePrinters: false);
            var cloud = snapshot.Configuration.CloudConfigured
                ? string.IsNullOrWhiteSpace(snapshot.Configuration.LastCloudError) ? "cloud connected" : "cloud needs attention"
                : "local printing only";
            _trayIcon.Text = Truncate($"Cenciss Connector — {(snapshot.LocalOnline ? "running" : "offline")}, {cloud}", 63);
        }
        catch
        {
            _trayIcon.Text = "Cenciss Print Connector — needs attention";
        }
    }

    private void ConfirmExit()
    {
        if (MessageBox.Show(
                "Exit Cenciss Print Connector? Printing from Cenciss will stop until the connector is started again or Windows is restarted.",
                AppPaths.ProductName,
                MessageBoxButtons.YesNo,
                MessageBoxIcon.Warning,
                MessageBoxDefaultButton.Button2) == DialogResult.Yes)
            Shutdown(restart: false);
    }

    private async void Shutdown(bool restart, int exitCode = 0)
    {
        if (_shuttingDown) return;
        _shuttingDown = true;
        ExitCode = exitCode;
        _trayIcon.Text = "Cenciss Print Connector — stopping";
        _trayIcon.Visible = false;
        try { await _runtime.DisposeAsync(); }
        catch { ExitCode = 1; }

        if (restart)
        {
            try
            {
                Process.Start(new ProcessStartInfo
                {
                    FileName = Environment.ProcessPath!,
                    Arguments = $"--restart-task-after {Environment.ProcessId}",
                    UseShellExecute = true,
                });
            }
            catch
            {
                ExitCode = 1;
            }
        }
        ExitThread();
    }

    private void OnThreadException(object sender, ThreadExceptionEventArgs eventArgs)
    {
        new ConnectorLogger().Error($"UI failure: {eventArgs.Exception.Message}");
        MessageBox.Show(eventArgs.Exception.Message, AppPaths.ProductName, MessageBoxButtons.OK, MessageBoxIcon.Error);
    }

    private void OnUnhandledException(object? sender, UnhandledExceptionEventArgs eventArgs)
    {
        var message = eventArgs.ExceptionObject is Exception exception ? exception.Message : "Unknown fatal error.";
        new ConnectorLogger().Error($"Unhandled failure: {message}");
        if (eventArgs.IsTerminating) ExitCode = 1;
    }

    private static void OpenDataDirectory()
    {
        Directory.CreateDirectory(AppPaths.DataDirectory);
        Process.Start(new ProcessStartInfo("explorer.exe", $"\"{AppPaths.DataDirectory}\"") { UseShellExecute = true });
    }

    private static string Truncate(string value, int length) => value.Length <= length ? value : value[..length];
}
