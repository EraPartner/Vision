---
title: Deployment Guide
type: guide
status: active
date: 2026-10-21
tags:
  [
    guide,
    deployment,
    production,
    native-runtime,
    postgresql,
    electron,
    security,
    packaging,
    bun,
  ]
description: Deploy Vision as the native macOS desktop application or run the loopback-only source backend with operator-managed PostgreSQL 18.
aliases: [deployment-guide, production-deploy, electron-packaging]
related_code: ["packaging/electron/", "apps/node-backend/src/main.ts"]
---

# Deployment Guide

Vision supports two deployment shapes:

| Method            | Use case                            | Database ownership                                          |
| ----------------- | ----------------------------------- | ----------------------------------------------------------- |
| Native Electron   | Normal macOS desktop installation   | Vision owns a private bundled PostgreSQL 18 cluster         |
| Source run        | Running the backend from a checkout | The operator supplies PostgreSQL 18 and process supervision |

The project does not publish or support a product container image. Agent execution uses the
provider's built-in sandbox; see [[docs/guides/devcontainer|Agent Sandbox Guide]].

## Native macOS application

Build prerequisites and runtime behavior are in
[[docs/guides/native-macos-runtime|Native macOS Runtime Guide]]. A packaged app contains the
production frontend, Bun backend with its `db/` migration files, PostgreSQL 18.6, and Chrome Headless
Shell.
It does not require a host PostgreSQL service.

```bash
bun run install:electron
bun run native:prepare
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
([[docs/adr/233-loopback-only-backend|ADR-233]]). The operator provides PostgreSQL 18, a process
supervisor and backups. Set the backend environment explicitly:

```bash
DATABASE_URL=postgresql://vision_app:<password>@127.0.0.1:5432/financial_transactions
DATABASE_URL_MIGRATIONS=postgresql://vision_owner:<password>@127.0.0.1:5432/financial_transactions
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

`DATABASE_URL_MIGRATIONS` owns schema changes. `DATABASE_URL` is the least-privilege application
role. The grant template at `config/postgres/app-role-grants.sql.tpl` records the expected grants.
Apply schema changes only through the repository migrator (`bun run db:migrate`); the backend
also applies pending migrations before it listens.

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
- Do not expose PostgreSQL to the network.

## Backup and restore

The desktop app creates complete `.visionbak` bundles containing a custom-format PostgreSQL dump,
attachments, preferences, and a checksum manifest. Restore validates and stages the bundle before
switching the active database. See [[docs/features/backup-coverage-audit|Backup Coverage Audit]].

Source runs must use PostgreSQL-native backup tools plus a separately versioned attachment
backup. Verify restore into a disposable database and record the application version and schema
revision (the highest `public.kysely_migration` name) with each backup. A database dump alone is not a complete Vision backup.

## Updates

Native packaged updates install a verified macOS release artifact after creating a pre-update
backup. The packaged app also backs up before the backend applies pending migrations at launch,
whichever way it was installed
([[docs/adr/242-backup-before-boot-migrations|ADR-242]]). Source runs are operator-managed. See
[[docs/features/application-updates|Application Updates]].

## Monitoring

- Probe `GET /health` for liveness and database reachability.
- Probe `GET /health/detailed` during startup and before switching a staged database live.
- Keep backend and PostgreSQL logs under the deployment supervisor.
- Alert on migration failure, repeated restarts, backup failure, and low disk space.

## Related

- [[docs/guides/setup|Setup Guide]]
- [[docs/architecture/electron|Electron Desktop Architecture]]
- [[docs/guides/migrations|Database Migrations]]
- [[docs/reference/environment-variables|Environment Variables]]
- [[docs/security/data-protection|Data Protection]]
