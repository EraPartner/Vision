---
title: Deployment Guide
type: guide
status: active
date: 2026-11-03
tags:
  [
    guide,
    deployment,
    production,
    native-runtime,
    sqlite,
    electron,
    security,
    packaging,
    bun,
  ]
description: Deploy Vision as the native macOS desktop application or run the loopback-only source backend on a SQLite database file the operator chooses.
aliases: [deployment-guide, production-deploy, electron-packaging]
related_code: ["packaging/electron/", "apps/node-backend/src/main.ts"]
---

# Deployment Guide

Vision supports two deployment shapes:

| Method            | Use case                            | Database ownership                                          |
| ----------------- | ----------------------------------- | ----------------------------------------------------------- |
| Native Electron   | Normal macOS desktop installation   | Vision owns one SQLite file in its application-data directory |
| Source run        | Running the backend from a checkout | The operator chooses the SQLite file and supplies process supervision |

The project does not publish or support a product container image. Agent execution uses the
provider's built-in sandbox; see [[docs/guides/devcontainer|Agent Sandbox Guide]].

## Native macOS application

Build prerequisites and runtime behavior are in
[[docs/guides/native-macos-runtime|Native macOS Runtime Guide]]. A packaged app contains the
production frontend, the Bun backend with its `db/` migration files, and the database tool. The
backend opens `<userData>/database/vision.sqlite3` in-process through the system SQLite library
(3.39.0 or later). There is no database server
([[docs/adr/263-sqlite-replaces-postgresql|ADR-263]]).

```bash
bun run install:electron
bun run dist
```

For a local install use `./install.sh`. For the isolated synthetic app use `./install-demo.sh`.
Both scripts stage build inputs in a private temporary directory and preserve existing application
data. Release publication is handled by `.github/workflows/release.yml`.

The Electron shell is TypeScript compiled into `packaging/electron/out/`. The Electron package's
`dist*` scripts, both install scripts and the release job run `bun build.ts` before
`node out/scripts/build-native-package.js`. The electron-builder `files` list places the compiled
`out/` tree (without tests and packaging scripts) and `assets/` into `app.asar`
([[docs/adr/196-electron-shell-typescript|ADR-196]]).

## Source run

A backend started from a checkout serves the same machine only, exactly like the desktop app
([[docs/adr/233-loopback-only-backend|ADR-233]]). The operator chooses the database file and
provides a process supervisor and backups. Set the backend environment explicitly. Outside
development and test the backend refuses to start without `VISION_DATABASE_PATH`:

```bash
VISION_DATABASE_PATH=/absolute/path/to/vision.sqlite3
ATTACHMENTS_DIR=/absolute/path/to/attachments
PORT=3002
SERVER_HOST=127.0.0.1
LOG_LEVEL=info
```

Run the guarded migration command before starting the backend:

```bash
bun run db:migrate
bun run build
bun run backend
curl --fail http://127.0.0.1:3002/health
```

The database is one file with no roles or credentials; protect it with file permissions. Apply
schema changes only through the repository migrator (`bun run db:migrate`); the backend also applies
pending migrations before it listens. Before it migrates a database that holds data, it writes a
`VACUUM INTO` copy to `pre-migration-backups/` next to the file and keeps the newest three.

## Network boundary

The API has no user authentication. Its boundary is the machine itself
([[docs/adr/233-loopback-only-backend|ADR-233]]):

- The backend refuses to start when `SERVER_HOST` is not a loopback address (`127.0.0.0/8`, `::1`
  or `localhost`). There is no reverse-proxy, LAN or browser-deployment mode.
- Every request must name `localhost`, `127.0.0.1` or `::1` with the backend's own port in its
  `Host` header. Anything else, including a DNS-rebinding hostname, receives 403 before body
  parsing, health checks or routes. `X-Forwarded-Host` is ignored.
- The backend sends no CORS headers. The frontend reaches it same-origin: the backend serves the
  built app, and in development the Vite proxy forwards `/api` with `changeOrigin: true`.
- The Cross-Site Request Forgery (CSRF) guard rejects cross-site requests of every method on the
  whole `/api` plane (ADR-237).
- There is no database port: the backend opens the SQLite file in-process.

## Backup and restore

The desktop app creates complete `.visionbak` bundles containing a verified SQLite copy of the
database (`db.sqlite3`), attachments, preferences, and metadata with the database checksum. Restore validates and stages the bundle before
switching the active database. See [[docs/features/backup-coverage-audit|Backup Coverage Audit]].

Source runs need their own backup of the database file plus a separately versioned attachment
backup. Do not copy the database file while the backend runs: recent writes may still be in the
`-wal` file. `bun run apps/node-backend/scripts/db-file.ts snapshot <database> <destination>`
writes a consistent `VACUUM INTO` copy while the backend runs and verifies it, and
`db-file.ts verify <database>` checks a copy before you rely on it. Record the application version
and schema revision (the latest version in the `vision_migrations` ledger) with each backup. A
database copy alone is not a complete Vision backup.

## Updates

Native packaged updates install a verified macOS release artifact after creating a pre-update
backup. The backend also copies the database to `pre-migration-backups/` before it applies pending
migrations at launch, whichever way the app was installed, and does not start when that copy fails
([[docs/adr/263-sqlite-replaces-postgresql|ADR-263]]). Vision 2.0 data moves once through
[[docs/guides/sqlite-transition|the transition script]]. Source runs are operator-managed. See
[[docs/features/application-updates|Application Updates]].

## Monitoring

- Probe `GET /health` for liveness and database reachability.
- Probe `GET /health/detailed` during startup and before switching a staged database live.
- Keep backend logs under the deployment supervisor.
- Alert on migration failure, repeated restarts, backup failure, and low disk space.

## Related

- [[docs/guides/setup|Setup Guide]]
- [[docs/architecture/electron|Electron Desktop Architecture]]
- [[docs/guides/migrations|Database Migrations]]
- [[docs/reference/environment-variables|Environment Variables]]
- [[docs/security/data-protection|Data Protection]]
