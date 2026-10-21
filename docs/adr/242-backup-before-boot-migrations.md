---
title: "ADR-242: Backup before boot-time migrations"
type: adr
status: accepted
date: 2026-10-21
tags: [adr, electron, native-runtime, migrations, backup, persistence, audit-history, adr-207, adr-222, adr-231]
description: "Accepted on 2026-10-21. Before the desktop app spawns a backend that will apply pending migrations to an existing database, the native runtime calls a pre-migration hook and main takes the same .visionbak bundle backup as the update button into <userData>/pre-update-backups. A failed backup stops the launch before any migration runs. The retired audit-history cleanup now waits until the database records migration 0004."
aliases: [adr-242, pre-migration backup, backup before migrations]
related_code:
  [
    "packaging/electron/runtime/native.ts",
    "packaging/electron/main.ts",
    "packaging/electron/backup/restore.ts",
    "packaging/electron/legacy-audit-cleanup.ts",
  ]
---

# ADR-242: Backup before boot-time migrations

## Status

Accepted on 2026-10-21. Amends [[docs/adr/222-typescript-migrations-kysely-baseline|ADR-222]]
and the cleanup timing in [[docs/adr/231-remove-audit-history|ADR-231]].

## Date

2026-10-21

## Context

The backend applies every pending `db/migrations` file when it boots
([[docs/adr/222-typescript-migrations-kysely-baseline|ADR-222]]). Migrations 0002 and 0004 delete
data (cloud AI settings, audit history). Only the in-app update button made a backup first. A
manual install of a newer `Vision.app`, or any other way the packaged chain gets ahead of the
database, went straight to `runMigrations()` with no backup.

The launch also removed the audit-history receipt folder and Keychain item
([[docs/adr/231-remove-audit-history|ADR-231]]) before the backend had started. If migration 0004
then failed and the user reinstalled the previous build, the receipts that build expected were
already gone.

The persistence rules in `packaging/AGENTS.md` ask for a verified backup before changing a
persistence contract, and for database and backup files to stay inside the application data
directory.

## Decision

- **Pending check in the runtime.** `start()` in `packaging/electron/runtime/native.ts` accepts a
  `beforeMigrations` hook. After PostgreSQL is ready and the port check passes, and before the
  backend is spawned, it compares the highest `NNNN_name.sql` in
  `<runtime root>/db/migrations` (rollback files excluded; the backend applies exactly this chain)
  with the highest name in `public.kysely_migration`. When an existing database is behind, it
  calls the hook with both names. A database without a ledger is new and gets no backup.
- **Same transport as the update button.** `main.ts` passes a hook that runs `runBundleBackup`
  into `<userData>/pre-update-backups`, the folder and `.visionbak` format the update button uses,
  including encryption when a passphrase is set and the same seven-backup retention. No backend is
  running yet, so the capture skips the stop-and-restart of
  [[docs/adr/207-coordinated-native-recovery|ADR-207]] (`backendStopped: true`). The splash shows
  "Backing up your data before the update…".
- **Fail closed.** A rejected hook aborts `start()`: no backend is spawned and no migration runs.
  The launch shows "Vision could not start" with the backup error and asks the user to free disk
  space or check the logs.
- **Demo excluded.** Vision Demo reseeds synthetic data at the packaged schema head, so it passes
  no hook.
- **Audit cleanup after migration.** `cleanupLegacyAuditArtifacts()` takes a required
  `retirementApplied` check. The launch runs it in the background after starting the backend; the
  check waits for `/health` and then reads the applied migration names
  (`getAppliedMigrations()`). Until `0004_remove_audit_history` is recorded, nothing is removed and
  no completion marker is written, so the next launch tries again.

## Consequences

- Every boot-time migration of user data now has a restorable bundle from just before it, also for
  manual installs.
- An in-app update that ships new migrations makes two backups: one before the download and one on
  the first launch of the new build. That costs the time of one more backup on that launch.
- A full disk or failed dump blocks the launch until it is resolved, instead of migrating without a
  backup.
- The backups count toward the shared retention of `pre-update-backups`.
- Restores and the backup snapshot restart call `start()` without the hook, so they never back up;
  the data they restore already comes from a backup.

## Related

- [[docs/adr/index|All ADRs]]
- [[docs/adr/207-coordinated-native-recovery|ADR-207]]
- [[docs/adr/222-typescript-migrations-kysely-baseline|ADR-222]]
- [[docs/adr/231-remove-audit-history|ADR-231]]
- [[docs/features/application-updates|Application Updates]]
- [[docs/guides/native-macos-runtime|Native macOS Runtime Guide]]
