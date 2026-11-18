using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace Cenciss.PrintConnector;

internal sealed record ConnectorConfigSnapshot(
    string Secret,
    string ApiBase,
    string StationToken,
    string CloudConfiguredAt,
    string LastCloudPollAt,
    string LastCloudSuccessAt,
    string LastCloudError)
{
    public bool CloudConfigured => !string.IsNullOrWhiteSpace(ApiBase) && !string.IsNullOrWhiteSpace(StationToken);

    public object ToPublicCloudStatus() => new
    {
        configured = CloudConfigured,
        apiBase = ApiBase,
        stationTokenSet = !string.IsNullOrWhiteSpace(StationToken),
        configuredAt = CloudConfiguredAt,
        lastPollAt = LastCloudPollAt,
        lastSuccessAt = LastCloudSuccessAt,
        lastError = LastCloudError,
    };
}

internal sealed class ConnectorConfigStore
{
    private readonly object _gate = new();
    private readonly ConnectorLogger _logger;
    private ConnectorConfigSnapshot _current;

    public ConnectorConfigStore(ConnectorLogger logger)
    {
        _logger = logger;
        Directory.CreateDirectory(AppPaths.DataDirectory);
        _current = Load();
    }

    public ConnectorConfigSnapshot Snapshot()
    {
        lock (_gate) return _current with { };
    }

    public void SetCloudConfiguration(string apiBase, string stationToken)
    {
        lock (_gate)
        {
            _current = _current with
            {
                ApiBase = apiBase.Trim().TrimEnd('/'),
                StationToken = stationToken.Trim(),
                CloudConfiguredAt = DateTimeOffset.UtcNow.ToString("O"),
                LastCloudError = string.Empty,
            };
            SaveLocked();
        }
    }

    public void ClearCloudConfiguration()
    {
        lock (_gate)
        {
            _current = _current with
            {
                ApiBase = string.Empty,
                StationToken = string.Empty,
                CloudConfiguredAt = string.Empty,
                LastCloudError = string.Empty,
            };
            SaveLocked();
        }
    }

    public void UpdateCloudStatus(
        string? lastPollAt = null,
        string? lastSuccessAt = null,
        string? lastError = null,
        bool persist = false)
    {
        lock (_gate)
        {
            _current = _current with
            {
                LastCloudPollAt = lastPollAt ?? _current.LastCloudPollAt,
                LastCloudSuccessAt = lastSuccessAt ?? _current.LastCloudSuccessAt,
                LastCloudError = lastError ?? _current.LastCloudError,
            };
            if (persist) SaveLocked();
        }
    }

    private ConnectorConfigSnapshot Load()
    {
        string secret = string.Empty;
        string stationToken = string.Empty;
        string apiBase = string.Empty;
        string configuredAt = string.Empty;
        string lastPollAt = string.Empty;
        string lastSuccessAt = string.Empty;
        string lastError = string.Empty;
        var migratedPlaintext = false;

        if (File.Exists(AppPaths.ConfigPath))
        {
            using var document = JsonDocument.Parse(File.ReadAllText(AppPaths.ConfigPath));
            var root = document.RootElement;
            secret = ReadProtectedOrPlain(root, "secretProtected", "secret", out var secretWasPlaintext);
            stationToken = ReadProtectedOrPlain(root, "stationTokenProtected", "stationToken", out var tokenWasPlaintext);
            migratedPlaintext = secretWasPlaintext || tokenWasPlaintext;
            apiBase = ReadString(root, "apiBase");
            configuredAt = ReadString(root, "cloudConfiguredAt");
            lastPollAt = ReadString(root, "lastCloudPollAt");
            lastSuccessAt = ReadString(root, "lastCloudSuccessAt");
            lastError = ReadString(root, "lastCloudError");
        }

        if (string.IsNullOrWhiteSpace(secret))
        {
            secret = Convert.ToBase64String(RandomNumberGenerator.GetBytes(24));
            migratedPlaintext = true;
        }

        var loaded = new ConnectorConfigSnapshot(
            secret,
            apiBase,
            stationToken,
            configuredAt,
            lastPollAt,
            lastSuccessAt,
            lastError);

        _current = loaded;
        if (migratedPlaintext || !File.Exists(AppPaths.ConfigPath))
        {
            SaveLocked();
            _logger.Info("Connector configuration migrated to Windows user-protected storage.");
        }
        return loaded;
    }

    private void SaveLocked()
    {
        var persisted = new PersistedConfig
        {
            SchemaVersion = 2,
            SecretProtected = WindowsDataProtection.Protect(_current.Secret),
            ApiBase = _current.ApiBase,
            StationTokenProtected = string.IsNullOrWhiteSpace(_current.StationToken)
                ? string.Empty
                : WindowsDataProtection.Protect(_current.StationToken),
            CloudConfiguredAt = _current.CloudConfiguredAt,
            LastCloudPollAt = _current.LastCloudPollAt,
            LastCloudSuccessAt = _current.LastCloudSuccessAt,
            LastCloudError = _current.LastCloudError,
            UpdatedAt = DateTimeOffset.UtcNow.ToString("O"),
        };
        var tempPath = $"{AppPaths.ConfigPath}.{Guid.NewGuid():N}.tmp";
        File.WriteAllText(tempPath, JsonSerializer.Serialize(persisted, JsonOptions), new UTF8Encoding(false));
        File.Move(tempPath, AppPaths.ConfigPath, true);
    }

    private static string ReadProtectedOrPlain(JsonElement root, string protectedName, string plainName, out bool wasPlaintext)
    {
        wasPlaintext = false;
        var protectedValue = ReadString(root, protectedName);
        if (!string.IsNullOrWhiteSpace(protectedValue)) return WindowsDataProtection.Unprotect(protectedValue);
        var plainValue = ReadString(root, plainName);
        wasPlaintext = !string.IsNullOrWhiteSpace(plainValue);
        return plainValue;
    }

    private static string ReadString(JsonElement root, string name) =>
        root.TryGetProperty(name, out var property) && property.ValueKind == JsonValueKind.String
            ? property.GetString() ?? string.Empty
            : string.Empty;

    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        WriteIndented = true,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    };

    private sealed class PersistedConfig
    {
        public int SchemaVersion { get; init; }
        public string SecretProtected { get; init; } = string.Empty;
        public string ApiBase { get; init; } = string.Empty;
        public string StationTokenProtected { get; init; } = string.Empty;
        public string CloudConfiguredAt { get; init; } = string.Empty;
        public string LastCloudPollAt { get; init; } = string.Empty;
        public string LastCloudSuccessAt { get; init; } = string.Empty;
        public string LastCloudError { get; init; } = string.Empty;
        public string UpdatedAt { get; init; } = string.Empty;
    }
}

internal sealed class CompletedJobStore
{
    private const int MaximumRememberedJobs = 1000;
    private readonly object _gate = new();
    private readonly Queue<string> _ordered = new();
    private readonly HashSet<string> _ids = new(StringComparer.Ordinal);

    public CompletedJobStore()
    {
        if (!File.Exists(AppPaths.CompletedJobsPath)) return;
        try
        {
            using var document = JsonDocument.Parse(File.ReadAllText(AppPaths.CompletedJobsPath));
            if (!document.RootElement.TryGetProperty("jobIds", out var values) || values.ValueKind != JsonValueKind.Array) return;
            foreach (var value in values.EnumerateArray())
            {
                var id = value.GetString();
                if (!string.IsNullOrWhiteSpace(id) && _ids.Add(id)) _ordered.Enqueue(id);
            }
            TrimLocked();
        }
        catch
        {
            // A damaged history must not prevent the connector from starting.
        }
    }

    public bool Contains(string jobId)
    {
        lock (_gate) return _ids.Contains(jobId);
    }

    public void Add(string jobId)
    {
        lock (_gate)
        {
            if (_ids.Add(jobId)) _ordered.Enqueue(jobId);
            TrimLocked();
            Directory.CreateDirectory(AppPaths.DataDirectory);
            var payload = JsonSerializer.Serialize(new
            {
                jobIds = _ordered.ToArray(),
                updatedAt = DateTimeOffset.UtcNow.ToString("O"),
            }, new JsonSerializerOptions { WriteIndented = true });
            var tempPath = $"{AppPaths.CompletedJobsPath}.{Guid.NewGuid():N}.tmp";
            File.WriteAllText(tempPath, payload, new UTF8Encoding(false));
            File.Move(tempPath, AppPaths.CompletedJobsPath, true);
        }
    }

    private void TrimLocked()
    {
        while (_ordered.Count > MaximumRememberedJobs)
        {
            _ids.Remove(_ordered.Dequeue());
        }
    }
}

internal static class WindowsDataProtection
{
    private const uint CryptProtectUiForbidden = 0x1;

    public static string Protect(string value) => Convert.ToBase64String(Transform(Encoding.UTF8.GetBytes(value), protect: true));
    public static string Unprotect(string value) => Encoding.UTF8.GetString(Transform(Convert.FromBase64String(value), protect: false));

    private static byte[] Transform(byte[] input, bool protect)
    {
        var inputPointer = Marshal.AllocHGlobal(input.Length);
        try
        {
            Marshal.Copy(input, 0, inputPointer, input.Length);
            var inputBlob = new DataBlob { Size = input.Length, Data = inputPointer };
            DataBlob outputBlob;
            var succeeded = protect
                ? CryptProtectData(ref inputBlob, null, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, CryptProtectUiForbidden, out outputBlob)
                : CryptUnprotectData(ref inputBlob, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, CryptProtectUiForbidden, out outputBlob);
            if (!succeeded) throw new InvalidOperationException($"Windows could not {(protect ? "protect" : "read")} the connector credentials.", new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error()));
            try
            {
                var output = new byte[outputBlob.Size];
                Marshal.Copy(outputBlob.Data, output, 0, output.Length);
                return output;
            }
            finally
            {
                if (outputBlob.Data != IntPtr.Zero) LocalFree(outputBlob.Data);
            }
        }
        finally
        {
            CryptographicOperations.ZeroMemory(input);
            Marshal.FreeHGlobal(inputPointer);
        }
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct DataBlob
    {
        public int Size;
        public IntPtr Data;
    }

    [DllImport("crypt32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CryptProtectData(
        ref DataBlob dataIn,
        string? description,
        IntPtr optionalEntropy,
        IntPtr reserved,
        IntPtr promptStruct,
        uint flags,
        out DataBlob dataOut);

    [DllImport("crypt32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CryptUnprotectData(
        ref DataBlob dataIn,
        IntPtr description,
        IntPtr optionalEntropy,
        IntPtr reserved,
        IntPtr promptStruct,
        uint flags,
        out DataBlob dataOut);

    [DllImport("kernel32.dll")]
    private static extern IntPtr LocalFree(IntPtr memory);
}
