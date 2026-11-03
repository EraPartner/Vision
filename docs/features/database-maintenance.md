---
title: Database Maintenance UI
type: feature
status: active
date: 2026-11-03
updated: 2026-11-03
tags:
  [
    feature,
    admin,
    database,
    maintenance,
    performance,
    phase-7,
    vacuum,
    db-data-editor,
    adr-101,
    adr-231,
    adr-262,
  ]
description: Administrative interface for monitoring SQLite table statistics, running VACUUM and ANALYZE, and (ADR-101) browsing/editing raw table data with optimistic concurrency, dry-run preview, and a log line per committed change.
aliases:
  [
    db maintenance,
    database admin,
    VACUUM,
    table stats,
    db data editor,
    table editor,
  ]
related_code:
  - apps/node-backend/src/routes/admin.ts
  - apps/node-backend/src/services/dbEditor.ts
  - apps/frontend/src/pages/DbMaintenancePage.tsx
  - apps/frontend/src/pages/admin/TableDataEditorPage.tsx
  - apps/frontend/src/features/admin/useTableDataEditorData.ts
---

# Database Maintenance UI (Phase 7 + ADR-101)

> [!abstract] Overview
> The Database Maintenance page provides administrators with real-time visibility into the tables of Vision's SQLite database and the ability to run VACUUM and ANALYZE for performance optimization ([[docs/adr/263-sqlite-replaces-postgresql|ADR-263]]). Phase 7 addition. ADR-101 (2026-06-18) extends it with a JetBrains-style **data editor** for permitted tables: browse, filter, sort, and edit/insert/delete rows with optimistic-concurrency protection, a SQL dry-run preview, and a log line per committed change.

## Feature Overview

The Database maintenance page (`/admin/db`) displays live statistics for every table in the Vision database and allows running maintenance for one table or for all of them. SQLite's `VACUUM` always rebuilds the whole database file; the table choice selects which table `ANALYZE` refreshes. This is useful for:

- **Size monitoring**: See exact row counts and the pages each table and its indexes use
- **Disk space optimization**: Reclaim the free pages left by deleted rows
- **Query planning**: Updated table statistics improve query plans
- **Performance tuning**: Identify tables needing attention

## Endpoints

### GET /api/admin/database/stats

Retrieve statistics for every user table: exact row counts, sizes from `dbstat`, and the times of
this process's last maintenance run. The response shape and every field are described in
[[docs/api/admin|Admin API]].

---

### POST /api/admin/database/vacuum

Run `VACUUM`, then `ANALYZE` on the table in the optional JSON body field `table` (or on all
tables), then `PRAGMA optimize`. The response is `{ "vacuumed": "<table>" }`, or
`{ "vacuumed": "all" }`. See [[docs/api/admin|Admin API]].

---

## Architecture

### Backend Implementation

SQLite does not allow `VACUUM` inside a transaction, so the route runs it on the single writer
connection while it holds that connection exclusively (`withExclusiveWriter` in
`apps/node-backend/src/database/connection.ts`). The exclusive hold waits for running write
transactions to finish, and other writers wait until maintenance ends. The table name in the
request is only a lookup key: the route checks it against the user tables from `pragma_table_list`
and quotes the catalog's copy of the name for `ANALYZE`.

SQLite records no maintenance history, so the route keeps the time of its last `VACUUM` and of
each table's last `ANALYZE` in memory. A restart resets them to `null`.

The backend opens the database file itself and has no database roles, so the former `MAINTAIN`
privilege check and its `403` are gone ([[docs/adr/263-sqlite-replaces-postgresql|ADR-263]]
supersedes the role split of [[docs/adr/262-app-role-maintain-for-admin-vacuum|ADR-262]]).

### Frontend Implementation

**Location:** `apps/frontend/src/pages/DbMaintenancePage.tsx`

The page consists of:

1. **Statistics Table**: Displays all tables with:
   - Live row count
   - Dead row count (always 0: SQLite keeps no dead row versions)
   - Size of the table and its indexes ("—" when the SQLite build has no `dbstat`)
   - Last vacuum timestamp (the later of manual and automatic; SQLite has only manual runs)
   - Last analyze timestamp (the later of manual and automatic; SQLite has only manual runs)

Timestamp and size columns keep their values on one line with reserved minimum widths. The table scrolls horizontally within its container when the window cannot fit all columns.

2. **Row Count Behavior**:
   - Row counts (`live_rows`) are exact: the route runs `count(*)` on every table for each request.
     Before ADR-263 they were estimates from PostgreSQL's `pg_stat_user_tables`.

3. **Actions** ([[docs/adr/187-completeness-sweep|ADR-187]]):
   - "Vacuum all tables" is the primary header button (bulk operation); Refresh is the header ••• menu item
   - Each table row has a ••• menu with "Browse rows" (opens the data editor) and "Run vacuum" (per-table operation); the table name is also a link to the editor

4. **Progress & Feedback**:
   - Loading state during operation
   - Success/error toast notifications
   - Automatic refresh after completion

## Usage

1. Navigate to `/admin/db` in the application
2. Review table statistics
3. Click "Vacuum all tables" for bulk maintenance, or choose "Run vacuum" in a table row's ••• menu
4. Monitor progress; page auto-refreshes stats upon completion

---

## DB Data Editor (ADR-101)

> [!info] Added 2026-06-18
> The data editor is reached from the table name link or the row ••• menu's "Browse rows" item on the Database maintenance page. It opens at route `/admin/db/:table`.

### How to open

1. Navigate to `/admin/db` (DB Maintenance page).
2. Double-click any row in the table list to open that table in the editor (`/admin/db/:table`).

### Browsing, filtering, and sorting

The editor page (`TableDataEditorPage.tsx`) renders a controlled grid using the existing `ui/table` primitives (no new dependency). Features:

- **Column sizing**: data columns use a fixed 11rem width and the row-action column uses 3rem. Column names and text values wrap, including long identifiers, instead of widening the grid or truncating values. Tables with many columns still scroll horizontally inside the card.
- **Column headers** are sortable (click once for ASC, again for DESC). Sorting is paused while uncommitted changes exist to prevent silent loss of dirty state.
- **Per-column filter inputs** appear below each header with a short “Filter…” hint and a column-specific accessible label. Supported ops: `eq`, `ne`, `lt`, `lte`, `gt`, `gte`, `contains` (ILIKE), `startsWith` (ILIKE), `isnull`, `notnull`. Decimal columns filter and sort by exact value; text sorts bytewise.
- **Pagination** via `limit` (default 100, max 500) and `offset` controls.

The backend endpoint is `GET /api/admin/database/tables/:table/rows` — see [[docs/api/admin|Admin API]].

### Editing cells

- Click a writable, non-PK, non-generated cell, or focus it and press **Enter** or **Space**, to activate its inline editor. Cells and inputs identify their column and row for assistive technology.
- **Enter** stages the value and returns focus to the cell; **Escape** reverts the active cell and returns focus to it.
- Press **Enter** to stage the active value. Reopen a staged cell and press **Escape** to remove only that cell's pending value and restore its original value; other staged rows and cells remain intact. Escape also reverts staged boolean and new-row cells.
- A **Set NULL** icon button is shown for writable nullable columns with a non-NULL value.
- Dirty cells expose a per-cell undo button for pointer users; the same action is available with **Escape** from the active editor or boolean control.
- Boolean columns render as checkboxes.
- Edited cells are highlighted as **dirty state**. Filtering, sorting, and paging are paused while dirty rows exist so refetches cannot silently discard changes.
- **Add row** (the primary header button) appends a new blank row in dirty state; Refresh sits in the header ••• menu.
- Each row has a ••• menu: **Revert changes to this row** (for dirty rows), **Mark row for deletion** / **Undo delete** for existing rows, and **Discard new row** for rows added in this session.

### Previewing and committing

- The **Preview SQL** button sends the pending change set to `POST /api/admin/database/tables/:table/mutate` with `dryRun: true`. The server renders exact SQL statements and returns them in a dialog — no DB write occurs.
- The **Commit to database** button sends the batch with `dryRun: false`. All changes execute in one transaction (all-or-nothing). Any failure rolls back the entire batch.

### Optimistic concurrency

Each row returned by `/rows` includes a hidden `__xmin` token: a digest of the row's stored values. The commit runs in one `BEGIN IMMEDIATE` transaction on the single writer, so no other write runs between the version check and the write. The server compares each target row's current digest to the client's token. If another write changed the row's values since the editor loaded it, the server returns `409 Conflict` and the entire batch is rolled back. A write that stored the same values again does not count as a change. This prevents silent overwrites without requiring a full serializable transaction on reads.

### Tables with no primary key

Tables that lack a primary key are **read-only** in the data editor — the Commit to database button is disabled and `op: 'insert'/'update'/'delete'` changes are rejected server-side with a `400` error.

### Safety model summary

| Concern                                               | Mitigation                                                                                              |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| SQL injection via table/column identifiers            | Names validated against `pragma_table_list` / `pragma_table_xinfo`; identifiers double-quoted           |
| SQL injection via values                              | Always parameterized                                                                                    |
| Read queries causing mutations                        | All reads run in one snapshot on the read-only (`PRAGMA query_only`) connection                         |
| Hung read queries                                     | No statement timeout on SQLite; reads are bounded by `limit` (max 500) and keyset paging                |
| Raw WHERE clause abuse                                | The raw `where` parameter was removed; only structured, parameterized `filters`                         |
| Silent concurrent overwrites                          | `__xmin` row-version digest; `409 Conflict` on mismatch                                                 |
| Values that would break storage CHECKs                | Written through `vision_numeric` / `vision_jsonb` / `vision_ts` / `ts_date`; generated columns read-only |
| Constraint violations surfaced as raw database errors | SQLSTATEs (`23502/23503/23001/23505/23514/22P02`) mapped to friendly 400/409 messages                   |
| Write lock held by another writer                     | A timed-out wait (`55P03`) returns a retryable `503`                                                    |
| Partial batch application                             | Entire batch runs in one transaction; any failure rolls back all changes                                |
| Untraceable edits                                     | Each committed change is written to the structured logger (no database change table since ADR-231)      |

### Bypass-domain-validation caveat

> [!warning] Raw writes bypass app-level domain logic
> The data editor writes directly to the database. It honors every _structural_ constraint SQLite enforces (FK, CHECK, NOT NULL, UNIQUE), but **skips** application-level rules, computed/derived values, and cascade side-effects that live only in repository/service code. Only the admin (with full visibility into the data model) should use this tool. See [[docs/adr/101-db-data-editor|ADR-101]] for the full trade-off discussion.

Account-table writes follow the same funding-graph protocol as account create, PATCH, and merge.
On PostgreSQL that was a transaction-scoped advisory lock. On SQLite the editor's `BEGIN IMMEDIATE`
transaction already holds the database write lock, so it serializes funding-graph changes against
every other writer; `lockAccountFundingGraph()` remains as the protocol point and takes nothing.
A timed-out wait for the write lock returns the same retryable `503` as before. The editor does
not run the application-level `funding_account_id` existence or cycle checks, so the administrator
remains responsible for preserving those invariants.

### Materialized-view auto-refresh

After a successful commit to `transactions`, `recipients`, or `categories` (the base tables for the dashboard summary tables `mv_*`, which the editor shows read-only), the service calls the existing debounced `scheduleRefresh()` from `materializedViewService`. The commit response includes `refreshScheduled: true` when this happens. Edits to other tables skip the refresh.

### Change log

After commit, the service emits one structured log line per applied change
(`db-editor mutation committed`, with table, operation, and primary key). No database table
records editor changes: migration `0004_remove_audit_history` dropped `db_editor_audit`, which
migration `0059_db_editor_audit` had created ([[docs/adr/231-remove-audit-history|ADR-231]]).

### API endpoints

| Method | Path                                       | Purpose                                           |
| ------ | ------------------------------------------ | ------------------------------------------------- |
| `GET`  | `/api/admin/database/tables/:table/schema` | Column metadata + PK discovery                    |
| `GET`  | `/api/admin/database/tables/:table/rows`   | Paginated/filtered/sorted read                    |
| `POST` | `/api/admin/database/tables/:table/mutate` | Batch write (insert/update/delete); `dryRun` mode |

Full endpoint documentation: [[docs/api/admin|Admin API]].

---

## Related

- [[docs/api/admin|Admin API]]
- [[docs/adr/101-db-data-editor|ADR-101: Admin DB data editor]]
- [[docs/features/settings|Settings & Administration]]
- [[docs/performance/index|Performance Optimization]]
- [[docs/adr/231-remove-audit-history|ADR-231: Remove audit history]] — why `db_editor_audit` was dropped
- [[docs/adr/262-app-role-maintain-for-admin-vacuum|ADR-262: App role gets MAINTAIN so admin VACUUM runs]] (superseded by ADR-263)
- [[docs/adr/263-sqlite-replaces-postgresql|ADR-263: SQLite replaces PostgreSQL]]

## Related Code

- [[apps/node-backend/src/routes/admin.ts]]
- [[apps/node-backend/src/services/dbEditor.ts]]
- [[apps/frontend/src/pages/DbMaintenancePage.tsx]]
- [[apps/frontend/src/pages/admin/TableDataEditorPage.tsx]]
