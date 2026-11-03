# Vision **VERSION** — macOS

Vision is a self-hosted financial transaction manager. The native macOS application keeps its
database and attachments on your Mac. Normal installation and daily use do not require Homebrew,
a database server or a separately installed Chrome.

> **Coming from Vision 2.0?** Vision 2.0 kept its data in PostgreSQL. This version keeps it in one
> SQLite file and does not start while it finds Vision 2.0 data without one. Make a backup in
> Vision 2.0 before you install, then follow the transition guide:
> https://github.com/EraPartner/Vision/blob/main/docs/guides/sqlite-transition.md

## What's in this release

| File                               | Purpose                                           |
| ---------------------------------- | ------------------------------------------------- |
| `Vision-__VERSION__-arm64.dmg`     | Application installer for Apple Silicon           |
| `Vision-__VERSION__-arm64-mac.zip` | Same application as a ZIP; alternative to the DMG |
| `README.md`                        | This file                                         |
| `*.sha256`                         | SHA-256 checksums for each release artifact       |

The application contains Bun, the Vision backend, the production frontend and the migration
runner. The database is one SQLite file opened by the backend through the SQLite library that
ships with macOS. PDF reports print with the application's own Electron Chromium. The database
and attachments are stored outside the application bundle so replacing `Vision.app` does not
replace user data.

## Requirements

- macOS 13 Ventura or newer
- Apple Silicon
- Enough free disk space for the application, the database, attachments, and backups
- An internet connection only when downloading Vision or using an integration that itself needs it

## Install

### 1. Verify the download

```sh
shasum -a 256 -c Vision-__VERSION__-arm64.dmg.sha256
```

The line must end with `OK`.

When the GitHub CLI is available, also verify the downloaded archive's repository provenance:

```sh
gh attestation verify Vision-__VERSION__-arm64.dmg --repo EraPartner/Vision
```

The release workflow attests the DMG and native application ZIP. The checksum
is the offline integrity check; the attestation binds an artifact to Vision's release workflow.

### 2. Install the app

1. Open `Vision-__VERSION__-arm64.dmg`.
2. Drag `Vision.app` to `/Applications`.
3. Eject the disk image.
4. Open `/Applications/Vision.app` once, as described below.

Releases use an ad-hoc signature instead of an Apple Developer ID, so macOS blocks the first
launch. Allow it once; later launches can use a normal double-click.

**macOS 15 Sequoia and newer**

1. Double-click `/Applications/Vision.app`. macOS reports that it could not verify Vision. Click
   **Done**.
2. Open **System Settings → Privacy & Security** and scroll to **Security**.
3. Next to the message that Vision was blocked, click **Open Anyway** and confirm with your password
   or Touch ID.
4. Click **Open Anyway** in the dialog that follows.

**macOS 13 Ventura and macOS 14 Sonoma**

Right-click `/Applications/Vision.app`, select **Open**, then confirm **Open**.

### 3. First launch

Vision verifies its packaged runtime before it creates data. It then:

1. starts the native backend, which creates the SQLite database and runs the Vision migration
   runner;
2. waits for detailed readiness; and
3. opens the UI only after the database is ready.

Before migrations change a database that already holds data, the runner writes a copy of it to
`database/pre-migration-backups/` and keeps the newest three. If that copy cannot be written,
Vision does not start and changes nothing.

## Existing legacy installation

Legacy Electron application-data and container-backed runtimes are unsupported as of 2026-09-13.
This release does not discover, migrate, import, or block on their state. Recover any intentionally
retained legacy data outside the current application before installing this release. Current
encrypted backup and restore support applies to the canonical native runtime.

## Daily use

Open `Vision.app`. Vision starts its backend, checks readiness, and serves the production frontend
over loopback. By default, quitting Vision cleanly stops the backend. The **Keep services running
on quit** preference deliberately leaves it running for a faster next launch.

## Updating

Use Vision's update action or replace `Vision.app` with the application from the new DMG. Native
updates verify and stage the new application, stop the native backend, atomically replace the app,
and retain a rollback copy until the new version opens.

The durable application-data directory remains in place across updates. Do not delete it as part of
an application update.

## Where data lives

| Location                                                                | Contents                                          |
| ----------------------------------------------------------------------- | ------------------------------------------------- |
| `~/Library/Application Support/Vision/database/vision.sqlite3`          | The SQLite database                               |
| `~/Library/Application Support/Vision/database/pre-migration-backups/`  | Copies written before migrations                  |
| `~/Library/Application Support/Vision/native/vision/attachments/`       | Transaction attachments                           |
| `~/Library/Application Support/Vision/native/vision/runtime.env`        | Generated native settings; mode `0600`            |
| `~/Library/Application Support/Vision/native/vision/logs/`              | Backend logs                                      |
| `~/Library/Application Support/Vision/native/vision/runtime-state.json` | Active provider and cutover marker                |

## Backup and restore

Use the in-app backup controls to create a `.visionbak` file. A backup holds a copy of the SQLite
database, the attachments and supported frontend/localStorage state, with optional AES-256-GCM
encryption. Restore rejects a newer schema, stages a fresh database and attachment tree, and
activates them only after validation. A failed activation rolls both back. Backups made by
Vision 2.0 hold PostgreSQL data: restore one only after the transition script has converted it
(`bun run transition:v2 -- <backup> --to-backup <new file>`, see the transition guide).

Keep at least one backup outside `~/Library/Application Support/Vision` before uninstalling or
performing a rollback.

## Troubleshooting

| Symptom                                                      | Action                                                                                             |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| **macOS could not verify Vision**                            | Allow the first launch once, as described in [Install the app](#2-install-the-app).                |
| **Vision reports a corrupt or wrong-version native runtime** | Reinstall the same Vision release.                                                                 |
| **Vision found data from Vision 2.0 and did not start**      | Move the data once with the transition script; see the transition guide linked above.              |
| **Vision could not back up the database before migrating**   | Fix the reason the message names (often a full disk), then open Vision again. Nothing was changed. |
| **Backend does not become ready**                            | Open Vision logs from the recovery screen and inspect `backend.log`.                               |

## Uninstall

Quit Vision, confirm its native services have stopped, and move `/Applications/Vision.app` to the
Trash. This leaves the application-data directory intact so the database and attachments remain
recoverable.

Deleting `~/Library/Application Support/Vision` permanently deletes the native database,
attachments, logs, and migration state. Do that only after verifying a restorable backup.

## Source code and issues

https://github.com/EraPartner/Vision
