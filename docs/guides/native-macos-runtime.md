---
title: Native macOS Runtime Guide
type: guide
status: active
date: 2026-09-08
tags:
  [guide, native-runtime, macos, electron, postgresql-18, backup, restore, demo]
description: Build, operate, diagnose, back up, and restore Vision's bundled native macOS runtime.
aliases: [native Vision, macOS runtime]
related_code:
  ["packaging/electron/runtime/native.js", "packaging/electron/main.js"]
---

# Native macOS Runtime Guide

Vision for macOS bundles PostgreSQL 18.6, Bun, the Alembic migration executable, and Chrome Headless
Shell. Electron owns their lifecycle. A host database service is neither used nor required.

> [!warning] Legacy installation
> If this installation still has a saved marker from the retired runtime, use Vision 1.0.2 to
> migrate before upgrading. Current startup fails closed and does not create an empty replacement
> database over that state. Do not delete the old data while deciding how to recover it.

## Build inputs

The native payload builder requires:

- the reviewed PostgreSQL 18.6 build source;
- Python 3.12 and pinned migration dependencies;
- the Puppeteer-pinned Chrome Headless Shell; and
- the Bun runtime and production frontend.

Prepare development payloads with:

```bash
bun run install:electron
bun run native:prepare
```

Release CI rebuilds the same payload rather than depending on a host service.

## Runtime data

Production state lives below `~/Library/Application Support/Vision/native/vision`; the Demo uses
`~/Library/Application Support/Vision Demo/native/vision_demo`; and source development uses its own
`Vision Development` profile. Each runtime keeps a private cluster, logs, runtime state, generated
credentials, and attachment storage under its own application-data boundary.

The generated database roles are separate:

- the cluster administrator creates databases and required extensions;
- the migration owner owns application schema objects; and
- the application role has only runtime data privileges.

The grant template is `config/postgres/app-role-grants.sql.tpl`. Credentials are restricted to the
application-data directory and are never logged.

## Start development

```bash
bun run dev
```

Startup initializes or opens the private cluster, runs the guarded migration command, starts the
backend on a random loopback port when appropriate, and waits for detailed readiness before showing
the application. `runtime-state.json` records the active native database identity so a stale or
partially switched database cannot become the writer by accident.

## Native Vision Demo

```bash
./install-demo.sh
open "/Applications/Vision Demo.app"
```

The Demo seed is synthetic and deterministic. When the seed changes or reset is requested, the
runtime creates required extensions as the private cluster administrator, restores application
objects as the restricted migration owner, and compares schema and all table counts before the
atomic switch. Generated seed dumps omit extension definitions and comments because those are
runtime bootstrap state, not application data.

The previous Demo database remains available until detailed readiness and stable row-count checks
pass. The post-start comparison excludes only the documented runtime-owned
`transfers_backfilled` and `fx_full_history_repair_done` maintenance markers.

Reset only the isolated Demo data with:

```bash
bun run demo:reset-native
```

## Lifecycle and diagnostics

Electron owns PostgreSQL and backend start, health, restart, and shutdown. It writes bounded logs
under the application-data directory. Useful checks are:

```bash
bun run native:db-smoke
bun run native:isolated-smoke
bun run native:smoke
```

For an installed app, read the persisted `appPort` from settings and probe `GET /health` and
`GET /api/health/detailed`. Do not reset the database merely because startup failed; inspect the
native logs, runtime marker, payload manifest, and seed activation state first.

## Backup and restore

The desktop backup path uses the native database transport. A `.visionbak` bundle contains the
database dump, attachments, settings, metadata, and checksums. Restore extracts into staging,
validates paths and checksums, restores into a fresh database, verifies it, and only then switches
the active database.

`bun run native:isolated-smoke` exercises that complete encrypted-bundle journey in a temporary
application-data directory and disposable PostgreSQL 18 cluster. It verifies exact synthetic
account, transaction, setting, and attachment values plus schema, frontend-state, API-readiness,
and packaged-frontend restoration without reading or writing the user's Vision instance. The
focused bundle suite retains an immutable sanitized encrypted bundle written by Vision 1.0.2
alongside the current AES-256-GCM path and the fixed legacy AES-256-CBC decoder vectors.

Encrypted backup primitives live in `packaging/electron/backup/encrypted-file.js`. Restore accepts
legacy AES-256-CBC files (`VISIONENC1` and `VISIONBAK1`) and current AES-256-GCM files (`VISIONENC2`
and `VISIONBAK2`); new encrypted files use v2. The macOS Keychain-backed `safeStorage` protects the
passphrase at rest, while the backup key itself is derived with scrypt.

## Updates and reports

Native updates create a backup, verify the selected release artifact and checksum, install it, and
retain rollback state until the updated app opens successfully. Reports use the bundled Chrome
Headless Shell. Ollama remains an optional host integration and defaults to its loopback endpoint;
see [[docs/integrations/ollama|Ollama Integration]].

## Recovery boundary

Do not hand-edit generated credentials, change the runtime marker to select another database, or
delete the previous database during a failed switch. Recovery must preserve one writer and verify a
staged restore before activation. Reintroducing another runtime requires a new architecture decision.

## Related

- [[docs/adr/133-native-only-runtime-and-delivery|ADR-133: Native-only runtime and delivery]]
- [[docs/adr/113-native-macos-runtime|ADR-113: Native macOS runtime]]
- [[docs/adr/114-native-deterministic-demo-runtime|ADR-114: Native deterministic Demo runtime]]
- [[docs/architecture/electron|Electron Desktop Architecture]]
- [[docs/features/backup-coverage-audit|Backup Coverage Audit]]
- [[docs/guides/deployment|Deployment Guide]]
