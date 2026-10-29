---
title: "ADR-262: App role gets MAINTAIN so admin VACUUM runs"
type: adr
status: accepted
date: 2026-10-29
tags: [adr, database, postgresql, security, least-privilege, admin, vacuum, adr-113, adr-133]
description: "The admin page's VACUUM ANALYZE ran as the least-privilege app role, which owns no tables, so PostgreSQL skipped every table with a warning and the route reported success. The app role now holds MAINTAIN on public tables, and the route refuses with 403 when a requested table lacks it. The page shows manual as well as automatic vacuum and analyze times."
aliases: [adr-262, maintain grant, admin vacuum privilege]
related_code:
  [
    "config/postgres/app-role-grants.sql.tpl",
    "apps/node-backend/src/database/roleBootstrap.ts",
    "apps/node-backend/src/routes/admin.ts",
    "apps/frontend/src/pages/DbMaintenancePage.tsx",
  ]
---

# ADR-262: App role gets MAINTAIN so admin VACUUM runs

## Status

Accepted on 2026-10-29. Tor chose "Grant MAINTAIN to the app role" over running VACUUM with the
migration owner's credentials or only reporting the failure.

## Context

- The backend pool connects as the least-privilege application role
  ([[docs/adr/113-native-macos-runtime|ADR-113]]). The migration owner owns every table.
- `POST /api/admin/database/vacuum` ran `VACUUM ANALYZE` (all) or `VACUUM ANALYZE "<table>"` on
  that pool. PostgreSQL does not fail a VACUUM the role may not run: it emits
  `WARNING: permission denied to vacuum "<table>", skipping it` and completes. The route's
  `42501` handler never fired, and the page showed "Vacuum completed". Reproduced on a local
  PostgreSQL 16 cluster with an owner role and a DML-only app role; PostgreSQL 18 uses the same
  warn-and-skip path, gated by the `MAINTAIN` privilege.
- The page showed only `last_autovacuum` and `last_autoanalyze`, so a manual run never changed
  the visible timestamps even when it did run.

## Decision

- The grant template adds `GRANT MAINTAIN ON ALL TABLES IN SCHEMA public` and a matching default
  privilege for tables the owner creates later. The bootstrap expands the ALL TABLES grants per
  relation as before; it now takes the privilege list from the template statement and grants
  only what applies to the relation kind (materialized views: SELECT and MAINTAIN; views and
  foreign tables: no MAINTAIN). Existing installs receive the grant on their next launch.
- The vacuum route reads `has_table_privilege(relid, 'MAINTAIN')` for every public table. If any
  requested table lacks it, the route returns `403` and runs nothing. "All tables" names every
  public table explicitly instead of a bare `VACUUM`, which would also try the system catalogs.
- `GET /api/admin/database/stats` adds `last_vacuum` and `last_analyze`. The page shows the later
  of the manual and automatic time in each column.

## Consequences

- MAINTAIN also allows ANALYZE, CLUSTER, REINDEX, REFRESH MATERIALIZED VIEW and LOCK TABLE on
  public tables. It adds no DDL, data or role rights.
- MAINTAIN exists from PostgreSQL 17. Vision packages only PostgreSQL 18; on an older external
  server the MAINTAIN grants fail per statement with a logged warning and the route returns 403.
- Not verified on the Mac. PostgreSQL 18 DB tests run in CI.
