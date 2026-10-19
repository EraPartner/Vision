---
title: Migration History (Retired Snapshot)
type: reference
status: deprecated
date: 2026-10-19
updated: 2026-10-19
tags: [reference, database, migrations, dependencies, alembic, historical]
description: Retired static Alembic migration-chain snapshot. The schema now starts from db/migrations/0001_baseline.sql; use db:status and the migration guide for the current chain.
aliases: [migration dependencies, migration chain, migration groups]
---

# Migration History (Retired Snapshot)

> [!warning] This static chain is retired
> This page previously copied the active Alembic chain into Markdown. Since
> [[docs/adr/222-typescript-migrations-kysely-baseline|ADR-222]] (2026-10-19) the Alembic tree is
> deleted: `db/migrations/0001_baseline.sql` holds the complete schema at the former Alembic head
> `0128_category_path_on_legacy_rename`, and later changes are numbered `db/migrations/` files.
> The Alembic revisions survive only in Git history.

## Current Migration Workflow

- Follow [[docs/guides/migrations|Migration Guide]] when creating, applying, or
  rolling back a migration.
- See [[docs/reference/scripts#Database|Scripts Reference]] for the supported commands.
- Run `bun run db:status` against the target database to list applied and pending
  migrations. Repository history does not prove deployment state.
- Inspect `db/migrations/` for migration SQL and optional `.down.sql` rollbacks.

The chain is linear: files apply in name order, and the schema revision of a database is the
highest name in `public.kysely_migration`. Do not copy a numbered list into this page.

## Archived Alembic Numbering

The historical Alembic revision numbers (`0001`–`0128`, plus the older pre-renumbering tree) still
appear across feature and reference pages as history. They are not files in the repository and are
not applied to any database; the baseline already contains their result.

The retired grouping used in the old documentation was:

| Historical group | Revisions | Former purpose |
|------------------|-----------|----------------|
| Core schema | 0001-0012 | Core transaction, planning, portfolio, and split tables |
| Portfolio inheritance | 0013-0018 | Inheritance views, triggers, and asset-specific transaction tables |
| Price providers and caching | 0019-0022 | Historical price cache and provider enum changes |
| Performance snapshots | 0023-0024 | Portfolio performance snapshot storage |
| Aggregation consolidation | 0035 | Recipient aggregation artifacts in that historical tree |

These ranges are historical labels only.

## Related

- [[docs/guides/migrations|Migration Guide]]
- [[docs/reference/scripts#Database|Scripts Reference]]
- [[docs/adr/222-typescript-migrations-kysely-baseline|ADR-222]]
- [[docs/adr/002-database-schema|Database Schema ADR]]
- [[docs/reference/database-triggers|Database Triggers]]
