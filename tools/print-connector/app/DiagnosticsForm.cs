using System.Diagnostics;

namespace Cenciss.PrintConnector;

internal sealed class DiagnosticsForm : Form
{
    private readonly ConnectorRuntime _runtime;
    private readonly Label _status = new();
    private readonly ListBox _printers = new();
    private readonly Button _testPrint = new();
    private readonly System.Windows.Forms.Timer _refreshTimer = new() { Interval = 5_000 };
    private bool _refreshing;

    public DiagnosticsForm(ConnectorRuntime runtime)
    {
        _runtime = runtime;
        Text = $"{AppPaths.ProductName} {AppPaths.Version}";
        StartPosition = FormStartPosition.CenterScreen;
        MinimumSize = new Size(620, 480);
        Size = new Size(700, 540);
        FormBorderStyle = FormBorderStyle.Sizable;
        MaximizeBox = false;

        var messageFont = SystemFonts.MessageBoxFont ?? SystemFonts.DefaultFont;
        var heading = new Label
        {
            Text = "Cenciss Print Connector",
            Font = new Font(messageFont.FontFamily, 18, FontStyle.Bold),
            AutoSize = true,
            Margin = new Padding(0, 0, 0, 6),
        };
        var subtitle = new Label
        {
            Text = "Runs quietly in the background and connects Cenciss POS to this computer's printers.",
            ForeColor = Color.DimGray,
            AutoSize = true,
            Margin = new Padding(0, 0, 0, 16),
        };
        _status.AutoSize = true;
        _status.MaximumSize = new Size(640, 0);
        _status.Margin = new Padding(0, 0, 0, 14);

        var printerLabel = new Label
        {
            Text = "Printers available to this Windows user",
            Font = new Font(messageFont, FontStyle.Bold),
            AutoSize = true,
            Margin = new Padding(0, 0, 0, 6),
        };
        _printers.Dock = DockStyle.Fill;
        _printers.IntegralHeight = false;
        _printers.SelectedIndexChanged += (_, _) => _testPrint.Enabled = _printers.SelectedItem is PrinterListItem;

        var buttons = new FlowLayoutPanel
        {
            AutoSize = true,
            Dock = DockStyle.Fill,
            FlowDirection = FlowDirection.LeftToRight,
            WrapContents = true,
            Padding = new Padding(0, 8, 0, 0),
        };
        buttons.Controls.Add(CreateButton("Refresh", async (_, _) => await RefreshStatusAsync()));
        _testPrint.Text = "Test selected printer";
        _testPrint.AutoSize = true;
        _testPrint.Enabled = false;
        _testPrint.Click += async (_, _) => await TestSelectedPrinterAsync();
        buttons.Controls.Add(_testPrint);
        buttons.Controls.Add(CreateButton("Copy connector key", (_, _) => CopyConnectorKey()));
        buttons.Controls.Add(CreateButton("Open logs", (_, _) => OpenLogs()));
        buttons.Controls.Add(CreateButton("Restart connector", (_, _) => RestartRequested?.Invoke(this, EventArgs.Empty)));

        var layout = new TableLayoutPanel
        {
            Dock = DockStyle.Fill,
            Padding = new Padding(24),
            ColumnCount = 1,
            RowCount = 6,
        };
        layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        layout.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
        layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        layout.Controls.Add(heading, 0, 0);
        layout.Controls.Add(subtitle, 0, 1);
        layout.Controls.Add(_status, 0, 2);
        layout.Controls.Add(printerLabel, 0, 3);
        layout.Controls.Add(_printers, 0, 4);
        layout.Controls.Add(buttons, 0, 5);
        Controls.Add(layout);

        VisibleChanged += async (_, _) =>
        {
            if (Visible)
            {
                _refreshTimer.Start();
                await RefreshStatusAsync();
            }
            else
            {
                _refreshTimer.Stop();
            }
        };
        FormClosing += (_, eventArgs) =>
        {
            if (eventArgs.CloseReason == CloseReason.WindowsShutDown) return;
            eventArgs.Cancel = true;
            Hide();
        };
        _refreshTimer.Tick += async (_, _) => await RefreshStatusAsync();
    }

    public event EventHandler? RestartRequested;

    protected override void Dispose(bool disposing)
    {
        if (disposing) _refreshTimer.Dispose();
        base.Dispose(disposing);
    }

    private async Task RefreshStatusAsync()
    {
        if (_refreshing || IsDisposed) return;
        _refreshing = true;
        try
        {
            var snapshot = await Task.Run(() => _runtime.Snapshot());
            var cloudStatus = !snapshot.Configuration.CloudConfigured
                ? "Not linked (local POS printing is available)"
                : string.IsNullOrWhiteSpace(snapshot.Configuration.LastCloudError)
                    ? "Linked and connected"
                    : $"Linked — last error: {snapshot.Configuration.LastCloudError}";
            _status.Text =
                $"Status: {(snapshot.LocalOnline ? "Running" : "Offline")}\n" +
                $"Local address: http://127.0.0.1:{AppPaths.Port}\n" +
                $"Windows user: {Environment.UserDomainName}\\{Environment.UserName}\n" +
                $"Cloud station: {cloudStatus}\n" +
                $"Started: {snapshot.StartedAt:yyyy-MM-dd HH:mm:ss}";

            var selectedName = (_printers.SelectedItem as PrinterListItem)?.Printer.Name;
            _printers.BeginUpdate();
            _printers.Items.Clear();
            foreach (var printer in snapshot.Printers)
            {
                var item = new PrinterListItem(printer);
                _printers.Items.Add(item);
                if (string.Equals(printer.Name, selectedName, StringComparison.OrdinalIgnoreCase)) _printers.SelectedItem = item;
            }
            _printers.EndUpdate();
        }
        catch (Exception exception)
        {
            _status.Text = $"Status could not be refreshed: {exception.Message}";
        }
        finally
        {
            _refreshing = false;
        }
    }

    private async Task TestSelectedPrinterAsync()
    {
        if (_printers.SelectedItem is not PrinterListItem selected) return;
        _testPrint.Enabled = false;
        try
        {
            await _runtime.PrintTestPageAsync(selected.Printer.Name, CancellationToken.None);
            MessageBox.Show("The test page was sent to the Windows print spooler.", AppPaths.ProductName, MessageBoxButtons.OK, MessageBoxIcon.Information);
        }
        catch (Exception exception)
        {
            MessageBox.Show($"Test print failed.\n\n{exception.Message}", AppPaths.ProductName, MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
        finally
        {
            _testPrint.Enabled = _printers.SelectedItem is PrinterListItem;
        }
    }

    private void CopyConnectorKey()
    {
        Clipboard.SetText(_runtime.ConnectorKey);
        MessageBox.Show("Connector key copied. Paste it into Cenciss Printer Settings.", AppPaths.ProductName, MessageBoxButtons.OK, MessageBoxIcon.Information);
    }

    private static void OpenLogs()
    {
        Directory.CreateDirectory(AppPaths.DataDirectory);
        Process.Start(new ProcessStartInfo("explorer.exe", $"\"{AppPaths.DataDirectory}\"") { UseShellExecute = true });
    }

    private static Button CreateButton(string text, EventHandler handler)
    {
        var button = new Button { Text = text, AutoSize = true };
        button.Click += handler;
        return button;
    }

    private sealed class PrinterListItem(WindowsPrinter printer)
    {
        public WindowsPrinter Printer { get; } = printer;
        public override string ToString() => string.IsNullOrWhiteSpace(Printer.PortName)
            ? Printer.Name
            : $"{Printer.Name}  —  {Printer.PortName}";
    }
}
