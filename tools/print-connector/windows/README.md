# Cenciss Print Connector for Windows

Version 1.4.3 is a native Windows tray application. It connects browser-based
Cenciss POS sessions to printers installed for the signed-in Windows user and
keeps one efficient long-poll open for reception/tablet print jobs.

## Installation

1. Download and run `Cenciss-Print-Connector-Setup-1.4.3.exe`.
2. Approve the Windows Administrator prompt.
3. Open Cenciss **Settings > Printer Settings**.
4. Paste the connector key created beside the downloaded setup and select
   **Connect & discover**.
5. If reception/tablet printing is required, link the reception print station
   from the same settings page.

The application is installed under `Program Files`, appears in Windows
**Installed Apps**, and creates a Cenciss Start Menu entry. It runs as the POS
Windows user so it sees that user's printer queues. The tray icon beside the
Windows clock opens status, printer discovery, test printing, key copying, and
logs. Closing the status window does not stop the connector.

The connector starts automatically after that Windows user signs in. Windows
Task Scheduler launches the native executable directly and restarts it after
an unexpected failure. No PowerShell host remains running.

## Compatibility and upgrades

The native application retains the version 1.2/1.3 local contract:

- `GET /health`
- `GET /printers`
- `POST /print`
- `GET`, `POST`, and `DELETE /cloud-config`
- loopback address `http://127.0.0.1:17873`
- `X-Cenciss-Connector-Key` authentication
- the existing durable cloud claim/complete/fail protocol

Setup preserves the connector key, cloud API address, reception-station token,
and completed cloud-job identifiers. It verifies version 1.4.3 and printer-key
access before completing. If verification fails, setup restores the previous
configuration, executable, and Scheduled Task.

Version 1.4.3 migrates connector secrets from plaintext configuration into
Windows user-protected storage. Configuration and rotating logs remain under
`%ProgramData%\Cenciss\PrintConnector` with access granted only to the selected
POS Windows user and administrators.

## Uninstall

Use Windows **Settings > Apps > Installed apps > Cenciss Print Connector** or
the Cenciss Start Menu uninstall shortcut. Uninstall asks whether the connector
key and station pairing should be retained for a future reinstall.

## Production build

Run `build-release.ps1` on Windows with the .NET 8 SDK, Windows SDK, and the
Cenciss Authenticode certificate installed:

```powershell
$env:CENCISS_SIGNING_CERT_THUMBPRINT = '<certificate thumbprint>'
.\build-release.ps1
```

The script signs the background application before embedding it, signs and
verifies the final setup, and prints the release SHA-256 hash. An unsigned local
test build can be produced explicitly with:

```powershell
.\build-release.ps1 -UnsignedDevelopmentBuild
```

Unsigned builds must never be published as production downloads.

## Legacy sources

The PowerShell files in this directory are retained only as version 1.3
reference material and for auditing old installations. Version 1.4.3 setup does
not install or execute them.
