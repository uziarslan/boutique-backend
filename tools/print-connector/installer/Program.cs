using Microsoft.Win32;
using System.Diagnostics;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security;
using System.Security.Principal;
using System.Text;
using System.Text.Json;
using System.Xml;
using System.Xml.Linq;

internal static class Program
{
    private const string ProductName = "Cenciss Print Connector";
    private const string ProductVersion = "1.4.3";
    private const string Publisher = "Cenciss";
    private const string TaskName = "Cenciss Print Connector";
    private const string UninstallRegistryKey = @"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\CencissPrintConnector";
    private const string RuntimeResourceName = "CencissPrintConnector.exe";
    private const uint MoveFileDelayUntilReboot = 0x00000004;

    private static readonly string InstallDirectory = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles),
        "Cenciss",
        "Print Connector");
    private static readonly string RuntimePath = Path.Combine(InstallDirectory, "CencissPrintConnector.exe");
    private static readonly string InstalledSetupPath = Path.Combine(InstallDirectory, "CencissPrintConnectorSetup.exe");
    private static readonly string DataDirectory = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData),
        "Cenciss",
        "PrintConnector");
    private static readonly string ConfigPath = Path.Combine(DataDirectory, "config.json");

    [STAThread]
    private static int Main(string[] args)
    {
        try
        {
            if (args.Any(argument => argument.Equals("/uninstall", StringComparison.OrdinalIgnoreCase)))
                return Uninstall();

            var keyOutputPath = ReadArgument(args, "--key-output")
                ?? Path.Combine(AppContext.BaseDirectory, "Cenciss Connector Key.txt");
            return Install(keyOutputPath);
        }
        catch (Exception exception)
        {
            ShowMessage($"Setup failed.\n\n{exception.Message}", ProductName, 0x10);
            return 1;
        }
    }

    private static int Install(string keyOutputPath)
    {
        var interactiveUser = InteractiveUser.Get();
        var staging = Path.Combine(Path.GetTempPath(), $"CencissPrintConnector-{Guid.NewGuid():N}");
        Directory.CreateDirectory(staging);
        RollbackState? rollback = null;
        string? connectorKey = null;

        try
        {
            Directory.CreateDirectory(InstallDirectory);
            Directory.CreateDirectory(DataDirectory);
            RepairDataAccess(interactiveUser.Sid);

            // Older PowerShell connector releases could leave config.json with
            // an ACL owned by the POS user. Repair access before attempting the
            // rollback copy so an elevated setup running as a separate Windows
            // administrator can safely preserve the existing key and pairing.
            rollback = CaptureRollback(staging);
            connectorKey = EnsureLegacyCompatibleConfiguration();

            StopConnector();

            var stagedRuntime = Path.Combine(staging, RuntimeResourceName);
            ExtractResource(RuntimeResourceName, stagedRuntime);
            ReplaceFile(stagedRuntime, RuntimePath);
            if (!PathsEqual(Environment.ProcessPath!, InstalledSetupPath)) File.Copy(Environment.ProcessPath!, InstalledSetupPath, true);

            ConfigureLoopbackReservation(interactiveUser.AccountName);
            RegisterStartupTask(interactiveUser, RuntimePath);
            VerifyStartupTask();
            RegisterInstalledApplication();
            CreateStartMenuShortcuts();
            StartScheduledTask();

            var verification = VerifyRunningConnector(connectorKey);
            var writtenKeyPath = !string.IsNullOrWhiteSpace(connectorKey)
                ? WriteConnectorKey(keyOutputPath, connectorKey, interactiveUser.Sid)
                : null;

            TryDeleteLegacyRuntimeScript();
            var keyMessage = !string.IsNullOrWhiteSpace(writtenKeyPath)
                ? $"Connector key saved to:\n{writtenKeyPath}\n\n"
                : "Your existing connector key and reception pairing were preserved. You can copy the key from the connector's tray-window diagnostics.\n\n";
            ShowMessage(
                $"{ProductName} {ProductVersion} was installed successfully.\n\n" +
                $"Windows user: {interactiveUser.AccountName}\n" +
                $"Windows printers found: {verification.PrinterCountDisplay}\n\n" +
                keyMessage +
                "The connector now runs as a Windows tray application. It will start automatically after Windows sign-in and restart after an unexpected failure.",
                "Installation complete",
                0x40);
            return 0;
        }
        catch
        {
            if (rollback is not null) RestoreRollback(rollback, interactiveUser);
            throw;
        }
        finally
        {
            TryDeleteDirectory(staging);
        }
    }

    private static int Uninstall()
    {
        var answer = MessageBox(
            IntPtr.Zero,
            "Remove Cenciss Print Connector from this computer? Printing through the Windows connector will stop.",
            ProductName,
            0x00000004 | 0x00000030 | 0x00000100);
        if (answer != 6) return 0;

        var keepConfiguration = MessageBox(
            IntPtr.Zero,
            "Keep the connector key and reception-station pairing for a future reinstall?\n\nChoose Yes to keep the configuration (recommended), or No to remove all connector data.",
            ProductName,
            0x00000003 | 0x00000020 | 0x00000100);
        if (keepConfiguration == 2) return 0;

        StopConnector();
        RunProcess("schtasks.exe", ["/Delete", "/TN", TaskName, "/F"], allowFailure: true);
        RunProcess("netsh.exe", ["http", "delete", "urlacl", "url=http://127.0.0.1:17873/"], allowFailure: true);
        DeleteStartMenuShortcuts();
        Registry.LocalMachine.DeleteSubKeyTree(UninstallRegistryKey, throwOnMissingSubKey: false);

        if (keepConfiguration == 7) TryDeleteDirectory(DataDirectory);
        DeleteInstalledFiles();
        ShowMessage(
            keepConfiguration == 6
                ? "Cenciss Print Connector was removed. Its connector key and station pairing were kept for a future reinstall."
                : "Cenciss Print Connector and its configuration were removed.",
            ProductName,
            0x40);
        return 0;
    }

    private static RollbackState CaptureRollback(string staging)
    {
        var taskQuery = RunProcess("schtasks.exe", ["/Query", "/TN", TaskName, "/XML"], allowFailure: true);
        var configBackup = CopyForRollback(ConfigPath, Path.Combine(staging, "config.json.backup"));
        var runtimeBackup = CopyForRollback(RuntimePath, Path.Combine(staging, "runtime.exe.backup"));
        var setupBackup = CopyForRollback(InstalledSetupPath, Path.Combine(staging, "setup.exe.backup"));
        using var installedRegistration = Registry.LocalMachine.OpenSubKey(UninstallRegistryKey);
        return new RollbackState(
            string.IsNullOrWhiteSpace(taskQuery.Output) ? null : taskQuery.Output,
            configBackup,
            runtimeBackup,
            setupBackup,
            File.Exists(ConfigPath),
            installedRegistration is not null);
    }

    private static void RestoreRollback(RollbackState rollback, InteractiveUser interactiveUser)
    {
        try
        {
            StopConnector();
            RunProcess("schtasks.exe", ["/Delete", "/TN", TaskName, "/F"], allowFailure: true);

            if (rollback.HadConfig)
            {
                if (rollback.ConfigBackup is not null) File.Copy(rollback.ConfigBackup, ConfigPath, true);
            }
            else if (File.Exists(ConfigPath)) File.Delete(ConfigPath);

            RestoreFile(rollback.RuntimeBackup, RuntimePath);
            RestoreFile(rollback.SetupBackup, InstalledSetupPath);
            ConfigureLoopbackReservation(interactiveUser.AccountName);

            if (!rollback.HadInstalledRegistration)
            {
                DeleteStartMenuShortcuts();
                Registry.LocalMachine.DeleteSubKeyTree(UninstallRegistryKey, throwOnMissingSubKey: false);
            }

            if (!string.IsNullOrWhiteSpace(rollback.TaskXml))
            {
                var taskFile = Path.Combine(Path.GetTempPath(), $"CencissTask-{Guid.NewGuid():N}.xml");
                File.WriteAllText(taskFile, rollback.TaskXml, new UnicodeEncoding(false, true));
                try
                {
                    RunProcess("schtasks.exe", ["/Create", "/TN", TaskName, "/XML", taskFile, "/F"]);
                    StartScheduledTask();
                }
                finally
                {
                    if (File.Exists(taskFile)) File.Delete(taskFile);
                }
            }
        }
        catch
        {
            // Preserve the original installation error; rollback is best effort.
        }
    }

    private static string? EnsureLegacyCompatibleConfiguration()
    {
        if (File.Exists(ConfigPath))
        {
            using var document = JsonDocument.Parse(File.ReadAllText(ConfigPath));
            if (document.RootElement.TryGetProperty("secret", out var secretValue) && secretValue.ValueKind == JsonValueKind.String)
                return secretValue.GetString();
            if (document.RootElement.TryGetProperty("secretProtected", out _)) return null;
            throw new InvalidOperationException("The existing connector configuration does not contain a connector key. Reinstall was stopped so the current pairing is not overwritten.");
        }

        var key = Convert.ToBase64String(System.Security.Cryptography.RandomNumberGenerator.GetBytes(24));
        var configuration = "{\n" +
            $"  \"secret\": \"{JsonEncodedText.Encode(key)}\",\n" +
            $"  \"installedAt\": \"{JsonEncodedText.Encode(DateTimeOffset.UtcNow.ToString("O"))}\"\n" +
            "}";
        File.WriteAllText(ConfigPath, configuration, new UTF8Encoding(false));
        return key;
    }

    private static string WriteConnectorKey(string preferredPath, string connectorKey, string userSid)
    {
        try
        {
            var directory = Path.GetDirectoryName(Path.GetFullPath(preferredPath));
            if (!string.IsNullOrWhiteSpace(directory)) Directory.CreateDirectory(directory);
            File.WriteAllText(preferredPath, connectorKey + Environment.NewLine, new UTF8Encoding(false));
            return preferredPath;
        }
        catch
        {
            using var profileKey = Registry.LocalMachine.OpenSubKey($@"SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList\{userSid}");
            var profilePath = Environment.ExpandEnvironmentVariables(profileKey?.GetValue("ProfileImagePath") as string ?? string.Empty);
            var fallbackDirectory = !string.IsNullOrWhiteSpace(profilePath) && Directory.Exists(profilePath)
                ? Path.Combine(profilePath, "Desktop")
                : Environment.GetFolderPath(Environment.SpecialFolder.CommonDesktopDirectory);
            Directory.CreateDirectory(fallbackDirectory);
            var fallbackPath = Path.Combine(fallbackDirectory, "Cenciss Connector Key.txt");
            File.WriteAllText(fallbackPath, connectorKey + Environment.NewLine, new UTF8Encoding(false));
            return fallbackPath;
        }
    }

    private static void RegisterStartupTask(InteractiveUser user, string executablePath)
    {
        XNamespace taskNamespace = "http://schemas.microsoft.com/windows/2004/02/mit/task";
        var definition = new XDocument(
            new XDeclaration("1.0", "UTF-16", null),
            new XElement(taskNamespace + "Task",
                new XAttribute("version", "1.4"),
                new XElement(taskNamespace + "RegistrationInfo",
                    new XElement(taskNamespace + "Description", "Background Windows printer bridge and cloud kitchen-ticket worker for Cenciss POS."),
                    new XElement(taskNamespace + "Author", Publisher)),
                new XElement(taskNamespace + "Triggers",
                    new XElement(taskNamespace + "LogonTrigger",
                        new XElement(taskNamespace + "Enabled", true),
                        new XElement(taskNamespace + "UserId", user.Sid))),
                new XElement(taskNamespace + "Principals",
                    new XElement(taskNamespace + "Principal",
                        new XAttribute("id", "Author"),
                        new XElement(taskNamespace + "UserId", user.Sid),
                        new XElement(taskNamespace + "LogonType", "InteractiveToken"),
                        new XElement(taskNamespace + "RunLevel", "LeastPrivilege"))),
                new XElement(taskNamespace + "Settings",
                    new XElement(taskNamespace + "MultipleInstancesPolicy", "IgnoreNew"),
                    new XElement(taskNamespace + "DisallowStartIfOnBatteries", false),
                    new XElement(taskNamespace + "StopIfGoingOnBatteries", false),
                    new XElement(taskNamespace + "AllowHardTerminate", true),
                    new XElement(taskNamespace + "StartWhenAvailable", true),
                    new XElement(taskNamespace + "AllowStartOnDemand", true),
                    new XElement(taskNamespace + "Enabled", true),
                    new XElement(taskNamespace + "Hidden", false),
                    new XElement(taskNamespace + "ExecutionTimeLimit", "PT0S"),
                    new XElement(taskNamespace + "Priority", 7),
                    new XElement(taskNamespace + "RestartOnFailure",
                        new XElement(taskNamespace + "Interval", "PT1M"),
                        new XElement(taskNamespace + "Count", 10))),
                new XElement(taskNamespace + "Actions",
                    new XAttribute("Context", "Author"),
                    new XElement(taskNamespace + "Exec",
                        new XElement(taskNamespace + "Command", executablePath),
                        new XElement(taskNamespace + "Arguments", "--background"),
                        new XElement(taskNamespace + "WorkingDirectory", InstallDirectory)))));

        var taskFile = Path.Combine(Path.GetTempPath(), $"CencissTask-{Guid.NewGuid():N}.xml");
        using (var taskWriter = XmlWriter.Create(taskFile, new XmlWriterSettings
        {
            Encoding = new UnicodeEncoding(false, true),
            Indent = false,
        }))
        {
            definition.Save(taskWriter);
        }
        try
        {
            RunProcess("schtasks.exe", ["/Create", "/TN", TaskName, "/XML", taskFile, "/F"]);
        }
        finally
        {
            TryDeleteFile(taskFile);
        }
    }

    private static void VerifyStartupTask()
    {
        var query = RunProcess("schtasks.exe", ["/Query", "/TN", TaskName, "/XML"]);
        var definition = XDocument.Parse(query.Output);
        XNamespace taskNamespace = "http://schemas.microsoft.com/windows/2004/02/mit/task";
        var command = definition.Descendants(taskNamespace + "Command").FirstOrDefault()?.Value;
        var restartCount = definition.Descendants(taskNamespace + "RestartOnFailure")
            .Elements(taskNamespace + "Count")
            .Select(value => int.TryParse(value.Value, out var count) ? count : 0)
            .FirstOrDefault();
        if (!string.Equals(command, RuntimePath, StringComparison.OrdinalIgnoreCase))
            throw new InvalidOperationException("The connector startup task does not point to the installed native application.");
        if (restartCount < 1)
            throw new InvalidOperationException("The connector startup task is missing crash recovery.");
    }

    private static VerificationResult VerifyRunningConnector(string? connectorKey)
    {
        using var client = new HttpClient { Timeout = TimeSpan.FromSeconds(2) };
        Exception? lastError = null;
        for (var attempt = 0; attempt < 30; attempt++)
        {
            try
            {
                using var healthResponse = client.GetAsync("http://127.0.0.1:17873/health").GetAwaiter().GetResult();
                var healthJson = healthResponse.Content.ReadAsStringAsync().GetAwaiter().GetResult();
                using var health = JsonDocument.Parse(healthJson);
                var version = health.RootElement.TryGetProperty("version", out var versionValue) ? versionValue.GetString() : null;
                if (!healthResponse.IsSuccessStatusCode || !string.Equals(version, ProductVersion, StringComparison.Ordinal))
                    throw new InvalidOperationException($"Expected connector {ProductVersion}, but local health reported {version ?? "no version"}.");

                if (string.IsNullOrWhiteSpace(connectorKey)) return new VerificationResult("preserved configuration");
                using var printersRequest = new HttpRequestMessage(HttpMethod.Get, "http://127.0.0.1:17873/printers");
                printersRequest.Headers.TryAddWithoutValidation("X-Cenciss-Connector-Key", connectorKey);
                using var printersResponse = client.Send(printersRequest);
                var printersJson = printersResponse.Content.ReadAsStringAsync().GetAwaiter().GetResult();
                if (!printersResponse.IsSuccessStatusCode) throw new InvalidOperationException("The connector rejected its preserved key.");
                using var printers = JsonDocument.Parse(printersJson);
                var count = printers.RootElement.TryGetProperty("printers", out var list) && list.ValueKind == JsonValueKind.Array
                    ? list.GetArrayLength()
                    : 0;
                return new VerificationResult(count.ToString());
            }
            catch (Exception exception)
            {
                lastError = exception;
                Thread.Sleep(500);
            }
        }
        throw new InvalidOperationException($"The native connector was installed but did not pass its startup self-check: {lastError?.Message ?? "no response"}");
    }

    private static void RegisterInstalledApplication()
    {
        using var key = Registry.LocalMachine.CreateSubKey(UninstallRegistryKey, writable: true)
            ?? throw new InvalidOperationException("Windows Installed Apps registration could not be created.");
        key.SetValue("DisplayName", ProductName);
        key.SetValue("DisplayVersion", ProductVersion);
        key.SetValue("Publisher", Publisher);
        key.SetValue("InstallLocation", InstallDirectory);
        key.SetValue("DisplayIcon", $"\"{RuntimePath}\"");
        key.SetValue("UninstallString", $"\"{InstalledSetupPath}\" /uninstall");
        key.SetValue("ModifyPath", $"\"{InstalledSetupPath}\" /repair");
        key.SetValue("NoModify", 0, RegistryValueKind.DWord);
        key.SetValue("NoRepair", 0, RegistryValueKind.DWord);
        key.SetValue("EstimatedSize", (int)Math.Max(1, (new FileInfo(RuntimePath).Length + new FileInfo(InstalledSetupPath).Length) / 1024), RegistryValueKind.DWord);
    }

    private static void CreateStartMenuShortcuts()
    {
        var folder = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonPrograms), "Cenciss");
        Directory.CreateDirectory(folder);
        var connectorShortcut = Path.Combine(folder, "Cenciss Print Connector.lnk");
        var uninstallShortcut = Path.Combine(folder, "Uninstall Cenciss Print Connector.lnk");
        var script = "$ErrorActionPreference='Stop';" +
            "$shell=New-Object -ComObject WScript.Shell;" +
            $"$shortcut=$shell.CreateShortcut('{PowerShellLiteral(connectorShortcut)}');" +
            $"$shortcut.TargetPath='{PowerShellLiteral(RuntimePath)}';" +
            "$shortcut.Arguments='--open';" +
            $"$shortcut.WorkingDirectory='{PowerShellLiteral(InstallDirectory)}';" +
            "$shortcut.Description='Open Cenciss Print Connector status and diagnostics.';" +
            $"$shortcut.IconLocation='{PowerShellLiteral(RuntimePath)},0';" +
            "$shortcut.Save();" +
            $"$shortcut=$shell.CreateShortcut('{PowerShellLiteral(uninstallShortcut)}');" +
            $"$shortcut.TargetPath='{PowerShellLiteral(InstalledSetupPath)}';" +
            "$shortcut.Arguments='/uninstall';" +
            $"$shortcut.WorkingDirectory='{PowerShellLiteral(InstallDirectory)}';" +
            "$shortcut.Description='Remove Cenciss Print Connector.';" +
            $"$shortcut.IconLocation='{PowerShellLiteral(RuntimePath)},0';" +
            "$shortcut.Save();";
        var encodedScript = Convert.ToBase64String(Encoding.Unicode.GetBytes(script));
        RunProcess("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-EncodedCommand", encodedScript]);
    }

    private static string PowerShellLiteral(string value) => value.Replace("'", "''");

    private static void DeleteStartMenuShortcuts()
    {
        var folder = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonPrograms), "Cenciss");
        TryDeleteFile(Path.Combine(folder, "Cenciss Print Connector.lnk"));
        TryDeleteFile(Path.Combine(folder, "Uninstall Cenciss Print Connector.lnk"));
        try
        {
            if (Directory.Exists(folder) && !Directory.EnumerateFileSystemEntries(folder).Any()) Directory.Delete(folder);
        }
        catch { }
    }

    private static void RepairDataAccess(string userSid)
    {
        // Repair every path directly instead of relying on /T inheritance.
        // Older releases can leave config.json with a file-specific deny ACL;
        // repairing only its parent directory does not remove that entry.
        RepairPathAccess(DataDirectory, userSid);

        try
        {
            if (File.Exists(ConfigPath))
            {
                using var config = new FileStream(
                    ConfigPath,
                    FileMode.Open,
                    FileAccess.Read,
                    FileShare.ReadWrite | FileShare.Delete);
            }

            var probePath = Path.Combine(DataDirectory, $"setup-access-{Guid.NewGuid():N}.tmp");
            File.WriteAllText(probePath, "ok", new UTF8Encoding(false));
            File.Delete(probePath);
        }
        catch (Exception exception)
        {
            throw new InvalidOperationException(
                $"Setup repaired the Windows permissions but could not verify read/write access to {DataDirectory}: {exception.Message}",
                exception);
        }
    }

    private static void RepairPathAccess(string path, string userSid)
    {
        var ownershipResult = RunProcess("takeown.exe", ["/F", path, "/A"], allowFailure: true);
        if (ownershipResult.ExitCode != 0)
        {
            throw new InvalidOperationException(
                $"Setup could not take ownership of {path}. " +
                $"Windows returned code {ownershipResult.ExitCode}: {FirstNonEmpty(ownershipResult.Error, ownershipResult.Output)}");
        }

        var resetResult = RunProcess("icacls.exe", [path, "/reset", "/C"], allowFailure: true);
        if (resetResult.ExitCode != 0)
        {
            throw new InvalidOperationException(
                $"Setup could not reset permissions on {path}. " +
                $"Windows returned code {resetResult.ExitCode}: {FirstNonEmpty(resetResult.Error, resetResult.Output)}");
        }

        var attributes = File.GetAttributes(path);
        var isDirectory = attributes.HasFlag(FileAttributes.Directory);
        var systemPermission = isDirectory ? "*S-1-5-18:(OI)(CI)F" : "*S-1-5-18:F";
        var administratorPermission = isDirectory ? "*S-1-5-32-544:(OI)(CI)F" : "*S-1-5-32-544:F";
        var userPermission = isDirectory ? $"*{userSid}:(OI)(CI)M" : $"*{userSid}:M";
        var aclResult = RunProcess("icacls.exe", [
            path,
            "/inheritance:r",
            "/grant:r",
            systemPermission,
            administratorPermission,
            userPermission,
            "/C",
        ], allowFailure: true);
        if (aclResult.ExitCode != 0)
        {
            throw new InvalidOperationException(
                $"Setup could not grant connector permissions on {path}. " +
                $"Windows returned code {aclResult.ExitCode}: {FirstNonEmpty(aclResult.Error, aclResult.Output)}");
        }

        if (!isDirectory || attributes.HasFlag(FileAttributes.ReparsePoint)) return;
        foreach (var child in Directory.EnumerateFileSystemEntries(path).ToArray())
            RepairPathAccess(child, userSid);
    }

    private static void ConfigureLoopbackReservation(string accountName)
    {
        RunProcess("netsh.exe", ["http", "delete", "urlacl", "url=http://127.0.0.1:17873/"], allowFailure: true);
        RunProcess("netsh.exe", ["http", "add", "urlacl", "url=http://127.0.0.1:17873/", $"user={accountName}"]);
    }

    private static void StartScheduledTask() => RunProcess("schtasks.exe", ["/Run", "/TN", TaskName]);

    private static void StopConnector()
    {
        RunProcess("schtasks.exe", ["/End", "/TN", TaskName], allowFailure: true);
        foreach (var process in Process.GetProcessesByName("CencissPrintConnector"))
        {
            try
            {
                process.Kill(entireProcessTree: true);
                process.WaitForExit(5_000);
            }
            catch { }
            finally { process.Dispose(); }
        }
    }

    private static ProcessResult RunProcess(string fileName, IReadOnlyList<string> arguments, bool allowFailure = false)
    {
        var startInfo = new ProcessStartInfo
        {
            FileName = fileName,
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        };
        foreach (var argument in arguments) startInfo.ArgumentList.Add(argument);
        using var process = Process.Start(startInfo) ?? throw new InvalidOperationException($"Windows could not start {fileName}.");
        var output = process.StandardOutput.ReadToEnd();
        var error = process.StandardError.ReadToEnd();
        process.WaitForExit();
        if (!allowFailure && process.ExitCode != 0)
            throw new InvalidOperationException($"{fileName} failed with code {process.ExitCode}: {FirstNonEmpty(error, output)}");
        return new ProcessResult(process.ExitCode, output, error);
    }

    private static void ExtractResource(string fileName, string destination)
    {
        var assembly = Assembly.GetExecutingAssembly();
        var resource = assembly.GetManifestResourceNames().FirstOrDefault(name => name.EndsWith(fileName, StringComparison.OrdinalIgnoreCase))
            ?? throw new InvalidOperationException($"Setup resource is missing: {fileName}");
        using var source = assembly.GetManifestResourceStream(resource)!;
        using var target = File.Create(destination);
        source.CopyTo(target);
    }

    private static void ReplaceFile(string source, string destination)
    {
        var temporaryDestination = destination + ".new";
        File.Copy(source, temporaryDestination, true);
        File.Move(temporaryDestination, destination, true);
    }

    private static string? CopyForRollback(string source, string destination)
    {
        if (!File.Exists(source)) return null;
        File.Copy(source, destination, true);
        return destination;
    }

    private static void RestoreFile(string? backup, string destination)
    {
        if (PathsEqual(Environment.ProcessPath!, destination)) return;
        if (backup is not null && File.Exists(backup)) File.Copy(backup, destination, true);
        else TryDeleteFile(destination);
    }

    private static bool PathsEqual(string left, string right) =>
        string.Equals(Path.GetFullPath(left).TrimEnd(Path.DirectorySeparatorChar), Path.GetFullPath(right).TrimEnd(Path.DirectorySeparatorChar), StringComparison.OrdinalIgnoreCase);

    private static void TryDeleteLegacyRuntimeScript()
    {
        TryDeleteFile(Path.Combine(DataDirectory, "CencissPrintConnector.ps1"));
    }

    private static void DeleteInstalledFiles()
    {
        TryDeleteFile(RuntimePath);
        if (!string.Equals(Environment.ProcessPath, InstalledSetupPath, StringComparison.OrdinalIgnoreCase)) TryDeleteFile(InstalledSetupPath);
        else MoveFileEx(InstalledSetupPath, null, MoveFileDelayUntilReboot);
        try
        {
            if (Directory.Exists(InstallDirectory) && !Directory.EnumerateFileSystemEntries(InstallDirectory).Any()) Directory.Delete(InstallDirectory);
            else if (Directory.Exists(InstallDirectory)) MoveFileEx(InstallDirectory, null, MoveFileDelayUntilReboot);
        }
        catch { MoveFileEx(InstallDirectory, null, MoveFileDelayUntilReboot); }
    }

    private static void TryDeleteDirectory(string directory)
    {
        try { if (Directory.Exists(directory)) Directory.Delete(directory, true); } catch { }
    }

    private static void TryDeleteFile(string path)
    {
        try { if (File.Exists(path)) File.Delete(path); } catch { }
    }

    private static string? ReadArgument(IReadOnlyList<string> args, string name)
    {
        for (var index = 0; index < args.Count - 1; index++)
        {
            if (args[index].Equals(name, StringComparison.OrdinalIgnoreCase)) return args[index + 1];
        }
        return null;
    }

    private static string FirstNonEmpty(params string[] values) =>
        values.FirstOrDefault(value => !string.IsNullOrWhiteSpace(value))?.Trim() ?? "No error details were returned.";

    private static void ShowMessage(string text, string caption, uint icon) => MessageBox(IntPtr.Zero, text, caption, icon);

    private sealed record RollbackState(
        string? TaskXml,
        string? ConfigBackup,
        string? RuntimeBackup,
        string? SetupBackup,
        bool HadConfig,
        bool HadInstalledRegistration);

    private sealed record ProcessResult(int ExitCode, string Output, string Error);
    private sealed record VerificationResult(string PrinterCountDisplay);

    private sealed record InteractiveUser(string AccountName, string Sid)
    {
        public static InteractiveUser Get()
        {
            var accountName = GetActiveConsoleAccount();
            if (string.IsNullOrWhiteSpace(accountName)) accountName = WindowsIdentity.GetCurrent().Name;
            var sid = ((NTAccount)new NTAccount(accountName)).Translate(typeof(SecurityIdentifier)).Value;
            return new InteractiveUser(accountName, sid);
        }

        private static string GetActiveConsoleAccount()
        {
            var sessionId = WTSGetActiveConsoleSessionId();
            var user = QuerySessionString(sessionId, 5);
            var domain = QuerySessionString(sessionId, 7);
            return string.IsNullOrWhiteSpace(user)
                ? string.Empty
                : string.IsNullOrWhiteSpace(domain) ? user : $"{domain}\\{user}";
        }

        private static string QuerySessionString(uint sessionId, int infoClass)
        {
            if (!WTSQuerySessionInformation(IntPtr.Zero, sessionId, infoClass, out var buffer, out _)) return string.Empty;
            try { return Marshal.PtrToStringUni(buffer) ?? string.Empty; }
            finally { WTSFreeMemory(buffer); }
        }
    }

    [DllImport("kernel32.dll")]
    private static extern uint WTSGetActiveConsoleSessionId();

    [DllImport("wtsapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool WTSQuerySessionInformation(
        IntPtr serverHandle,
        uint sessionId,
        int infoClass,
        out IntPtr buffer,
        out uint bytesReturned);

    [DllImport("wtsapi32.dll")]
    private static extern void WTSFreeMemory(IntPtr memory);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool MoveFileEx(string existingFileName, string? newFileName, uint flags);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int MessageBox(IntPtr window, string text, string caption, uint type);
}
