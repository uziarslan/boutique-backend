using System.Diagnostics;

namespace Cenciss.PrintConnector;

internal static class Program
{
    internal const string SingleInstanceMutexName = @"Local\CencissPrintConnector";
    internal const string ShowWindowEventName = @"Local\CencissPrintConnector-Show";

    [STAThread]
    private static void Main(string[] args)
    {
        if (HandleScheduledTaskRestart(args)) return;
        WaitForPreviousInstanceIfRequested(args);
        using var mutex = new Mutex(true, SingleInstanceMutexName, out var ownsMutex);
        if (!ownsMutex)
        {
            if (args.Any(argument => argument.Equals("--open", StringComparison.OrdinalIgnoreCase))) SignalExistingInstance();
            return;
        }

        ApplicationConfiguration.Initialize();
        Application.SetUnhandledExceptionMode(UnhandledExceptionMode.CatchException);
        try
        {
            using var context = new TrayApplicationContext(args);
            Application.Run(context);
            Environment.ExitCode = context.ExitCode;
        }
        catch (Exception exception)
        {
            new ConnectorLogger().Error($"Fatal connector failure: {exception.Message}");
            if (!args.Any(argument => argument.Equals("--background", StringComparison.OrdinalIgnoreCase)))
            {
                MessageBox.Show(
                    $"Cenciss Print Connector could not start.\n\n{exception.Message}\n\nOpen diagnostics or connector.log for details.",
                    AppPaths.ProductName,
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Error);
            }
            Environment.ExitCode = 1;
        }
    }

    private static void WaitForPreviousInstanceIfRequested(IReadOnlyList<string> args)
    {
        var marker = args.ToList().FindIndex(argument => argument.Equals("--restart-wait", StringComparison.OrdinalIgnoreCase));
        if (marker < 0 || marker + 1 >= args.Count || !int.TryParse(args[marker + 1], out var processId)) return;
        try
        {
            using var process = Process.GetProcessById(processId);
            process.WaitForExit(15_000);
        }
        catch
        {
            // The previous instance has already exited.
        }
    }

    private static bool HandleScheduledTaskRestart(IReadOnlyList<string> args)
    {
        var marker = args.ToList().FindIndex(argument => argument.Equals("--restart-task-after", StringComparison.OrdinalIgnoreCase));
        if (marker < 0) return false;
        if (marker + 1 < args.Count && int.TryParse(args[marker + 1], out var processId))
        {
            try
            {
                using var process = Process.GetProcessById(processId);
                process.WaitForExit(15_000);
            }
            catch { }
        }

        try
        {
            var startInfo = new ProcessStartInfo
            {
                FileName = "schtasks.exe",
                UseShellExecute = false,
                CreateNoWindow = true,
            };
            startInfo.ArgumentList.Add("/Run");
            startInfo.ArgumentList.Add("/TN");
            startInfo.ArgumentList.Add(AppPaths.StartupTaskName);
            using var taskStart = Process.Start(startInfo) ?? throw new InvalidOperationException();
            taskStart.WaitForExit(5_000);
            if (taskStart.ExitCode == 0) return true;
        }
        catch { }

        try
        {
            Process.Start(new ProcessStartInfo
            {
                FileName = Environment.ProcessPath!,
                Arguments = "--background",
                UseShellExecute = true,
            });
        }
        catch { }
        return true;
    }

    private static void SignalExistingInstance()
    {
        try
        {
            using var showEvent = EventWaitHandle.OpenExisting(ShowWindowEventName);
            showEvent.Set();
        }
        catch
        {
            // The running instance may still be initializing.
        }
    }
}
