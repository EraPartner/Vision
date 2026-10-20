---
title: "ADR-207: Coordinated native backup and restore recovery"
type: adr
status: accepted
date: 2026-10-20
tags: [adr, architecture, backup, recovery, electron]
description: Quiesce the native writer for a consistent bundle and recover interrupted database and attachment switches before startup.
---

# ADR-207: Coordinated native backup and restore recovery

> [!note] Superseded in part by [[docs/adr/231-remove-audit-history|ADR-231]] on 2026-10-20:
> there is no audit closure or trusted audit session to pause. Writer quiescence and interrupted
> switch recovery stay in force.

## Status

Accepted.

## Context

A PostgreSQL dump and a later attachment copy can describe different application states while the
backend continues writing. Restore switches also span PostgreSQL and filesystem renames; a crash
can leave a journal that ordinary startup must resolve before creating or migrating a database.

## Decision

Native bundle capture drains and pauses audit closure and stops the backend writer, retaining
PostgreSQL for the dump. SQL, attachments and schema head are captured within that interval.
Restart and detailed readiness are attempted in `finally`; compression and encryption follow
restart. The main process pauses its health watchdog and coordinates snapshot capture and restore
with a maintenance guard. Update shutdown refuses a conflicting maintenance operation, and quit
waits for maintenance completion. This preserves the existing trusted audit session during an
intentional pause without granting trust to a tail found after unexpected backend loss.

Attachment switch intent is persisted before renames. Bootstrap resolves a pending restore before
ordinary database setup: recover the previous attachment tree, then roll back the unfinished
database switch. Once database finalization is durable, an attachment journal is cleanup-only.
Validate recovery paths and reject malformed state instead of creating a replacement database.
Repeated recovery must be safe at each rename boundary.

## Consequences

Backup briefly interrupts native writes. It does not coordinate external writers that bypass the
native backend. Restart failure remains an error even when capture succeeded. Previous files are
retained until the coordinated switch commits, trading disk space for recovery. Filesystem and
mocked-catalog tests cover interruption boundaries; packaged PostgreSQL and native acceptance are
separate verification requirements.

## Related

- [[docs/adr/index|All ADRs]]
- [[docs/features/backup-coverage-audit|Backup coverage and recovery]]
- [[docs/architecture/electron|Electron architecture]]
- Private audit bridge (deleted by [[docs/adr/231-remove-audit-history|ADR-231]])
