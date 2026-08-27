---
title: Migration History (Retired Snapshot)
type: reference
status: deprecated
date: 2026-03-31
updated: 2026-08-26
tags: [reference, database, migrations, dependencies, alembic, historical]
description: Retired static migration-chain snapshot. Use Alembic history and the migration guide for the current active chain.
aliases: [migration dependencies, migration chain, migration groups]
---

# Migration History (Retired Snapshot)

> [!warning] This static chain is retired
> This page previously copied the active Alembic chain into Markdown. The copy
> drifted as migrations were added, so it is no longer an operational source.
> Use `bun run db:history` and the files under `alembic/versions/` for the
> current chain.

## Current Migration Workflow

- Follow [[docs/guides/migrations|Migration Guide]] when creating, applying, or
  rolling back a migration.
- See [[docs/reference/scripts#Database & Migration Scripts|Scripts Reference]]
  for the supported commands.
- Run `bun run db:history` to read the active dependency order from each
  revision's `down_revision` metadata.
- Run `bun run db:current` against the target database to learn what is actually
  applied. Repository history does not prove deployment state.
- Inspect `alembic/versions/` for migration implementation, downgrade behavior,
  blast radius, and linked Architecture Decision Records (ADRs).

The active chain is linear unless Alembic reports multiple heads. Do not copy a
new numbered list into this page; a static list will become stale again.

## Archived Legacy Tree

`alembic/legacy_versions/` contains the archived pre-renumbering tree. It is
kept for historical analysis and for recognizing older deployment stamps. It is
not the chain applied to fresh installations.

The retired grouping used in the old documentation was:

| Historical group | Revisions | Former purpose |
|------------------|-----------|----------------|
| Core schema | 0001-0012 | Core transaction, planning, portfolio, and split tables |
| Portfolio inheritance | 0013-0018 | Inheritance views, triggers, and asset-specific transaction tables |
| Price providers and caching | 0019-0022 | Historical price cache and provider enum changes |
| Performance snapshots | 0023-0024 | Portfolio performance snapshot storage |
| Aggregation consolidation | 0035 | Recipient aggregation artifacts in that historical tree |

These ranges are historical labels only. They must not be used to select,
skip, stamp, upgrade, or downgrade active revisions.

## Related

- [[docs/guides/migrations|Migration Guide]]
- [[docs/reference/scripts#Database & Migration Scripts|Scripts Reference]]
- [[docs/adr/002-database-schema|Database Schema ADR]]
- [[docs/reference/database-triggers|Database Triggers]]
