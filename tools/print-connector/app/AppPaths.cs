namespace Cenciss.PrintConnector;

internal static class AppPaths
{
    public const string ProductName = "Cenciss Print Connector";
    public const string StartupTaskName = "Cenciss Print Connector";
    public const string Version = "1.4.3";
    public const int Port = 17873;

    public static string DataDirectory { get; } = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData),
        "Cenciss",
        "PrintConnector");

    public static string ConfigPath => Path.Combine(DataDirectory, "config.json");
    public static string CompletedJobsPath => Path.Combine(DataDirectory, "completed-jobs.json");
    public static string LogPath => Path.Combine(DataDirectory, "connector.log");
}
