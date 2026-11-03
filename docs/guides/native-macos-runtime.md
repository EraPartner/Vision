---
title: Native macOS Runtime Guide
type: guide
status: active
date: 2026-11-03
tags:
  [guide, native-runtime, macos, electron, sqlite, backup, restore, demo, transition]
description: Build, operate, diagnose, back up, and restore Vision's bundled native macOS runtime and its SQLite database.
aliases: [native Vision, macOS runtime]
related_code:
  ["packaging/electron/runtime/native.ts", "packaging/electron/main.ts"]
---

# Native macOS Runtime Guide

> [!tip] Desktop startup and readiness
> [Open the journey](../flow-visualizer.html#native-startup). See [[docs/guides/visual-learning|Understand Vision Visually]] for the reading paths and conceptual diagrams.

Vision for macOS bundles the compiled Bun backend, the database tool `tools/db-file.js`, the
production frontend and the `db/` migration files. The backend opens one SQLite database file
in-process through the system SQLite library (3.39.0 or later, so macOS 13 or later). There is no
database server, no database port and no database credentials
([[docs/adr/263-sqlite-replaces-postgresql|ADR-263]]). Electron owns the backend's lifecycle and
prints report PDFs with its own Chromium
([[docs/adr/234-electron-report-pdf-printing|ADR-234]]).

## Build inputs

The native payload builder (`packaging/electron/scripts/prepare-native-runtime.ts`) requires:

- Bun, which compiles the backend into `vision-backend` and bundles
  `apps/node-backend/scripts/db-file.ts` into `tools/db-file.js`; and
- the production frontend (`bun run build`).

It copies the frontend to `dist/` and the whole `db/` folder, builds the `vision-apple-ai` helper on
macOS, and writes `manifest.json` with the size and SHA-256 of every file. No database payload is
downloaded or bundled. The Electron package script `prepare:native` runs it on its own:

```bash
bun run install:electron
bun run build
cd packaging/electron && bun run prepare:native
```

Release CI builds the same payload.

## Runtime data

Each runtime keeps its database and its runtime files under its own application-data directory
(`<userData>`): `~/Library/Application Support/Vision` for Vision,
`~/Library/Application Support/Vision Demo` for the Demo, and
`~/Library/Application Support/Vision Development` for source development
(`VISION_DEV_USER_DATA` overrides it).

| Path | Contents |
| --- | --- |
| `<userData>/database/vision.sqlite3` | The SQLite database, the backend's `VISION_DATABASE_PATH` |
| `<userData>/database/vision.sqlite3-wal`, `-shm` | SQLite's write-ahead log and shared-memory files |
| `<userData>/database/pre-migration-backups/` | `VACUUM INTO` copies the backend writes before it migrates a database that holds data; the newest three are kept |
| `<userData>/database.previous-*` | Earlier database directories kept after a committed restore; the newest three are kept |
| `<userData>/native/<runtime id>/runtime.env` | Provider API keys and other runtime settings, mode `0600` |
| `<userData>/native/<runtime id>/runtime-state.json` | Runtime state, including the journal of an unfinished database switch |
| `<userData>/native/<runtime id>/attachments/` | Receipt attachments, the backend's `ATTACHMENTS_DIR` |
| `<userData>/native/<runtime id>/logs/backend.log` | Backend log |
| `<userData>/native/<runtime id>/cache/` | Runtime cache |

The runtime id is `vision`, `vision_demo` or `vision_dev`. The whole `database/` directory is one
generation: the database file, its `-wal` and `-shm` files and `pre-migration-backups/` move
together when a restore swaps generations, so a write-ahead log never ends up beside the wrong
database. Directories are created with mode `0700`.

### Vision 2.0 data

Vision 2.0 kept its data in a private PostgreSQL cluster in
`<userData>/native/vision/postgres/data`. When that directory has contents and no
`database/vision.sqlite3` exists, Vision refuses to start, so that a first launch never creates an
empty database over real data. The dialog says "Vision found data from Vision 2.0 on this Mac and
did not start", names the untouched data directory and `<userData>/pre-update-backups`, and gives
the transition command (`bun run transition:v2 -- <backup file>`). Vision only checks whether the
directory has contents; it never changes or deletes it.

A `runtime.env` written by Vision 2.0 may still hold its PostgreSQL credentials. They stay in the
file for Vision 2.0, and no child process receives them. Follow
[[docs/guides/sqlite-transition|Moving Vision 2.0 data to SQLite]] to convert a Vision 2.0 backup
once.

## Start development

```bash
bun run electron:dev
```

`bun run electron:dev` opens the Electron shell on the `Vision Development` profile.
`bun run dev` prepares the same `vision_dev` layout without Electron, then runs the watched
backend (which creates and migrates the SQLite database on boot) and the Vite frontend
(`packaging/electron/scripts/native-development.ts`).

Electron startup prepares the layout, finishes or rolls back an interrupted restore, checks for
Vision 2.0 data, starts the backend (which applies pending migrations before it listens) on a
random loopback port when appropriate, and waits for detailed readiness before showing the
application. `runtime-state.json` records an unfinished database switch so a stale or partially
switched database cannot become the live one by accident.

The backend applies migrations in-process with its own runner
(`apps/node-backend/src/database/migrate.ts`); no separate migration process is spawned. A new
database gets `db/migrations/0001_baseline.sql` and every later numbered file in one
`BEGIN IMMEDIATE` transaction, recorded with a SHA-256 in `vision_migrations`. The runner refuses a
database that has tables but no migration ledger, a migration this build does not know (a newer
Vision wrote it) or a migration whose checksum changed, and leaves it unchanged. If the backend
exits during startup, Electron stops waiting and shows the error from `backend.log`. See
[[docs/guides/migrations|Database Migration Guide]].

## Native Vision Demo

```bash
./install-demo.sh
open "/Applications/Vision Demo.app"
```

The Demo seed is synthetic and deterministic. The package carries `vision-demo.sqlite3`, a database
the database tool built from the migrations and loaded with the seed, and a manifest with its
SHA-256, schema version and row count per table. When the seed changes or a reset is requested, the
runtime copies that file into a staged database directory, verifies it (`integrity_check`,
`foreign_key_check`, the migration ledger and the schema), refuses it unless its checksum and schema
version match the manifest, and then swaps database generations.

The previous Demo database remains available until detailed readiness passes and the row counts of
the stable user-data tables still match the manifest. The post-start comparison skips
`user_settings`, which the backend writes on its own after start (daily-job and repair markers).

Reset only the isolated Demo data with:

```bash
bun run demo:reset-native
```

## Lifecycle and diagnostics

Electron owns backend start, health, restart, and shutdown. It writes bounded logs under the
application-data directory. Useful checks are:

```bash
bun run native:isolated-smoke
bun run native:smoke
```

`native:smoke` runs its backend with external refreshes disabled. It uses a disposable synthetic
runtime with its own temporary SQLite database and checks package startup, an encrypted backup,
restore (also into a second fresh runtime, as for a device move), and API writes without
contacting data providers.

For an installed app, read the persisted `appPort` from settings and probe `GET /health` and
`GET /health/detailed`. Do not reset the database merely because startup failed; inspect the
native logs, runtime marker, payload manifest, and seed activation state first.

## Backup and restore

The desktop backup path uses the native database transport. To back up, Electron stops the
backend, writes a verified `VACUUM INTO` copy of the database with the database tool, copies the
attachments, and starts the backend again, so both halves describe the same moment. A
`.visionbak` bundle contains `metadata.json` (bundle format, schema version, app version, device id,
timestamps and the database SHA-256), `db.sqlite3`, `attachments/` and `frontend-state.json`.

Restore extracts into staging and validates paths and checksums. It copies `db.sqlite3` into a
staged database directory, verifies it with the database tool (`integrity_check`,
`foreign_key_check`, a ledger this build can open, and a schema equal to a fresh install at the same
version), and refuses it unless its SHA-256 and schema version match the metadata. Only then does
it journal the switch in `runtime-state.json`, stop the backend and swap the database directories.
The schema version a backup records is the latest version in the database's `vision_migrations`
ledger.

A Vision 2.0 bundle carries a PostgreSQL `db.sql` instead of `db.sqlite3`. The app never reads it:
restore refuses it with `BACKUP_POSTGRESQL_V2` and names the transition command. Convert such a
backup with `bun run transition:v2 -- <backup> --to-backup <new.visionbak>` first
([[docs/guides/sqlite-transition|Moving Vision 2.0 data to SQLite]]).

`bun run native:isolated-smoke` exercises the complete encrypted-bundle journey in a temporary
application-data directory with its own SQLite database. It verifies exact synthetic account,
transaction, setting, and attachment values plus schema, frontend-state, API-readiness, and
packaged-frontend restoration without reading or writing the user's Vision instance.

Encrypted backup primitives live in `packaging/electron/backup/encrypted-file.ts`. Restore reads
only AES-256-GCM files (`VISIONENC2` and `VISIONBAK2`), the format new encrypted files use. Retired
AES-256-CBC files (`VISIONENC1` and `VISIONBAK1`) are refused by name before decryption
([[docs/adr/219-minimal-electron-shell-hardening|ADR-219]]). The macOS Keychain-backed `safeStorage` protects the
passphrase at rest, while the backup key itself is derived with scrypt.

## Payload verification

The first launch of each installed payload hashes every file listed in
`Contents/Resources/native-runtime/manifest.json` and records the result in
`~/Library/Application Support/Vision/native/vision/runtime-verification.json`. Later launches
with the same manifest only check the file set and sizes and re-hash on any mismatch
([[docs/adr/235-launch-runtime-verification-marker|ADR-235]]). Delete that file to force a full
check on the next launch. The `[startup]` log shows `runtime_manifest_full` or
`runtime_manifest_cached` with the time taken.

## Updates and reports

Native updates create a backup in `~/Library/Application Support/Vision/pre-update-backups`,
verify the selected release artifact and checksum, install it, and retain rollback state until the
updated app opens successfully. Independently of how the app was updated, a backend that finds
pending migrations for a database that holds data first writes a `VACUUM INTO` copy to
`<userData>/database/pre-migration-backups/`. If that copy fails, nothing is migrated, the backend
does not start, and the launch dialog says that Vision could not back up the data before updating
the database (`PRE_MIGRATION_BACKUP_FAILED`). Report PDFs print in a hidden, sandboxed,
script-free Electron window with no network access (ADR-234). Ollama remains an optional host
integration and defaults to its loopback endpoint; see
[[docs/integrations/ollama|Ollama Integration]].

## Recovery boundary

Normal startup and Demo seed preparation share `recoverInterruptedRestore` in
`packaging/electron/runtime/native.ts`. They resolve interrupted database and attachment switches
before ordinary startup or checking whether the Demo seed is current. An unfinished database
switch restores the previous attachment tree first; a committed database leaves an attachment-only
journal for cleanup. Demo startup must not roll back only the database generation. A switch journal
written by Vision 2.0 names PostgreSQL databases; only Vision 2.0 can resolve it, so neither
generation is touched.

Do not hand-edit `runtime-state.json` to select another database, and do not delete the previous
database directory during a failed switch. Recovery must preserve one writer and verify a staged
restore before activation. Reintroducing another runtime requires a new architecture decision.

## Related

- [[docs/adr/263-sqlite-replaces-postgresql|ADR-263: SQLite replaces PostgreSQL]]
- [[docs/guides/sqlite-transition|Moving Vision 2.0 data to SQLite]]
- [[docs/adr/133-native-only-runtime-and-delivery|ADR-133: Native-only runtime and delivery]]
- [[docs/adr/113-native-macos-runtime|ADR-113: Native macOS runtime]]
- [[docs/adr/114-native-deterministic-demo-runtime|ADR-114: Native deterministic Demo runtime]]
- [[docs/architecture/electron|Electron Desktop Architecture]]
- [[docs/features/backup-coverage-audit|Backup Coverage Audit]]
- [[docs/guides/deployment|Deployment Guide]]
