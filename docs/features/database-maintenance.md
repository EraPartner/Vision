---
title: Database Maintenance UI
type: feature
status: active
date: 2026-04-25
updated: 2026-06-18
tags: [feature, admin, database, maintenance, performance, phase-7, vacuum, db-data-editor, adr-101, audit]
description: Administrative interface for monitoring database statistics, running VACUUM ANALYZE operations, and (ADR-101) browsing/editing raw table data with optimistic concurrency, dry-run preview, and a committed-SQL audit trail.
aliases: [db maintenance, database admin, VACUUM, table stats, db data editor, table editor]
related_code:
  - apps/node-backend/src/routes/admin.js
  - apps/node-backend/src/services/dbEditor.js
  - apps/frontend/src/pages/DbMaintenancePage.tsx
  - apps/frontend/src/pages/admin/TableDataEditorPage.tsx
  - apps/node-backend/src/services/databaseMaintenanceService.js
---

# Database Maintenance UI (Phase 7 + ADR-101)

> [!abstract] Overview
> The Database Maintenance page provides administrators with real-time visibility into PostgreSQL table health and the ability to execute VACUUM ANALYZE operations for performance optimization. Phase 7 addition. ADR-101 (2026-06-18) extends it with a JetBrains-style **data editor**: double-click any table row to open a grid editor where you can browse, filter, sort, and edit/insert/delete rows with optimistic-concurrency protection, a SQL dry-run preview, and a committed-SQL audit trail.

## Feature Overview

The DB Maintenance page (`/admin/db`) displays live statistics for every table in the Vision database and allows running `VACUUM ANALYZE` on a per-table or bulk basis. This is critical for:

- **Autovacuum monitoring**: See actual dead row counts and bloat
- **Disk space optimization**: Reclaim space from deleted rows
- **Query planning**: Updated table statistics improve query plans
- **Performance tuning**: Identify tables needing attention

## Endpoints

### GET /api/admin/db/stats

Retrieve current table statistics including row counts, dead rows, and estimated size.

**Query Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `table` | string | none | Optional: specific table name to fetch; omit for all tables |

**Response:**

```json
{
  "tables": [
    {
      "table_name": "transactions",
      "live_rows": 2453,
      "dead_rows": 127,
      "size_mb": 3.2,
      "last_vacuum": "2026-04-24T10:15:32Z",
      "last_analyze": "2026-04-24T10:15:32Z",
      "autovacuum_enabled": true
    },
    {
      "table_name": "categories",
      "live_rows": 45,
      "dead_rows": 2,
      "size_mb": 0.1,
      "last_vacuum": "2026-04-23T03:21:15Z",
      "last_analyze": "2026-04-23T03:21:15Z",
      "autovacuum_enabled": true
    }
  ],
  "timestamp": "2026-04-24T12:34:56Z"
}
```

---

### POST /api/admin/db/vacuum

Run `VACUUM ANALYZE` on one or all tables.

**Query Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `table` | string | No | Specific table name to vacuum; omit to vacuum all |
| `analyze` | boolean | No (default true) | Run ANALYZE after VACUUM |

**Response:**

```json
{
  "success": true,
  "message": "VACUUM ANALYZE completed on 3 table(s)",
  "tables_vacuumed": [
    {
      "table_name": "transactions",
      "status": "completed",
      "duration_ms": 245
    },
    {
      "table_name": "investments",
      "status": "completed",
      "duration_ms": 67
    }
  ],
  "total_duration_ms": 312
}
```

**Error Response (409):**

```json
{
  "detail": "VACUUM already running. Please wait."
}
```

---

## Architecture

### Backend Implementation

The VACUUM operation uses a **raw database client** (not the connection pool) because PostgreSQL does not allow VACUUM inside a transaction:

```javascript
// apps/node-backend/src/routes/admin.js
const client = await getClient(); // Raw client, not pool
try {
  await client.query('VACUUM ANALYZE ' + (tableName ? `"${tableName}"` : ''));
} finally {
  await client.release();
}
```

**Why raw client?**
- VACUUM cannot run in a transaction block
- The connection pool wraps all queries in implicit transactions
- We need an auto-commit connection for this operation

### Frontend Implementation

**Location:** `apps/frontend/src/pages/DbMaintenancePage.tsx`

The page consists of:

1. **Statistics Table**: Displays all tables with:
   - Live row count
   - Dead row count (indicator of vacuum pressure)
   - Estimated size in MB
   - Last vacuum timestamp
   - Last analyze timestamp

2. **Row Count Behavior**:
   - **Important:** Row counts (`live_rows`, `dead_rows`) are estimates from PostgreSQL statistics (via `pg_stat_user_tables`), not authoritative counts. They are only updated when VACUUM ANALYZE is run.
   - All tables display actual row counts from PostgreSQL statistics regardless of their vacuum/analyze history. Tables with no vacuum/analyze events show the last known statistics (which may be zero for newly created tables).
   - Row count accuracy improves after running VACUUM ANALYZE, which updates the statistics.

3. **Action Buttons**:
   - "Vacuum All Tables" (bulk operation)
   - "Vacuum" (per-table operation)

4. **Progress & Feedback**:
   - Loading state during operation
   - Success/error toast notifications
   - Automatic refresh after completion

## Usage

1. Navigate to `/admin/db` in the application
2. Review table statistics
3. Click "Vacuum All Tables" for bulk maintenance, or click "Vacuum" on specific tables
4. Monitor progress; page auto-refreshes stats upon completion

---

## DB Data Editor (ADR-101)

> [!info] Added 2026-06-18
> The data editor is reached by double-clicking any table row on the DB Maintenance page. It opens at route `/admin/db/:table`.

### How to open

1. Navigate to `/admin/db` (DB Maintenance page).
2. Double-click any row in the table list to open that table in the editor (`/admin/db/:table`).

### Browsing, filtering, and sorting

The editor page (`TableDataEditorPage.tsx`) renders a controlled grid using the existing `ui/table` primitives (no new dependency). Features:

- **Column headers** are sortable (click once for ASC, again for DESC). Sorting is paused while uncommitted changes exist to prevent silent loss of dirty state.
- **Per-column filter inputs** appear below each header. Supported ops: `eq`, `ne`, `lt`, `lte`, `gt`, `gte`, `contains` (ILIKE), `startsWith` (ILIKE), `isnull`, `notnull`.
- **Raw WHERE box** for free-form SQL predicates. Semicolons are rejected server-side; the query runs inside a READ ONLY transaction so mutation is structurally impossible.
- **Pagination** via `limit` (default 100, max 500) and `offset` controls.

The backend endpoint is `GET /api/admin/database/tables/:table/rows` — see [[docs/api/admin|Admin API]].

### Editing cells

- Click any non-PK, non-generated cell to activate an inline editor.
- A **NULL toggle** checkbox is shown for nullable columns.
- Boolean columns render as checkboxes.
- Edited cells are highlighted as **dirty state**. Filtering, sorting, and paging are paused while dirty rows exist so refetches cannot silently discard changes.
- **Add row** button appends a new blank row in dirty state.
- **Mark for deletion** button marks an existing row for delete in dirty state.

### Previewing and committing

- The **Preview** button sends the pending change set to `POST /api/admin/database/tables/:table/mutate` with `dryRun: true`. The server renders exact SQL statements and returns them in a dialog — no DB write occurs.
- The **Commit** button sends the batch with `dryRun: false`. All changes execute in one transaction (all-or-nothing). Any failure rolls back the entire batch.

### Optimistic concurrency

Each row returned by `/rows` includes a hidden `__xmin` token (PostgreSQL row version). On commit, the server locks each target row `FOR UPDATE` and compares the current `xmin` to the client's token. If another write changed the row since the editor loaded it, the server returns `409 Conflict` and the entire batch is rolled back. This prevents silent overwrites without requiring a full serializable transaction on reads.

### Tables with no primary key

Tables that lack a primary key are **read-only** in the data editor — the Commit button is disabled and `op: 'insert'/'update'/'delete'` changes are rejected server-side with a `400` error.

### Safety model summary

| Concern | Mitigation |
|---------|-----------|
| SQL injection via table/column identifiers | Names validated against `pg_stat_user_tables` / `information_schema.columns`; identifiers double-quoted |
| SQL injection via values | Always parameterized |
| Read queries causing mutations | All reads run in a `READ ONLY` transaction |
| Hung read queries | `SET LOCAL statement_timeout = '10s'` |
| Raw WHERE clause abuse | Semicolons rejected; runs inside READ ONLY transaction |
| Silent concurrent overwrites | `xmin` optimistic-concurrency token; `409 Conflict` on mismatch |
| Constraint violations surfaced as raw Postgres errors | SQLSTATEs (`23502/23503/23505/23514/22P02`) mapped to friendly 400/409 messages |
| Partial batch application | Entire batch runs in one transaction; any failure rolls back all changes |
| No audit trail | Every committed statement written to `db_editor_audit` inside the same transaction + structured logger |

### Bypass-domain-validation caveat

> [!warning] Raw writes bypass app-level domain logic
> The data editor writes directly to PostgreSQL. It honors every *structural* constraint Postgres enforces (FK, CHECK, NOT NULL, UNIQUE), but **skips** application-level rules, computed/derived values, and cascade side-effects that live only in repository/service code. Only the admin (with full visibility into the data model) should use this tool. See [[docs/adr/101-db-data-editor|ADR-101]] for the full trade-off discussion.

### Materialized-view auto-refresh

After a successful commit to `transactions`, `recipients`, or `categories` (the base tables for the dashboard materialized views), the service calls the existing debounced `scheduleRefresh()` from `materializedViewService`. The commit response includes `refreshScheduled: true` when this happens. Edits to other tables skip the refresh.

### Audit table

Migration `alembic/versions/0059_db_editor_audit.py` creates:

```sql
CREATE TABLE db_editor_audit (
  id          BIGSERIAL PRIMARY KEY,
  table_name  TEXT NOT NULL,
  op          TEXT NOT NULL,          -- 'insert' | 'update' | 'delete'
  pk_json     JSONB,
  before_json JSONB,
  after_json  JSONB,
  statement   TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_db_editor_audit_table_time ON db_editor_audit (table_name, created_at DESC);
```

Audit rows are written inside the same transaction as the change, so a rollback also removes the audit entry. The `db_editor_audit` table is itself browsable (and editable) through the data editor.

### API endpoints

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/api/admin/database/tables/:table/schema` | Column metadata + PK discovery |
| `GET` | `/api/admin/database/tables/:table/rows` | Paginated/filtered/sorted read |
| `POST` | `/api/admin/database/tables/:table/mutate` | Batch write (insert/update/delete); `dryRun` mode |

Full endpoint documentation: [[docs/api/admin|Admin API]].

---

## Related

- [[docs/api/admin|Admin API]]
- [[docs/adr/101-db-data-editor|ADR-101: Admin DB data editor]]
- [[docs/features/settings|Settings & Administration]]
- [[docs/performance/index|Performance Optimization]]
- [[docs/reference/data-model#db_editor_audit (June 2026, migration 0059)|Data Model — db_editor_audit]] — schema reference for the audit table

## Related Code

- [[apps/node-backend/src/routes/admin.js]]
- [[apps/node-backend/src/services/dbEditor.js]]
- [[apps/frontend/src/pages/DbMaintenancePage.tsx]]
- [[apps/frontend/src/pages/admin/TableDataEditorPage.tsx]]
