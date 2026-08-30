---
title: ADR-113 Native macOS runtime with optional Docker provider
type: adr
status: accepted
date: 2026-08-30
tags:
  [
    adr,
    macos,
    electron,
    native-runtime,
    postgresql,
    docker,
    backup,
    restore,
    migration,
    security,
  ]
description: Vision ships a managed PostgreSQL 18 runtime, migration executable, native Bun backend, and report browser on macOS, while retaining Docker Compose behind the same runtime boundary and requiring an explicit verified cutover for existing Docker data.
aliases: [native macOS runtime, Docker to native cutover, runtime provider]
---

# ADR-113: Native macOS runtime with optional Docker provider

## Status

Accepted — 2026-08-30. This replaces the Docker-specific desktop-runtime assumptions in
[[docs/adr/022-electron-sandbox-hardening-and-recovery|ADR-022]] and
[[docs/adr/045-electron-app-name-userData-migration|ADR-045]] without changing their renderer
sandbox, recovery, application identity, or user-data directory decisions. Docker Compose remains
supported as an explicit deployment provider.

## Context

Vision's Electron shell previously started the application and PostgreSQL through Docker Compose.
That made Docker Desktop a requirement for normal macOS development and for the packaged app. The
backend itself does not require a container, but its data model requires PostgreSQL-specific
features including extensions, materialized views, enums, triggers, and PostgreSQL SQL. Replacing
PostgreSQL with SQLite would change application behavior and is not acceptable.

An existing Docker installation can contain irreplaceable database and attachment volumes. A new
runtime must therefore prevent concurrent writers, preserve the source volumes, validate the
logical restore before activation, and retain a deliberate rollback path. Backup, restore, and
application logic must remain shared rather than fork into native-specific implementations.

## Decision

Vision uses a runtime-provider boundary in `packaging/electron/runtime/`:

- `native` is the default for normal macOS development and packaged Vision.
- `docker` remains an explicit provider for Compose deployments and the seeded Demo app.
- Electron selects one provider before any lifecycle action. A durable runtime marker is
  authoritative once present and blocks accidental alternation caused by stale settings or
  environment variables.

The native provider ships PostgreSQL 18.6 and version-matched client tools as a signed application
resource. It initializes and manages a private PostgreSQL cluster below Vision's canonical
application-data directory. PostgreSQL listens only on loopback, uses a fixed private port, and
rejects a collision rather than connecting to an unknown server. Vision creates a cluster
administrator role, a migration/owner role, and a separate least-privilege application role, then
runs the Bun backend as a native child process. Normal quit stops the backend and Vision-managed
PostgreSQL; the existing keep-services preference can deliberately leave both running.

The packaged app also ships a single-file migration executable built from the repository's
hash-pinned Python dependencies and a pinned Chrome Headless Shell for report generation. Runtime
discovery verifies every payload's platform, architecture, version, executable path, and checksum
manifest before backend startup. Runtime state, logs, credentials, PostgreSQL files, attachments,
process identifiers, and cutover markers live below the canonical Vision application-data
directory with restrictive permissions. Application updates replace binaries but do not replace
that durable data directory.

The PostgreSQL payload is assembled at release time from a checksum-pinned Postgres.app artifact.
An explicit PostgreSQL 18.6 binary directory is also accepted for local packaging. The application
does not depend on Postgres.app or Homebrew after packaging. An externally managed PostgreSQL 18
server remains available only through an explicit development or diagnostic override; it is never
selected silently.

Existing Docker installations do not auto-create an empty native database. Native startup fails
closed until the opt-in importer has:

1. stopped the Docker application writer while leaving PostgreSQL available;
2. recorded the PostgreSQL server version, schema, complete public-table set, exact table row
   counts, and important-table subset;
3. created and validated a PostgreSQL custom-format dump;
4. exported and hashed attachments;
5. restored into a fresh native database created from `template0`;
6. compared the schema, complete table set, all exact row counts, and attachment hashes;
7. started the native backend and passed detailed readiness plus representative database read,
   idempotent settings write, AI/Ollama status, and real PDF workflow checks;
8. stopped, but did not remove, the Docker stack;
9. finalized the staged database and attachment switches; and
10. written the authoritative native cutover marker.

The in-progress marker is written before the Docker writer is stopped. Electron refuses normal
startup while that marker is present. A retry can recover a stale, process-attributed cutover lock
by stopping native Vision, rolling back any persisted database and attachment switches, selecting
Docker, and restarting the Docker writer. A corrupt or live lock remains fail-closed.

Source-mode database migrations continue to use `apps/node-backend/scripts/db-migrate.js`.
The packaged backend invokes the same underlying repository `runMigrations()` implementation.
Both paths include the `alembic_version VARCHAR(64)` preflight. In a split-role setup that
preflight opens a one-shot owner connection; it never asks the application role to perform schema
writes. The native child environment
prevents a checkout's `config/.env.local` from replacing its generated database URLs. Restore
activates a staged database and attachment tree only after validation. Database and attachment
switches retain rollback state until detailed readiness succeeds. The `.visionbak` bundle,
encryption formats, schema guards, and frontend-state contract are shared across runtime providers.

Native packaged updates download and verify the macOS application archive, then invoke a fixed
installer helper with an argument array. Electron stops the native backend before launching that
helper and restarts it if helper launch fails. The helper stages the replacement beside the
installed application, atomically swaps it, and retains a rollback copy until the new app opens.
Native mode does not pull a Docker application image. Native PDF generation uses the bundled Chrome
Headless Shell, with an explicit supported host browser path retained for development diagnostics.
Native Ollama traffic uses loopback. Existing supported provider keys and `ADMIN_AUTH_TOKEN` are
allowlisted into the native environment during import; unrelated host or Docker secrets are not
copied.

## Consequences

**Positive**

- Normal development and the packaged macOS app no longer require Docker.
- PostgreSQL-specific behavior and the existing schema remain unchanged.
- Lifecycle, health, logs, backup, restore, and update behavior have one provider boundary.
- The source Docker database and attachments remain an untouched, stopped rollback source after
  cutover.
- Split-brain protection is durable across application restarts.

**Negative**

- The macOS package is larger and the release pipeline must assemble, relocate, sign, license, and
  verify PostgreSQL, Chrome Headless Shell, and the migration executable for each supported
  architecture.
- Vision owns a long-lived PostgreSQL cluster and must handle interrupted initialization, port
  collisions, clean shutdown, upgrades, and data-directory permissions safely.
- The preserved Docker copy becomes stale after the first native write. Returning to it without a
  reverse logical migration discards later native changes.

**Neutral**

- Docker Compose remains available for servers, CI, the Demo app, and explicit local Docker use.
- Supabase is not introduced. Its local and self-hosted stacks would retain a container dependency
  and add services, authentication, storage, and migration semantics Vision does not need.
- No database schema migration is required for this runtime change.
- Web deployments and the backend's HTTP/API contracts are unchanged.

## Rollback

Before native writes, a failed cutover rolls back the staged database and attachment swap and
restarts the Docker writer. After native writes, the safe rollback is a reverse logical migration
from native PostgreSQL into a fresh Docker database plus a verified attachment transfer. The
explicit stale-Docker rollback command exists only for cases where discarding all post-cutover
native writes is knowingly accepted. Neither path deletes the original Docker volumes.

## Related

- [[docs/adr/index|All ADRs]]
- [[docs/architecture/electron|Electron Desktop Architecture]]
- [[docs/guides/native-macos-runtime|Native macOS Runtime Guide]]
- [[docs/features/backup-coverage-audit|Backup Coverage Audit]]
- [[docs/features/application-updates|Application Updates]]
- [[docs/guides/deployment|Deployment Guide]]
- [[packaging/electron/runtime/index.js|Runtime provider selection]]
- [[packaging/electron/runtime/importer.js|Docker-to-native importer]]
- [[packaging/electron/backup/native-transport.js|Native backup transport]]
