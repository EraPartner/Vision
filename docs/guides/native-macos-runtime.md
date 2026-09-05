---
title: Native macOS Runtime Guide
type: guide
status: active
date: 2026-08-31
updated: 2026-09-04
tags:
  [
    guide,
    macos,
    native-runtime,
    postgresql,
    electron,
    migration,
    backup,
    restore,
    rollback,
  ]
description: Operate Vision on macOS with its bundled PostgreSQL 18, migration, Bun, and report runtimes, including safe Docker-to-native cutover and rollback.
aliases: [native Vision, macOS runtime, Docker to native migration]
related_code:
  - packaging/electron/runtime/
  - packaging/electron/scripts/native-runtime-cli.js
  - packaging/electron/backup/native-transport.js
---

# Native macOS Runtime Guide

Vision runs natively on macOS with a bundled, Vision-managed PostgreSQL 18.6 server, a native Bun
backend, and the production frontend served by that backend. The package also contains the
migration executable and Chrome Headless Shell used for reports. Homebrew, Postgres.app, Chrome,
and Docker are not runtime prerequisites. Docker Compose remains an explicit alternative. See
[[docs/adr/113-native-macos-runtime|ADR-113]] for the architecture decision.

> [!danger] Real-data boundary
> Never reset, remove, or write to the original Docker PostgreSQL or attachment volumes during
> migration testing. Never run `docker compose down -v`, `docker volume rm`, or a destructive
> Alembic downgrade. Native and Docker application writers must not run at the same time.

## Prerequisites

The packaged application has no external database, migration, browser, Bun, or Docker runtime
prerequisite. It verifies its checksummed application resources before accepting requests.

Repository development requires Bun and installed workspace dependencies. Before the first native
development run, `bun run native:prepare` builds the same private payload used by a release. Its
PostgreSQL source can be a checksum-pinned Postgres.app release artifact, an explicit PostgreSQL
18.6 binary directory, or a local Homebrew `postgresql@18` installation. That PostgreSQL service
does not need to be started. Building the migration executable also requires the repository's
hash-pinned Python dependencies and PyInstaller 6.22.2. Chrome Headless Shell is fetched at the
version pinned to the Electron workspace's Puppeteer package.

`VISION_ALLOW_EXTERNAL_POSTGRES=true` is an explicit development and diagnostic escape hatch. It
allows discovery of a separately managed PostgreSQL 18 instance, but packaged Vision never enables
it by default. External servers must be loopback-only and are never stopped by Vision.

## Runtime Data

The canonical application directory is `~/Library/Application Support/Vision`. Native runtime
state is below `native/vision/`:

| Path                 | Purpose                                                     |
| -------------------- | ----------------------------------------------------------- |
| `runtime.env`        | Administrator, owner, and application settings; mode `0600` |
| `runtime-state.json` | Active provider and cutover state                           |
| `postgres/data/`     | Durable private PostgreSQL cluster                          |
| `attachments/`       | Durable native attachment tree                              |
| `logs/backend.log`   | Native backend output                                       |
| `logs/postgres.log`  | Vision-managed PostgreSQL output                            |
| `backend.pid.json`   | Verified backend child-process identity                     |
| `postgres.pid.json`  | Verified managed-PostgreSQL child-process identity          |
| `cache/`             | Native backend cache                                        |

The cluster-administrator role is used only for cluster bootstrap, database replacement, and the
narrow post-restore ownership handoff described below. The owner/migration role owns the database,
schema objects, and tables; it runs migrations and analyzes all ordinary tables in Vision's
`public` schema. The application role
receives runtime data privileges and owns only the two derived materialized views that the
runtime service must create, index, refresh, and analyze. PostgreSQL binds to `127.0.0.1:54329` by
default, and the backend also binds to loopback. Vision fails closed if the configured PostgreSQL
port belongs to another server.

On every split-role startup, the privileged bootstrap grants current ordinary tables and views to
the application role one relation at a time. Relations already owned by the application role are
skipped, including the two runtime-managed materialized views. This prevents PostgreSQL from
rejecting all ordinary-table grants merely because those derived views have already completed their
ownership handoff. Owner-role default privileges continue to cover tables and sequences created by
later migrations.

## Fresh Native Development

Install dependencies, prepare the bundled payload once, then start the native development stack:

```bash
bun install
bun run install:electron
bun run native:prepare
bun run dev
```

`bun run dev` starts Vision's private PostgreSQL cluster, the watched Bun backend, and Vite on
loopback. It uses `~/Library/Application Support/Vision Development/native/vision_dev`, separate
from packaged Vision and Docker data. The first start is idempotent: it initializes the cluster,
creates the three roles and a database from `template0`, installs required extensions, runs the
repository migration runner, and waits for readiness. An interrupted first start can be resumed.
Subsequent starts reuse the same private database. A port collision fails with a diagnostic; Vision
does not choose an unknown PostgreSQL service or silently change the database endpoint.

The managed configuration preloads `pg_stat_statements`, and migration 0095 installs its extension
alongside `pg_trgm` and `pgcrypto`. Existing private clusters receive the managed preload setting
before PostgreSQL restarts, so the same query-level timing view is available after upgrade.

`bun run electron:dev` starts the Electron source shell against the same prepared payload and the
same isolated `Vision Development/native/vision_dev` database. It cannot acquire the packaged
Vision single-instance lock or use packaged Vision's application-data directory.

Use `bun run electron:docker` for the explicit Docker development provider. The seeded Vision Demo
uses the same native provider with a separate deterministic database; see
[[docs/adr/114-native-deterministic-demo-runtime|ADR-114]].

## Native Vision Demo

`./install-demo.sh` builds and installs `/Applications/Vision Demo.app`. The build creates a
disposable PostgreSQL 18 cluster, migrates it with Vision's guarded runner, applies the data-only
synthetic generator in one transaction, verifies its row counts, and packages a custom-format
dump plus a checksum manifest. The host PostgreSQL service and Docker do not need to be running.
The installer builds the frontend in a private temporary directory, passes it to the native
payload builder with `VISION_FRONTEND_DIST`, and removes the staging directory on exit. It does
not reuse or clear the repository's shared `dist` directory.

Vision Demo has no path or port overlap with real Vision:

| Item             | Vision Demo                                 |
| ---------------- | ------------------------------------------- |
| Application data | `~/Library/Application Support/Vision Demo` |
| Native runtime   | `native/vision_demo/`                       |
| PostgreSQL       | `127.0.0.1:54330`                           |
| Dataset          | Packaged deterministic synthetic seed       |

First launch, an explicit reset, or a changed packaged seed restores into a staging database. The
schema, table set, and every exact table count must match the manifest before the backend starts.
The previous Demo database remains available until detailed readiness and stable row-count checks
pass. That post-start check excludes only the documented runtime-owned
`transfers_backfilled` and `fx_full_history_repair_done` maintenance-marker rows from the
`user_settings` count. Ordinary settings and every other protected user-data count must remain
unchanged. A failed or interrupted activation rolls back automatically.

To restore the canonical synthetic dataset deliberately:

```bash
bun run demo:reset-native
open "/Applications/Vision Demo.app"
```

The command writes a reset request only. Quit a running Demo first; the next launch performs and
verifies the database switch. The former Demo Docker volume is not imported because it contains
only replaceable synthetic data. The native Demo never reads, writes, or removes that volume.

## Lifecycle and Diagnostics

Electron owns normal start and clean shutdown. The runtime provider exposes idempotent start, stop,
restart, health, readiness, and log paths. The packaged app validates its PostgreSQL, browser,
migration, and backend payload manifest before initializing durable state. The packaged migration
executable also self-tests the modules loaded dynamically by the external Alembic environment.
Vision launches its managed PostgreSQL initialization and server processes with the portable `C`
locale. Invalid or unavailable locale values inherited from the macOS application launcher cannot
prevent PostgreSQL from reaching readiness; this does not change the application's display
language or regional formatting.
Useful synthetic checks are:

```bash
bun run native:db-smoke
bun run native:isolated-smoke
bun run native:smoke
```

The smoke commands use temporary application-data directories and uniquely named synthetic
databases. They do not touch packaged Vision, the production native cluster, or Docker volumes.
`native:db-smoke` validates discovery, roles, migrations, dump/restore, schema counts, and
attachment hashing. `native:isolated-smoke` creates a disposable PostgreSQL 18 cluster and runs the
frontend, API, and backup/restore smoke on random loopback ports. The frontend check fetches the
packaged HTML shell, requests its real JavaScript entry with gzip enabled, and verifies that the
response decodes with the expected JavaScript content type. It removes only that synthetic cluster
after a successful run. On failure, it reports and retains the temporary diagnostic directory and
prints bounded, sanitized log tails. `native:smoke` runs the same backend and frontend workflow
through the prepared native payload.

To prove that the exact payload inside a packaged application boots, set
`VISION_NATIVE_PAYLOAD_ROOT` to the absolute `Contents/Resources/native-runtime` directory before
running `native:isolated-smoke`. This requires the packaged manifest and exercises the compiled
backend, production frontend, PostgreSQL, migration runner, and report browser from that payload.
The disposable cluster and temporary application data remain separate from the normal Vision data
directory.

Every PostgreSQL readiness, role, database creation, migration, dump, and restore process is pinned
to the configured `127.0.0.1` port. Vision does not fall back to another PostgreSQL instance through
a default Unix socket. The managed server disables Unix sockets explicitly, which also avoids the
macOS Unix-socket path-length limit when Vision's application-data path is long.

An explicitly configured external PostgreSQL 18 server must provide the `pg_trgm`, `pgcrypto`, and
`pg_stat_statements` extension files. It must also list `pg_stat_statements` in
`shared_preload_libraries` and be restarted after that setting changes. Vision verifies the preload
before running database bootstrap or migrations and reports an operator action instead of trying to
rewrite or restart an external server.

The Settings option to keep services running on quit applies to the selected provider. In native
mode it keeps both the verified Bun backend and Vision-managed PostgreSQL running. Otherwise
Electron sends each child a clean termination signal, waits for shutdown, and uses a bounded force
fallback. It never stops an explicitly configured external PostgreSQL service. Backend and database
logs remain available in the native `logs/` directory.

## Docker-to-Native Cutover

The importer is explicit and fail-closed. Replace `[BACKUP_PATH]` with an existing readable and
writable backup directory. Do not use escaped placeholder text literally.

### 1. Complete verification before cutover

Run unit, lint, type, build, Electron package, backup/restore, and real PostgreSQL smoke checks. Do
not execute the importer while any required result is failed or unverified.

### 2. Optional frontend-state audit export

The existing Electron profile remains in the same `userData` directory, so its supported
localStorage state is preserved in place. For an explicit migration artifact, export the supported
`{ "keys": ... }` snapshot through Vision's backup UI and pass its path with `--frontend-state`.
The importer copies only that validated structure; it does not inspect arbitrary browser storage.

### 3. Read-only preflight

```bash
bun run native:preflight -- --backup "[BACKUP_PATH]"
```

This checks the backup directory, bundled PostgreSQL 18 tools, private native cluster, and Docker
source. It may start Vision's private PostgreSQL server for validation, but it does not start the
native application writer, stop the Docker writer, or switch runtimes.

Docker Desktop must be running, and the old Compose `db` service must be available. If the old
stack is stopped, start only PostgreSQL before preflight; `--no-deps` keeps the Docker application
writer stopped:

```bash
docker compose \
  -f "$HOME/Library/Application Support/Vision/embedded_compose/docker-compose.yml" \
  up -d --no-deps db
```

This reuses the existing named PostgreSQL volume. Do not add `--renew-anon-volumes`, do not use
`down -v`, and do not start native Vision while the Docker application writer is running.

### 4. Execute the cutover

Quit the old Vision application, leave its Docker database available, and run:

```bash
bun run native:cutover -- --backup "[BACKUP_PATH]" --execute
```

Add `--frontend-state "/absolute/path/to/frontend-state.json"` when an audit export was created.
The importer then:

1. locks the cutover and stops only the Docker application writer;
2. records the exact PostgreSQL server version, schema revision, every public table, every exact
   table row count, and the important-table subset;
3. writes and validates a PostgreSQL custom-format dump;
4. exports attachments and records their count and aggregate SHA-256 fingerprint;
5. restores a fresh native database from `template0` with error-on-first-failure and one
   transaction, then assigns only Vision's runtime-managed materialized views to the application
   role;
6. before starting the backend, verifies the exact schema, complete table set, all table row
   counts, and attachment fingerprint;
7. starts native Vision, waits for database-backed detailed readiness, and rechecks the schema,
   table set, and important user-data row counts. Runtime cache tables may legitimately change
   during startup and are not treated as source-data loss after the exact pre-start proof;
8. verifies representative accounts, transactions, import batches, investments, planned
   transactions, an idempotent settings write/read, AI/Ollama status behavior, and a real financial
   PDF response;
9. stops the source-checkout validation backend while leaving native PostgreSQL ready for the
   packaged application;
10. stops, but does not remove, the Docker services or volumes;
11. finalizes the staged database and attachment switches; and
12. activates the authoritative native marker.

The final dump, attachment export, frontend-state snapshot when supplied, and non-secret manifest
are stored in a timestamped `vision-native-cutover-*` directory below `[BACKUP_PATH]`.

Preflight also rejects a native PostgreSQL 18 `pg_dump` client whose patch version is older than the
Docker source server. This check runs before the Docker writer is stopped.

If any step fails, the native database and attachment switch are rolled back and the Docker writer
is restarted. The application is not left pointed at an unverified native database.

Cutovers completed by a source checkout from before the validation-backend handoff fix may retain
that verified backend process after success. Run `bun run native:handoff` once before opening the
packaged application. The command verifies the completed native marker and recorded process
ownership, stops only that backend, and leaves native PostgreSQL running.

The importer persists an in-progress marker before stopping the Docker writer. Electron refuses a
normal launch while recovery is pending. If the cutover process was interrupted, rerunning the
command recognizes a stale process-attributed lock, stops native Vision, rolls back any persisted
switch tokens, selects Docker, and restarts the Docker writer before retrying. A live or corrupt
lock is not guessed around; it must be investigated with both writers stopped.

The allowlisted Docker application environment copied during import includes supported research
provider keys and `ADMIN_AUTH_TOKEN`. It excludes database credentials and unrelated process
secrets. The native backend remains loopback-bound and does not weaken the existing admin route
gate.

## Native Backup and Restore

The Settings backup UI continues to create `.visionbak` files. Native mode uses the same bundle,
AES-256-GCM encryption, legacy encrypted-bundle reader, schema guard, and supported localStorage
snapshot as Docker mode. The database transport uses PostgreSQL tools directly. Restore stages a
fresh database and attachment tree, validates them, restores runtime-managed materialized-view
ownership to the application role, stops the backend, activates both, waits for detailed readiness,
and rolls both back on failure.

## Startup Recovery and Logs

After the native backend becomes ready, Electron waits for the React renderer to report that it has
mounted. If the frontend remains on the boot splash for 12 seconds, Electron reloads it once while
bypassing Chromium's cache. If the second attempt also fails, Vision replaces the splash with a
recovery page instead of waiting forever. **Try again** repeats the normal readiness and renderer
handoff; **Open logs** opens the application log directory.

The relevant files are `~/Library/Application Support/Vision/logs/main.log` for Electron and
`~/Library/Application Support/Vision/native/vision/logs/backend.log` for the backend. Vision Demo
uses the corresponding paths under `~/Library/Application Support/Vision Demo`. Renderer startup
diagnostics contain only structural metadata such as an error kind or asset basename. They exclude
full URLs, error messages, credentials, localStorage, and application data.

`VISION_RENDERER_READY_TIMEOUT_MS` can shorten or lengthen the 12-second renderer watchdog for
development diagnostics. It does not change database or backend readiness timeouts.

## Updates, Reports, and Ollama

- Packaged native updates verify the release archive and checksum, stage the new application, and
  stop the native backend before invoking a fixed installer helper with argument arrays. If helper
  launch fails, Electron restarts the old backend. The helper uses an atomic application rename and
  retains a rollback copy until the updated application opens. Native mode does not pull a Docker
  image.
- Reports use the pinned Chrome Headless Shell shipped with Vision. Native startup fails closed if
  the verified browser payload is missing or does not match the package. An explicit
  `PUPPETEER_EXECUTABLE_PATH` remains available for development diagnostics.
- Ollama defaults to `http://127.0.0.1:11434`. Native mode never uses
  `host.docker.internal`.

## Rollback

Before native writes, importer failure automatically restores the Docker writer. After native
writes, the Docker copy is stale. The data-preserving rollback is a reverse logical migration:

1. stop the native Vision writer;
2. create and validate a final native custom-format dump and attachment export;
3. restore them into a fresh Docker PostgreSQL database and staging attachment volume;
4. verify schema, counts, hashes, readiness, and representative workflows; and
5. only then change the runtime marker to Docker.

If discarding every write made after cutover is explicitly acceptable, the preserved stale Docker
source can be selected with:

```bash
bun run native:rollback-stale-docker -- --accept-stale-docker
```

This command stops native Vision, changes the marker, and starts the preserved Docker writer. It
does not delete native or Docker data. Do not use it when post-cutover native writes must be kept.

## Related

- [[docs/guides/setup|Setup Guide]]
- [[docs/guides/deployment|Deployment Guide]]
- [[docs/architecture/electron|Electron Desktop Architecture]]
- [[docs/features/backup-coverage-audit|Backup Coverage Audit]]
- [[docs/features/application-updates|Application Updates]]
- [[docs/integrations/ollama|Ollama Integration]]
- [[docs/adr/113-native-macos-runtime|ADR-113]]
