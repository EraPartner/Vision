---
title: ADR-165 - Reviewed Fresh Database Baseline and Guarded Bridge
type: adr
status: Accepted
date: 2026-09-20
tags: [adr, database, alembic, migration, backup, recovery]
description: Install a single reviewed PostgreSQL 18 snapshot into empty databases while preserving historical upgrades and requiring a restore-tested bridge for existing installations.
aliases: [fresh database baseline, squashed baseline bridge]
---

# ADR-165: Reviewed Fresh Database Baseline and Guarded Bridge

## Context

Fresh installations replayed 118 Alembic revisions. The maintained installation also completed six guarded manual contracts outside that graph. An `0118` revision alone therefore does not prove that the database has the maintained schema. A simple stamp or a fresh dump taken before those contracts would silently conflate different shapes.

## Decision

- Keep the historical Alembic graph for existing installations and upgrade evidence. A new `0119_squashed_baseline` revision creates no object and rewrites no data. It accepts only the two reviewed PostgreSQL 18 catalog fingerprints: the directly contracted shape and its one equivalent CHECK-expression normalization after dump restore.
- An empty PostgreSQL 18 database receives `alembic/baseline/0119_fresh.sql` in one transaction. The installer requires an exact SHA-256 of that reviewed file, checks that no application objects or revision marker exist, then verifies the revision and catalog fingerprint before committing. The snapshot includes the canonical schema, extensions, reference rows, and one new audit event recording that the baseline was installed. It does not claim the historical migrations ran on that new database.
- A database already at an older revision remains at `0118` during normal startup. `0119` is deferred until an explicit maintenance bridge. The operator command `bun run db:bridge-baseline --backup /absolute/new.dump --writers-stopped --maintenance-approved` requires the contracted `0118` shape, no other client connections, a fresh logical backup, successful restore into a separate disposable PostgreSQL 18 cluster, exact row counts and order-independent digests for all application tables, and a rolled-back write on the restored copy. It then advances the revision and confirms domain rows did not change. The backup remains available for recovery.
- Older active revisions upgrade through the preserved graph to `0118`, followed by the six separately guarded manual contracts. Pre-ADR-027 revision markers can map to `0001_initial` only with an explicit bridge flag and an exact reviewed 0001 schema fingerprint. Unknown, partial, or divergent shapes fail closed.
- `0119` downgrades to `0118` without schema changes; the Alembic audit hook records the revision change. The manual contracts that have no reconstructive down script still require restoration from their verified pre-contract backup.

## Consequences and limits

The SQL baseline is generated from a disposable database after the six manual contracts. The generator rejects unexpected inserted rows and `COPY` data so a dump containing financial records cannot accidentally become the committed snapshot. A fresh-install bootstrap and a contracted-`0118` bridge passed in disposable PostgreSQL 18, including a representative old `0002_add_url` marker. The synthetic Demo package was built with this baseline and its packaged native smoke passed. The maintained installation was found at `0113` and a fresh logical backup restored successfully with 75 table digests; no maintained migration was applied. An `0113` to `0118` upgrade passed on a disposable restore, but the resulting schema still has historical timestamp, default, index, sequence, and legacy-archive differences. Its `0119` bridge remains blocked until a separately reviewed normalization procedure resolves those differences without losing historical data. Schema fingerprints intentionally exclude owner names, access grants, row data, and sequence positions; the restore check separately compares table row digests, and normal startup reapplies runtime grants.

## Related

- [[docs/adr/index|Architecture Decision Records]]
- [[docs/guides/migrations|Database Migration Guide]]
- [[docs/features/backup-coverage-audit|Backup Coverage Audit]]
- [[docs/reference/data-model|Data Model Reference]]

## Implementation follow-up, 2026-09-20

[[docs/adr/166-maintained-database-canonical-conversion|ADR-166]] supersedes the
maintained-installation limit recorded above. Its separately approved procedure
converted the reviewed maintained legacy profile to the canonical `0119` shape.
The original no-DDL bridge still applies only to the contracted `0118` profiles.
