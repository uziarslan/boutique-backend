# Cenciss Print Connector 1.4.3 Windows release gate

Do not publish the 1.4.3 download until every required check below passes on
Windows 10 and the restaurant's Windows 11 POS account with its real receipt
and kitchen printers.

## Upgrade safety

- Record the connector key, linked reception station, configured printer names,
  and current connector version before installation.
- Install 1.4.3 over connector 1.2 or 1.3 without uninstalling first.
- Repeat the upgrade while signed in as a standard POS user and approve UAC
  with a separate administrator account.
- Confirm setup repairs access to the existing ProgramData configuration while
  preserving its connector key and reception pairing.
- Confirm setup reports version 1.4.3 and the expected printer count.
- Confirm the original connector key still connects from Cenciss Printer
  Settings without editing it.
- Confirm the reception station remains linked.
- Confirm `%ProgramData%\Cenciss\PrintConnector\config.json` no longer contains
  plaintext `secret` or `stationToken` fields after the first 1.4.3 start.

## Application lifecycle

- Confirm no PowerShell or Windows Terminal window opens during installation or
  while the connector runs.
- Confirm Cenciss Print Connector appears in Windows Installed Apps and in the
  Start Menu.
- Open the tray status window, close it with X, and confirm `/health` and
  printing remain available.
- Restart the connector from its tray window and confirm the Scheduled Task
  returns to the Running state.
- End `CencissPrintConnector.exe` from Task Manager and confirm Task Scheduler
  restarts it after the configured recovery interval.
- Restart Windows, sign into the same POS account, and confirm version 1.4.3 is
  healthy without opening the connector manually.
- Repeat the restart check after applying a Windows cumulative update.
- Sign out and back in, then sleep and wake the PC, confirming recovery each
  time.

## Printing

- Use the connector window to send a test page to every configured printer.
- Print a customer receipt from the local POS.
- Print a kitchen ticket from the local POS.
- Submit a tablet/reception order and confirm its cloud ticket prints once.
- Disconnect the internet, perform a local print, and confirm it still works.
- Restore the internet and confirm cloud status reconnects without restarting.
- Turn a printer off, send a job, and confirm Windows safely retains or reports
  the spooler job without stopping prints sent to other configured printers.
- Restart the Windows Print Spooler and confirm the next print succeeds.

## Duplicate and recovery protection

- Interrupt the network immediately after a cloud job reaches the Windows
  spooler, restore the network, and confirm the physical ticket is not printed
  twice when its acknowledgement is recovered.
- Confirm `completed-jobs.json` retains no more than 1,000 job IDs.
- Confirm `connector.log` rotates instead of growing without limit.

## Uninstall and rollback

- Run setup with port 17873 deliberately occupied and confirm installation
  fails without destroying the previous connector configuration.
- Confirm a failed 1.4.3 startup restores the previous Scheduled Task and config.
- Uninstall from Windows Installed Apps while choosing to retain configuration,
  reinstall, and confirm the pairing returns.
- Uninstall again while choosing to remove configuration and confirm the app,
  task, URL reservation, Start Menu shortcuts, and ProgramData directory are
  removed.

Record the Windows build, printer models/drivers, connector SHA-256, tester,
date, and result alongside this checklist for the release record.
