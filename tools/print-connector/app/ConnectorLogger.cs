using System.Text;

namespace Cenciss.PrintConnector;

internal sealed class ConnectorLogger
{
    private const long MaxLogBytes = 2 * 1024 * 1024;
    private const int RetainedFiles = 4;
    private readonly object _gate = new();

    public void Info(string message) => Write("INFO", message);
    public void Warn(string message) => Write("WARN", message);
    public void Error(string message) => Write("ERROR", message);

    private void Write(string level, string message)
    {
        try
        {
            lock (_gate)
            {
                Directory.CreateDirectory(AppPaths.DataDirectory);
                RotateIfNeeded();
                var safeMessage = message.Replace('\r', ' ').Replace('\n', ' ');
                File.AppendAllText(
                    AppPaths.LogPath,
                    $"{DateTimeOffset.Now:O} [{level}] {safeMessage}{Environment.NewLine}",
                    new UTF8Encoding(false));
            }
        }
        catch
        {
            // Logging must never stop printing.
        }
    }

    private static void RotateIfNeeded()
    {
        if (!File.Exists(AppPaths.LogPath) || new FileInfo(AppPaths.LogPath).Length < MaxLogBytes) return;

        var oldest = $"{AppPaths.LogPath}.{RetainedFiles}";
        if (File.Exists(oldest)) File.Delete(oldest);
        for (var index = RetainedFiles - 1; index >= 1; index--)
        {
            var source = $"{AppPaths.LogPath}.{index}";
            if (File.Exists(source)) File.Move(source, $"{AppPaths.LogPath}.{index + 1}", true);
        }
        File.Move(AppPaths.LogPath, $"{AppPaths.LogPath}.1", true);
    }
}
