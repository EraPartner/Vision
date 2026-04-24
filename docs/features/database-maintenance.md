---
title: Database Maintenance UI
type: feature
status: active
date: 2026-04-25
updated: 2026-04-25
tags: [feature, admin, database, maintenance, performance, phase-7, vacuum]
description: Administrative interface for monitoring database statistics and running maintenance operations (VACUUM ANALYZE) on PostgreSQL tables; includes per-table and bulk operation modes.
aliases: [db maintenance, database admin, VACUUM, table stats]
related_code:
  - apps/node-backend/src/routes/admin.js
  - apps/frontend/src/pages/DbMaintenancePage.tsx
  - apps/node-backend/src/services/databaseMaintenanceService.js
---

# Database Maintenance UI (Phase 7)

> [!abstract] Overview
> The Database Maintenance page provides administrators with real-time visibility into PostgreSQL table health and the ability to execute VACUUM ANALYZE operations for performance optimization. Phase 7 addition.

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

## Related

- [[docs/api/admin|Admin API]]
- [[docs/features/settings|Settings & Administration]]
- [[docs/performance/index|Performance Optimization]]

## Related Code

- [[apps/node-backend/src/routes/admin.js]]
- [[apps/frontend/src/pages/DbMaintenancePage.tsx]]
