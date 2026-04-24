---
title: Admin API
type: endpoint
status: active
date: 2026-04-25
tags:
  - api
  - admin
  - system
  - updates
  - shadow-divergences
  - observability
  - phase-f
description: API endpoints for system administration, database management, and
  application updates
aliases:
  - admin
  - system admin
  - health
  - initialization
related_code:
  - apps/node-backend/src/routes/admin.js
  - apps/node-backend/src/main.js
  - apps/node-backend/src/config/config.js
  - apps/frontend/src/lib/api/admin.ts
  - apps/frontend/src/pages/ShadowDivergencesPage.tsx
---

# Admin API

System administration endpoints for database management, health checks, and application updates.

## Base URL

```
/api/admin
```

## Endpoints (12 total)

### GET /api/admin

Get system health and initialization status.

**Response:** `200 OK`

```json
{
  "is_initialised": true,
  "table_count": 15,
  "timestamp": "2025-03-18T10:00:00.000Z",
  "links": []
}
```

**Response:** `500 Internal Server Error`

```json
{
  "detail": "Failed to retrieve administration status"
}
```

Implementation note:
- Internal route refactor extracted `formatAdminStatusPayload(isConnected, tableCount)` to centralize status payload construction while preserving response shape and status codes ([[apps/node-backend/src/routes/admin.js]]).

---

### POST /api/admin/database/init

Verify database connection and initialization status.

**Response:** `201 Created`

```json
{
  "message": "Database connection verified successfully",
  "details": {
    "note": "Tables are managed by Alembic migrations"
  },
  "links": []
}
```

**Response:** `500 Internal Server Error`

```json
{
  "detail": "Administrative operation failed"
}
```

---

### POST /api/admin/database/reset

Reset the database (requires explicit confirmation).

**Query Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `force` | boolean | Yes | Must be `true` to confirm destructive operation |

**Response:** `200 OK`

```json
{
  "message": "Database reset should be performed via Alembic migrations (Python backend)",
  "details": {
    "warning": "Use the Python backend for destructive database operations"
  },
  "links": []
}
```

**Response:** `404 Not Found`

```json
{
  "detail": "Database reset endpoint disabled"
}
```

**Response:** `400 Bad Request`

```json
{
  "message": "Database reset requires force=true parameter",
  "details": {
    "error": "Set force=true query parameter to confirm reset (DESTRUCTIVE)"
  },
  "links": []
}
```

---

### POST /api/admin/investments/kinesis/sanitize-history

Run persisted Kinesis history sanitization for all investments where `price_provider='kinesis'`.

**Response:** `200 OK`

```json
{
  "message": "Kinesis historical spikes sanitization completed",
  "processed": 3,
  "updated": 2,
  "correctedPoints": 5,
  "failed": 0
}
```

**Response:** `500 Internal Server Error`

```json
{
  "detail": "Failed to sanitize Kinesis history"
}
```

---

### GET /api/admin/db/stats (Phase 7)

Retrieve current database table statistics.

**Query Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `table` | string | Optional: specific table name; omit for all tables |

**Response:** `200 OK`

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

**Important Note on Row Counts:**
- `live_rows` and `dead_rows` are estimates from PostgreSQL's `pg_stat_user_tables` view, not authoritative counts
- These estimates are only updated when VACUUM ANALYZE is executed
- Tables inserted into but never analyzed will return `0` (represented as `—` in the frontend UI) until the first VACUUM ANALYZE run
- This is expected PostgreSQL behavior; see [[docs/features/database-maintenance|Database Maintenance Feature]] for context

**Response:** `500 Internal Server Error`

```json
{
  "detail": "Failed to retrieve database statistics"
}
```

See [[docs/features/database-maintenance|Database Maintenance Feature]] for details.

---

### POST /api/admin/db/vacuum (Phase 7)

Run `VACUUM ANALYZE` on one or all tables.

**Query Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `table` | string | No | Specific table name to vacuum; omit to vacuum all |
| `analyze` | boolean | No (default true) | Run ANALYZE after VACUUM |

**Response:** `200 OK`

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

**Response:** `409 Conflict` (VACUUM already running)

```json
{
  "detail": "VACUUM already running. Please wait."
}
```

**Implementation note:**
- Uses raw database client (not connection pool) because VACUUM cannot run inside a transaction
- See [[docs/features/database-maintenance|Database Maintenance Feature]] for architectural details

---

### GET /api/admin/update/check

Check for application updates via GitHub Releases API.

**Response:** `200 OK`

```json
{
  "up_to_date": true,
  "current_version": "1.2.3",
  "latest_version": "v1.2.3",
  "published_at": "2025-03-15T12:00:00Z",
  "release_notes": "Bug fixes and improvements...",
  "html_url": "https://github.com/EraPartner/Vision/releases/tag/v1.2.3"
}
```

**Response:** `200 OK` (no releases found)

```json
{
  "up_to_date": true,
  "error": "No published releases found",
  "latest_version": null
}
```

**Response:** `500 Internal Server Error`

```json
{
  "detail": "Administrative operation failed"
}
```

Implementation notes:
- Internal route refactor centralized release/version/update payload logic into `hasValidReleaseTag(release)`, `detectCurrentAppVersion()`, and `buildUpdateCheckPayload(release, currentVersion)`.
- The endpoint behavior is unchanged: same no-release fallback payload, same up-to-date comparison (`latest === current` or `latest === v${current}`), and same response fields ([[apps/node-backend/src/routes/admin.js]]).

---

### POST /api/admin/update/apply

Apply an available update.

**Response:** `200 OK`

```json
{
  "success": true,
  "note": "Updates are applied automatically by the desktop app. If an update is available, use the notification in the Vision app window to download and install it."
}
```

---

### POST /api/admin/update/apply-and-restart

Apply update and restart the application (backwards compatibility endpoint).

**Response:** `200 OK`

```json
{
  "success": true,
  "note": "Updates are managed by the Vision desktop app via Docker image pulls and the desktop shell updater. No manual action is required."
}
```

---

### GET /api/admin/shadow-divergences/summary (Phase F)

Get a per-endpoint summary of aggregation shadow divergences. Returns divergence counts, maximum divergence count per endpoint, and the most recent timestamp.

**Response:** `200 OK`

```json
{
  "endpoints": [
    {
      "endpoint": "/api/aggregations/monthly-summary",
      "count": 3,
      "last_seen": "2026-04-25T14:32:10.123Z",
      "max_divergence_count": 2
    },
    {
      "endpoint": "/api/aggregations/category-breakdown",
      "count": 1,
      "last_seen": "2026-04-24T09:15:00.000Z",
      "max_divergence_count": 1
    }
  ],
  "total": 4
}
```

**Implementation notes:**
- Queries `agg_shadow_divergences` table grouped by endpoint
- Returns results ordered by divergence count (descending)
- Used by frontend admin dashboard to display summary card and endpoint filter options

---

### GET /api/admin/shadow-divergences (Phase F)

Retrieve a paginated list of aggregation shadow divergences from the `agg_shadow_divergences` materialized log.

**Query Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `limit` | integer | 50 | Results per page (capped at 200) |
| `offset` | integer | 0 | Pagination offset |
| `endpoint` | string | null | Filter by endpoint path; omit for all |

**Response:** `200 OK`

```json
{
  "rows": [
    {
      "id": 1,
      "endpoint": "/api/aggregations/monthly-summary",
      "request_params": { "start_date": "2026-04-01", "end_date": "2026-04-30" },
      "divergences": [
        { "path": "data.total_income", "next": "5000.00", "legacy": "4999.99", "delta": 0.01 }
      ],
      "divergence_count": 1,
      "created_at": "2026-04-25T14:32:10.123Z"
    }
  ],
  "total": 42,
  "limit": 50,
  "offset": 0
}
```

**Implementation notes:**
- Returns rows ordered by `created_at DESC` (most recent first)
- Each row includes up to 20 divergences (capped to manage log volume)
- Request parameters stored as JSONB for filter reconstruction
- See [[docs/adr/016-aggregation-shadow-mode|ADR-016: Aggregation Shadow Mode]] for divergence detection behavior

**Response:** `500 Internal Server Error`

```json
{
  "detail": "Failed to retrieve shadow divergences"
}
```

## Environment Variables

| Variable | Description |
|----------|-------------|
| `APP_VERSION` | Current application version |
| `APP_IMAGE_TAG` | Docker image tag (fallback for version) |
| `ADMIN_AUTH_TOKEN` | Optional Bearer token required for `/api/admin/*` routes when set |

## Security

- Database reset is disabled by default (`admin.enableResetDb` setting)
- Update checks are read-only operations
- Optional admin auth middleware is enforced for `/api/admin/*` when `ADMIN_AUTH_TOKEN` is configured; requests must send `Authorization: Bearer <token>`.
- When `ADMIN_AUTH_TOKEN` is unset, admin behavior remains backward-compatible (no token required).
- Error responses for admin operations are sanitized to generic `Administrative operation failed` to avoid leaking internals.

## See Also

- [[docs/api/index]] - API Index
- [[docs/adr/002-database-schema]] - Database Schema

Code links: [[apps/node-backend/src/routes/admin.js]], [[apps/node-backend/src/services/priceProviderService.js]]

## Test Coverage Notes (2026-04-10)

Recent backend tests validate admin update behavior for:
- `GET /api/admin/update/check`: GitHub releases response parsing, version resolution precedence (`APP_VERSION` then `APP_IMAGE_TAG`), no-release fallback payload, and invalid JSON path returning sanitized `500`.
- `POST /api/admin/update/apply` and `POST /api/admin/update/apply-and-restart`: expected success response contracts.

Code links: [[apps/node-backend/tests/routes/admin.test.js]], [[apps/node-backend/src/routes/admin.js]]
