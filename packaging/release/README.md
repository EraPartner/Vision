# Vision **VERSION** — macOS

Vision is a self-hosted financial transaction manager. The native macOS application keeps its
database and attachments on your Mac. Normal installation and daily use do not require Homebrew,
Postgres.app, Python, or a separately installed Chrome.

## What's in this release

| File                               | Purpose                                           |
| ---------------------------------- | ------------------------------------------------- |
| `Vision-__VERSION__-arm64.dmg`     | Application installer for Apple Silicon           |
| `Vision-__VERSION__-arm64-mac.zip` | Same application as a ZIP; alternative to the DMG |
| `README.md`                        | This file                                         |
| `*.sha256`                         | SHA-256 checksums for each release artifact       |

The application contains PostgreSQL 18.6, the Vision backend, the production frontend, the
migration runner, and Chrome Headless Shell for PDF reports. PostgreSQL data and attachments are
stored outside the application bundle so replacing `Vision.app` does not replace user data.

## Requirements

- macOS 12 Monterey or newer
- Apple Silicon
- Enough free disk space for the application, private PostgreSQL cluster, attachments, and backups
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

The release workflow attests the DMG, native application ZIP, and source-launcher ZIP. The checksum
is the offline integrity check; the attestation binds an artifact to Vision's release workflow.

### 2. Install the app

1. Open `Vision-__VERSION__-arm64.dmg`.
2. Drag `Vision.app` to `/Applications`.
3. Eject the disk image.
4. Right-click `/Applications/Vision.app`, select **Open**, then confirm **Open**.

The one-time right-click is expected while releases use an ad-hoc signature instead of an Apple
Developer ID. Later launches can use a normal double-click.

### 3. First launch

Vision verifies its packaged runtime before it creates data. It then:

1. initializes a private PostgreSQL 18 cluster on loopback;
2. creates separate cluster-administrator, migration-owner, and application roles;
3. runs the normal Vision migration runner;
4. starts the native backend and waits for detailed readiness; and
5. opens the UI only after the database is ready.

An interrupted first launch is resumable. If the private PostgreSQL port is already occupied,
Vision fails closed and records a diagnostic instead of connecting to the unknown server.

## Existing legacy installation

This release no longer imports data from the retired container-backed runtime. Before installing
it over such an installation, use Vision 1.0.2 to complete the native cutover, verify the native
database and attachments, and create a `.visionbak` backup. This release fails closed when it sees
a legacy runtime marker so it cannot silently open an empty database.

## Daily use

Open `Vision.app`. Vision starts its private PostgreSQL server and backend, checks readiness, and
serves the production frontend over loopback. By default, quitting Vision cleanly stops both child
processes. The **Keep services running on quit** preference deliberately leaves them running for a
faster next launch.

## Updating

Use Vision's update action or replace `Vision.app` with the application from the new DMG. Native
updates verify and stage the new application, stop the native backend, atomically replace the app,
and retain a rollback copy until the new version opens.

The durable application-data directory remains in place across updates. Do not delete it as part of
an application update.

## Where data lives

| Location                                                                | Contents                                          |
| ----------------------------------------------------------------------- | ------------------------------------------------- |
| `~/Library/Application Support/Vision/native/vision/postgres/data/`     | Private PostgreSQL cluster                        |
| `~/Library/Application Support/Vision/native/vision/attachments/`       | Transaction attachments                           |
| `~/Library/Application Support/Vision/native/vision/runtime.env`        | Generated native connection settings; mode `0600` |
| `~/Library/Application Support/Vision/native/vision/logs/`              | Backend and PostgreSQL logs                       |
| `~/Library/Application Support/Vision/native/vision/runtime-state.json` | Active provider and cutover marker                |

## Backup and restore

Use the in-app backup controls to create a `.visionbak` file. Native mode preserves the existing
bundle format, optional AES-256-GCM encryption, supported frontend/localStorage state, PostgreSQL
data, and attachments. Restore rejects a newer schema, stages a fresh database and attachment tree,
and activates them only after validation. A failed activation rolls both back.

Keep at least one backup outside `~/Library/Application Support/Vision` before uninstalling or
performing a rollback.

## Troubleshooting

| Symptom                                                              | Action                                                                                                      |
| -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| **Vision cannot be opened because the developer cannot be verified** | Right-click `Vision.app`, select **Open**, then confirm **Open**.                                           |
| **Vision reports a corrupt or wrong-version native runtime**         | Reinstall the same Vision release. Do not bypass the check with an unknown PostgreSQL server.               |
| **Native PostgreSQL port is in use**                                 | Stop the unrelated listener on port `54329`, or use the documented development-only port override.          |
| **Backend does not become ready**                                    | Open Vision logs from the recovery screen and inspect `postgres.log` and `backend.log`.                     |
| **Vision reports a legacy runtime marker**                           | Reinstall Vision 1.0.2, complete and verify its native cutover, create a backup, then install this release. |

## Uninstall

Quit Vision, confirm its native services have stopped, and move `/Applications/Vision.app` to the
Trash. This leaves the application-data directory intact so the database and attachments remain
recoverable.

Deleting `~/Library/Application Support/Vision` permanently deletes the native database,
attachments, logs, and migration state. Do that only after verifying a restorable backup.

## Source code and issues

https://github.com/EraPartner/Vision
