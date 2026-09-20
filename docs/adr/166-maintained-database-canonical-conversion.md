---
title: ADR-166 - Maintained Database Canonical Conversion
type: adr
status: Accepted
date: 2026-09-20
tags: [adr, database, migration, backup, recovery]
description: Convert the reviewed maintained legacy database into the fresh 0119 schema with UTC timestamps, a verified archive export, and a retained rollback database.
aliases: [maintained database conversion, legacy baseline conversion]
---

# ADR-166: Maintained Database Canonical Conversion

## Context

[[docs/adr/165-reviewed-fresh-database-baseline|ADR-165]] makes `0119` a reviewed fresh-install baseline and allows a no-DDL bridge for an installation that already has the contracted schema. The maintained installation does not have that shape. It is at `0113`; on a disposable restore, its normal upgrade reaches `0118` but still differs from the fresh schema in 143 catalog entries. Differences include timestamp types, defaults, enum order, constraints, indexes, sequence names, old `schema_version`, and 390 rows in `adr109_legacy_archive`.

This history traces to [[docs/adr/027-alembic-single-source-of-schema|ADR-027]]: the previous node schema initializer and Alembic could create different shapes, and the Alembic switch carried existing tables forward. [[docs/adr/109-flat-investments-schema-canonical|ADR-109]] later retained and then archived the old investment relations. A revision marker alone cannot prove fresh-schema parity.

The operator chose conversion to the fresh shape, UTC interpretation of old timestamps without a time zone, and a separate verified export of the 390-row archive. This supersedes ADR-165's no-data-rewrite policy for this one reviewed legacy profile. The no-DDL bridge remains available for installations that already have the contracted schema.

## Decision

`bun run db:convert-legacy-baseline` is an explicit maintenance command, not a startup migration. It accepts only the reviewed maintained `0118` profile and a local PostgreSQL 18 cluster with stopped writers. It requires new paths in owner-only directories for a full logical backup and an archive export. It restore-tests the full backup in disposable PostgreSQL and restores the archive separately to confirm its row count and digest.

The command creates a new database with the reviewed `0119` fresh schema. It copies the source rows under a UTC session, maps the two legacy investment sequence states to their canonical sequence names, validates every foreign key, and compares counts and row digests for all 81 shared domain tables. Source timestamp columns are normalized to UTC for this comparison. The source `schema_version` rows remain in the full backup and retained database; the 390 archived rows also remain in the separate verified export. Neither legacy table enters the new canonical schema.

The copied audit chain replaces the new database's synthetic genesis. The command runs the real `0118` to `0119` Alembic transition on the new database so the audit chain records that revision, verifies it against the source head, applies runtime-role grants, and tests a rolled-back runtime-role write. It checks that the source stayed unchanged, writes an owner-only recovery journal, then swaps database names. The prior database remains under the journal's rollback name. A post-swap manifest must exactly match the pre-swap converted manifest.

Before any new application write, `bun run db:rollback-legacy-baseline` may restore the prior database name. It refuses if either database's manifest differs from the journal or writers are connected. It retains the converted database under another name. After new writes, recovery requires an explicit data reconciliation or restoration from the verified full backup.

## Consequences and limits

- The conversion is a data-copying operation and needs space for two databases plus two owner-only dumps. Those dumps are not encrypted by the command; they must stay on protected local storage and be encrypted before transfer.
- The UTC rule changes the instant represented by old timestamp-without-time-zone values compared with interpreting them in `Europe/Helsinki`. Financial amounts, dates, and transaction identifiers remain unchanged. The exact rule is checked by per-table digests.
- The command accepts one reviewed maintained legacy shape. Unknown old shapes still fail closed; other supported upgrade profiles need their own evidence and, if different, their own guarded conversion.
- A disposable restore of the maintained backup passed conversion with 81 domain-table digests, 84 foreign keys, audit-chain verification, runtime-role access, archive verification, and rollback. During the approved maintenance window, the maintained database was upgraded from `0113` to `0118`, then converted to `0119`. The command reported 81 matching domain-table digests, 84 validated foreign keys, audit-chain continuity, a verified separate archive, a new full backup, and a retained pre-conversion database. The rebuilt package loaded Dashboard, Transactions, Statistics, and Tax against the converted database. The same `app.asar` was installed at `/Applications/Vision.app`; its backend health check passed. The previous app bundle remains at `/Applications/Vision.app.old-0119-20260920`.

## Related

- [[docs/adr/index|Architecture Decision Records]]
- [[docs/guides/migrations|Database Migration Guide]]
- [[docs/reference/scripts|Scripts Reference]]
