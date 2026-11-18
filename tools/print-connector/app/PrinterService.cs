using System.Drawing;
using System.Drawing.Printing;
using System.Runtime.InteropServices;

namespace Cenciss.PrintConnector;

internal sealed record WindowsPrinter(
    string Name,
    string DriverName,
    string PortName,
    bool Shared,
    string Type);

internal sealed class PrinterService : IDisposable
{
    private const uint PrinterEnumLocal = 0x00000002;
    private const uint PrinterEnumConnections = 0x00000004;
    private const uint PrinterAttributeShared = 0x00000008;
    private const uint PrinterAttributeNetwork = 0x00000010;
    private const int ErrorInsufficientBuffer = 122;
    private const int MaximumPrintCharacters = 500_000;
    private readonly SemaphoreSlim _printGate = new(1, 1);

    public IReadOnlyList<WindowsPrinter> GetInstalledPrinters()
    {
        uint needed = 0;
        uint returned = 0;
        EnumPrinters(PrinterEnumLocal | PrinterEnumConnections, null, 2, IntPtr.Zero, 0, ref needed, ref returned);
        var error = Marshal.GetLastWin32Error();
        if (needed == 0)
        {
            if (error != 0 && error != ErrorInsufficientBuffer) throw new System.ComponentModel.Win32Exception(error);
            return Array.Empty<WindowsPrinter>();
        }

        var buffer = Marshal.AllocHGlobal((int)needed);
        try
        {
            if (!EnumPrinters(PrinterEnumLocal | PrinterEnumConnections, null, 2, buffer, needed, ref needed, ref returned))
                throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());

            var printers = new List<WindowsPrinter>((int)returned);
            var itemSize = Marshal.SizeOf<PrinterInfo2>();
            for (var index = 0; index < returned; index++)
            {
                var item = Marshal.PtrToStructure<PrinterInfo2>(IntPtr.Add(buffer, checked((int)index * itemSize)));
                var name = ReadPointer(item.PrinterName);
                if (string.IsNullOrWhiteSpace(name)) continue;
                printers.Add(new WindowsPrinter(
                    name,
                    ReadPointer(item.DriverName),
                    ReadPointer(item.PortName),
                    (item.Attributes & PrinterAttributeShared) != 0,
                    (item.Attributes & PrinterAttributeNetwork) != 0 ? "Network" : "Windows"));
            }
            return printers.OrderBy(printer => printer.Name, StringComparer.CurrentCultureIgnoreCase).ToArray();
        }
        finally
        {
            Marshal.FreeHGlobal(buffer);
        }
    }

    public async Task PrintTextAsync(
        string printerName,
        string text,
        string? jobName,
        int copies,
        CancellationToken cancellationToken)
    {
        if (string.IsNullOrWhiteSpace(printerName)) throw new InvalidOperationException("Printer name is required.");
        if (string.IsNullOrWhiteSpace(text)) throw new InvalidOperationException("Print job is empty.");
        if (text.Length > MaximumPrintCharacters) throw new InvalidOperationException("Print job is too large.");
        if (!GetInstalledPrinters().Any(printer => string.Equals(printer.Name, printerName, StringComparison.OrdinalIgnoreCase)))
            throw new InvalidOperationException($"Windows printer '{printerName}' is not installed for this user.");

        await _printGate.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            await Task.Run(() => PrintText(printerName, text, jobName, copies), cancellationToken).ConfigureAwait(false);
        }
        finally
        {
            _printGate.Release();
        }
    }

    public Task PrintTestPageAsync(string printerName, CancellationToken cancellationToken) => PrintTextAsync(
        printerName,
        $"*** CENCISS TEST PRINT ***\r\n\r\nPrinter: {printerName}\r\nComputer: {Environment.MachineName}\r\nUser: {Environment.UserDomainName}\\{Environment.UserName}\r\nTime: {DateTimeOffset.Now:yyyy-MM-dd HH:mm:ss zzz}\r\n\r\nConnector {AppPaths.Version} is working.\r\n",
        "Cenciss Connector Test",
        1,
        cancellationToken);

    public void Dispose() => _printGate.Dispose();

    private static void PrintText(string printerName, string text, string? jobName, int copies)
    {
        using var document = new PrintDocument();
        document.PrinterSettings.PrinterName = printerName;
        document.PrinterSettings.Copies = (short)Math.Clamp(copies <= 0 ? 1 : copies, 1, 10);
        document.DocumentName = string.IsNullOrWhiteSpace(jobName) ? "Cenciss Print Job" : jobName;
        document.PrintController = new StandardPrintController();
        document.DefaultPageSettings.Margins = new Margins(4, 4, 4, 4);

        using var font = new Font("Consolas", 10, FontStyle.Regular, GraphicsUnit.Point);
        var lines = text.Replace("\r\n", "\n", StringComparison.Ordinal).Replace('\r', '\n').Split('\n');
        var lineIndex = 0;
        PrintPageEventHandler handler = (_, eventArgs) =>
        {
            var graphics = eventArgs.Graphics ?? throw new InvalidOperationException("Windows did not provide a printer drawing surface.");
            var y = eventArgs.MarginBounds.Top;
            var height = (int)Math.Ceiling(font.GetHeight(graphics));
            while (lineIndex < lines.Length)
            {
                if (y + height > eventArgs.MarginBounds.Bottom)
                {
                    eventArgs.HasMorePages = true;
                    return;
                }
                graphics.DrawString(lines[lineIndex], font, Brushes.Black, eventArgs.MarginBounds.Left, y);
                lineIndex++;
                y += height;
            }
            eventArgs.HasMorePages = false;
        };

        document.PrintPage += handler;
        try
        {
            document.Print();
        }
        finally
        {
            document.PrintPage -= handler;
        }
    }

    private static string ReadPointer(IntPtr pointer) => pointer == IntPtr.Zero ? string.Empty : Marshal.PtrToStringUni(pointer) ?? string.Empty;

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct PrinterInfo2
    {
        public IntPtr ServerName;
        public IntPtr PrinterName;
        public IntPtr ShareName;
        public IntPtr PortName;
        public IntPtr DriverName;
        public IntPtr Comment;
        public IntPtr Location;
        public IntPtr DevMode;
        public IntPtr SeparatorFile;
        public IntPtr PrintProcessor;
        public IntPtr DataType;
        public IntPtr Parameters;
        public IntPtr SecurityDescriptor;
        public uint Attributes;
        public uint Priority;
        public uint DefaultPriority;
        public uint StartTime;
        public uint UntilTime;
        public uint Status;
        public uint JobCount;
        public uint AveragePagesPerMinute;
    }

    [DllImport("winspool.drv", EntryPoint = "EnumPrintersW", SetLastError = true, CharSet = CharSet.Unicode)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool EnumPrinters(
        uint flags,
        string? name,
        uint level,
        IntPtr printerEnum,
        uint bufferSize,
        ref uint bytesNeeded,
        ref uint printersReturned);
}
