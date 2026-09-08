---
title: Deployment Guide
type: guide
status: active
date: 2026-09-08
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
description: Deploy Vision as the native macOS desktop application or as a source backend with operator-managed PostgreSQL 18.
aliases: [deployment-guide, production-deploy, electron-packaging]
related_code: ["packaging/electron/", "apps/node-backend/src/main.js"]
---

# Deployment Guide

Vision supports two deployment shapes:

| Method            | Use case                            | Database ownership                                          |
| ----------------- | ----------------------------------- | ----------------------------------------------------------- |
| Native Electron   | Normal macOS desktop installation   | Vision owns a private bundled PostgreSQL 18 cluster         |
| Source deployment | Custom server or browser deployment | The operator supplies PostgreSQL 18 and process supervision |

The project does not publish or support a product container image. The Apple `container`-based
development sandbox is documented separately in [[docs/guides/devcontainer|Devcontainer Guide]].

## Native macOS application

Build prerequisites and runtime behavior are in
[[docs/guides/native-macos-runtime|Native macOS Runtime Guide]]. A packaged app contains the
production frontend, Bun backend, PostgreSQL 18.6, migration executable, and Chrome Headless Shell.
It does not require a host PostgreSQL service.

```bash
bun run install:electron
bun run native:prepare
bun run dist
```

For a local install use `./install.sh`. For the isolated synthetic app use `./install-demo.sh`.
Both scripts stage build inputs in a private temporary directory and preserve existing application
data. Release publication is handled by `.github/workflows/release.yml`.

## Source deployment

Custom server operators provide PostgreSQL 18, a process supervisor, TLS termination, and backups.
Set the backend environment explicitly:

```bash
DATABASE_URL=postgresql://vision_app:<password>@127.0.0.1:5432/financial_transactions
DATABASE_URL_MIGRATIONS=postgresql://vision_owner:<password>@127.0.0.1:5432/financial_transactions
PORT=3002
HOST=127.0.0.1
LOG_LEVEL=info
CORS_ORIGINS=https://vision.example.com
ADMIN_AUTH_TOKEN=<random-secret>
```

Run the guarded migration command before starting the backend:

```bash
bun run db:upgrade
bun run build
bun run backend
curl --fail http://127.0.0.1:3002/health
```

`DATABASE_URL_MIGRATIONS` owns schema changes. `DATABASE_URL` is the least-privilege application
role. The grant template at `config/postgres/app-role-grants.sql.tpl` records the expected grants.
Never run a bare Alembic write against Vision; use the repository migration runner.

## Network and admin security

- Bind the backend to loopback unless an authenticated reverse proxy is the explicit boundary.
- Set `ADMIN_AUTH_TOKEN` whenever the backend is reachable outside the local process boundary.
- Keep the Cross-Site Request Forgery (CSRF) guard enabled on state-changing admin routes.
- Terminate Transport Layer Security (TLS) at the reverse proxy for browser deployments.
- Do not expose PostgreSQL to the public network.

The browser Web App Manifest supplies branding and standalone-window metadata. It does not add an
offline cache; the backend remains required.

## Backup and restore

The desktop app creates complete `.visionbak` bundles containing a custom-format PostgreSQL dump,
attachments, preferences, and a checksum manifest. Restore validates and stages the bundle before
switching the active database. See [[docs/features/backup-coverage-audit|Backup Coverage Audit]].

Source deployments must use PostgreSQL-native backup tools plus a separately versioned attachment
backup. Verify restore into a disposable database and record the application version and Alembic
head with each backup. A database dump alone is not a complete Vision backup.

## Updates

Native packaged updates install a verified macOS release artifact after creating a pre-update
backup. Source deployments are operator-managed. See
[[docs/features/application-updates|Application Updates]].

## Monitoring

- Probe `GET /health` for liveness and database reachability.
- Probe `GET /api/health/detailed` during startup and before switching a staged database live.
- Keep backend and PostgreSQL logs under the deployment supervisor.
- Alert on migration failure, repeated restarts, backup failure, and low disk space.

## Legacy installations

Vision fails closed when it finds a saved marker from the retired runtime. Users must migrate with
Vision 1.0.2 before installing the native-only release. The current package contains no importer
or alternate writer. See [[docs/adr/133-native-only-runtime-and-delivery|ADR-133]].

## Related

- [[docs/guides/setup|Setup Guide]]
- [[docs/architecture/electron|Electron Desktop Architecture]]
- [[docs/guides/migrations|Database Migrations]]
- [[docs/reference/environment-variables|Environment Variables]]
- [[docs/security/data-protection|Data Protection]]
