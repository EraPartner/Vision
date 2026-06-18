---
title: Admin API
type: endpoint
status: active
date: 2026-04-26
updated: 2026-06-18
tags:
  - api
  - admin
  - system
  - updates
  - observability
  - provider-health
  - endpoint-liveness
  - phase-f
  - db-data-editor
  - adr-101
description: API endpoints for system administration, database management (including the DB data editor), provider health, and endpoint liveness
aliases:
  - admin
  - system admin
  - health
  - initialization
related_code:
  - apps/node-backend/src/routes/admin.js
  - apps/node-backend/src/services/dbEditor.js
  - apps/node-backend/src/main.js
  - apps/node-backend/src/config/config.js
  - apps/node-backend/src/services/providerHealth/providerHealthService.js
  - apps/node-backend/src/middleware/requestMetrics.js
  - apps/frontend/src/lib/api/admin.ts
  - apps/frontend/src/pages/admin/TableDataEditorPage.tsx
---

# Admin API

System administration endpoints for database management, health checks, provider health tracking, and endpoint liveness metrics. Includes the [[docs/features/database-maintenance|DB data editor]] (ADR-101) for raw table inspection and editing.

## Base URL

```
/api/admin
```

## Endpoints (17 total)

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
{ "ok": false, "error": { "code": "APP_ERROR", "message": "Failed to retrieve administration status" } }
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
{ "ok": false, "error": { "code": "APP_ERROR", "message": "Administrative operation failed" } }
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
{ "ok": false, "error": { "code": "APP_ERROR", "message": "Database reset endpoint disabled" } }
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
{ "ok": false, "error": { "code": "APP_ERROR", "message": "Failed to sanitize Kinesis history" } }
```

---

### GET /api/admin/database/stats (Phase 7)

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
- These estimates are updated when VACUUM ANALYZE is executed; between runs, the values reflect the last known statistics
- All tables display their current row count estimates regardless of vacuum/analyze history (newly created tables may show zero until their first VACUUM ANALYZE)
- This is expected PostgreSQL behavior; see [[docs/features/database-maintenance|Database Maintenance Feature]] for context

**Response:** `500 Internal Server Error`

```json
{ "ok": false, "error": { "code": "APP_ERROR", "message": "Failed to retrieve database statistics" } }
```

See [[docs/features/database-maintenance|Database Maintenance Feature]] for details.

---

### POST /api/admin/database/vacuum (Phase 7)

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
{ "ok": false, "error": { "code": "APP_ERROR", "message": "VACUUM already running. Please wait." } }
```

**Implementation note:**
- Uses raw database client (not connection pool) because VACUUM cannot run inside a transaction
- See [[docs/features/database-maintenance|Database Maintenance Feature]] for architectural details

---

### GET /api/admin/database/tables/:table/schema (ADR-101)

Retrieve the column schema and primary key for a single table. Used by the data editor to build the column header row and know which columns are part of the primary key.

**Auth:** admin Bearer + CSRF guard (same middleware stack as all `/api/admin` routes).

**Rate limit:** `adminRateLimiter`.

**Path Parameters:**

| Parameter | Description |
|-----------|-------------|
| `table` | Table name (validated against `pg_stat_user_tables`; 400 if unknown) |

**Response:** `200 OK` — envelope `{ ok: true, data: { table, columns, primaryKey } }`

```json
{
  "ok": true,
  "data": {
    "table": "transactions",
    "columns": [
      {
        "name": "id",
        "dataType": "integer",
        "udtName": "int4",
        "nullable": false,
        "hasDefault": true,
        "generated": false,
        "writable": false
      },
      {
        "name": "amount",
        "dataType": "numeric",
        "udtName": "numeric",
        "nullable": false,
        "hasDefault": false,
        "generated": false,
        "writable": true
      }
    ],
    "primaryKey": ["id"]
  }
}
```

**Column fields:**

| Field | Description |
|-------|-------------|
| `name` | Column name |
| `dataType` | PostgreSQL `data_type` from `information_schema.columns` |
| `udtName` | `udt_name` (useful for arrays, domains, enums) |
| `nullable` | True when column allows NULL |
| `hasDefault` | True when column has a DEFAULT expression |
| `generated` | True when column is a generated/computed column |
| `writable` | False for PK columns and generated columns — the UI skips these in edit forms |

**Response:** `400 Bad Request` (unknown or system table)

```json
{ "ok": false, "error": { "code": "APP_ERROR", "message": "Unknown table: pg_secret" } }
```

---

### GET /api/admin/database/tables/:table/rows (ADR-101)

Paginated, filterable, sortable read of table rows. Runs inside a `BEGIN; SET TRANSACTION READ ONLY; SET LOCAL statement_timeout = '10s'` block so it can neither mutate nor hang the database. Each row includes a hidden `__xmin` field (PostgreSQL row version) used by the mutate endpoint for optimistic concurrency.

**Auth:** admin Bearer + CSRF guard. **Rate limit:** `adminRateLimiter`.

**Path Parameters:**

| Parameter | Description |
|-----------|-------------|
| `table` | Table name (validated against `pg_stat_user_tables`) |

**Query Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `limit` | integer | 100 | Rows per page (max 500) |
| `offset` | integer | 0 | Row offset for pagination |
| `orderBy` | string | primary key | Column to sort by (validated against `information_schema.columns`) |
| `dir` | `asc` \| `desc` | `asc` | Sort direction |
| `where` | string | — | Raw WHERE clause appended to the query; `;` is rejected to prevent statement chaining |
| `filters` | JSON string | — | JSON array of `{column, op, value}` filter objects (see ops below) |

**Supported filter `op` values:** `eq`, `ne`, `lt`, `lte`, `gt`, `gte`, `contains` (ILIKE `%value%`), `startsWith` (ILIKE `value%`), `isnull`, `notnull`.

**Response:** `200 OK`

```json
{
  "ok": true,
  "data": {
    "table": "transactions",
    "columns": ["id", "amount", "description", "date", "category_id"],
    "primaryKey": ["id"],
    "rows": [
      { "id": 1, "amount": "-42.50", "description": "Groceries", "date": "2026-06-15", "category_id": 3, "__xmin": "7421836" }
    ],
    "total": 2453,
    "limit": 100,
    "offset": 0
  }
}
```

> [!warning] Raw WHERE clause
> The `where` parameter is appended directly to the SQL (after parameterized filter conditions). Semicolons are rejected, and the query runs inside a READ ONLY transaction, so mutation is structurally impossible. However, a crafted `where` clause can still trigger expensive seq-scans. The `statement_timeout` of 10 s caps the blast radius.

---

### POST /api/admin/database/tables/:table/mutate (ADR-101)

Execute a batch of insert/update/delete operations against a single table. Supports a `dryRun` mode that returns the generated SQL without touching the database. All changes execute in one transaction (all-or-nothing). Tables with no primary key are rejected for writes.

**Auth:** admin Bearer + CSRF guard. **Rate limit:** `adminMutateLimiter` (30 req/min — stricter than reads).

**Path Parameters:**

| Parameter | Description |
|-----------|-------------|
| `table` | Table name (validated against `pg_stat_user_tables`) |

**Request Body:**

```json
{
  "changes": [
    { "op": "insert", "values": { "amount": "-15.00", "description": "Coffee", "date": "2026-06-18" } },
    { "op": "update", "pk": { "id": 42 }, "xmin": "7421836", "set": { "description": "Updated desc" } },
    { "op": "delete", "pk": { "id": 99 }, "xmin": "7310022" }
  ],
  "dryRun": false
}
```

**Change shapes:**

| Field | `insert` | `update` | `delete` |
|-------|----------|----------|----------|
| `op` | `"insert"` | `"update"` | `"delete"` |
| `values` | Required — column/value map | — | — |
| `pk` | — | Required — primary key map | Required — primary key map |
| `xmin` | — | Optional — optimistic-concurrency token from `/rows` response | Optional — optimistic-concurrency token |
| `set` | — | Required — columns to change | — |

**Optimistic concurrency (`xmin`):** When supplied, the row is locked `FOR UPDATE` and its current PostgreSQL `xmin` compared to the client's token. A mismatch (row was modified by another write since the client loaded it) or a missing row returns `409 Conflict`. Omitting `xmin` skips the check (last-write-wins).

**Dry-run response (`dryRun: true`):** `200 OK` — returns generated SQL without executing it.

```json
{
  "ok": true,
  "data": {
    "dryRun": true,
    "count": 2,
    "statements": [
      { "op": "insert", "preview": "INSERT INTO \"transactions\" (\"amount\", \"description\") VALUES ($1, $2)" },
      { "op": "update", "preview": "UPDATE \"transactions\" SET \"description\" = $1 WHERE \"id\" = $2" }
    ]
  }
}
```

**Commit response (`dryRun: false` or omitted):** `200 OK`

```json
{
  "ok": true,
  "data": {
    "dryRun": false,
    "applied": 2,
    "results": [
      { "op": "insert", "ok": true },
      { "op": "update", "ok": true }
    ],
    "refreshScheduled": true
  }
}
```

`refreshScheduled: true` means the committed table (`transactions`, `recipients`, or `categories`) is a materialized-view base table and a debounced `scheduleRefresh()` was triggered, so dashboard views stay fresh.

**Error responses:**

| Status | Scenario |
|--------|----------|
| `400` | Unknown table, missing PK for update/delete, constraint violation (NOT NULL, CHECK, invalid type) |
| `409` | `xmin` mismatch (optimistic concurrency conflict) or UNIQUE constraint violation |
| `500` | Unexpected database error (rolled back) |

Constraint SQLSTATEs (`23502` NOT NULL, `23503` FK violation, `23505` UNIQUE, `23514` CHECK, `22P02` invalid type) are mapped to human-readable messages before the `400`/`409` response is sent.

**Audit trail:** Every committed statement is written to `db_editor_audit` (table `db_editor_audit(id, table_name, op, pk_json, before_json, after_json, statement, created_at)`; index `db_editor_audit_table_time_idx`) inside the same transaction, and also emitted on the structured logger. The audit record is created even if the change targets the `db_editor_audit` table itself. Migration: `alembic/versions/0059_db_editor_audit.py`.

See [[docs/features/database-maintenance|Database Maintenance Feature]] and [[docs/adr/101-db-data-editor|ADR-101]] for full safety model.

---

### GET /api/admin/update/check

Check for application updates via GitHub Releases API.

**Network Timeout (2026-04-26):**
- GitHub fetch timeout: **5000ms** (5 seconds)
- If GitHub is unreachable, endpoint returns a generic "No published releases found" response rather than failing with a network error
- Uses `https.get()` with `timeout` option and `req.on('timeout', ...)` handler that calls `req.destroy()`

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

**Response:** `200 OK` (no releases found or timeout)

```json
{
  "up_to_date": true,
  "error": "No published releases found",
  "latest_version": null
}
```

**Response:** `500 Internal Server Error`

```json
{ "ok": false, "error": { "code": "APP_ERROR", "message": "Administrative operation failed" } }
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

### GET /api/admin/providers/health

List health records for all tracked data providers.

**Response:** `200 OK`

```json
[
  {
    "provider": "binance",
    "kind": "price",
    "label": "Binance",
    "last_success_at": "2026-04-24T10:30:00Z",
    "last_error_at": null,
    "last_error": null,
    "consecutive_failures": 0,
    "updated_at": "2026-04-24T10:30:00Z"
  },
  {
    "provider": "ecb",
    "kind": "fx",
    "label": "ECB",
    "last_success_at": "2026-04-24T09:00:00Z",
    "last_error_at": "2026-04-24T08:45:00Z",
    "last_error": "Fetch timeout after 5000ms",
    "consecutive_failures": 1,
    "updated_at": "2026-04-24T09:00:00Z"
  }
]
```

Providers: `binance`, `yahoo`, `kinesis` (price); `ecb`, `open.er-api` (fx); `statbel`, `eurostat` (inflation).

See [[docs/features/provider-health|Provider Health Tracking]] for full data model.

---

### POST /api/admin/providers/:provider/probe

Trigger an active on-demand health probe for a single provider.

**Path Parameters:**

| Parameter | Description |
|-----------|-------------|
| `provider` | Provider key (e.g. `binance`, `ecb`) |

**Response:** `200 OK`

```json
{
  "ok": true,
  "provider": {
    "provider": "binance",
    "kind": "price",
    "label": "Binance",
    "last_success_at": "2026-04-24T10:30:00Z",
    "last_error_at": null,
    "last_error": null,
    "consecutive_failures": 0,
    "updated_at": "2026-04-24T10:30:00Z"
  }
}
```

**Response:** `200 OK` (probe failed)

```json
{
  "ok": false,
  "provider": {
    "provider": "ecb",
    "kind": "fx",
    "label": "ECB",
    "last_success_at": "2026-04-24T09:00:00Z",
    "last_error_at": "2026-04-24T10:45:00Z",
    "last_error": "Fetch timeout after 5000ms",
    "consecutive_failures": 1,
    "updated_at": "2026-04-24T10:45:00Z"
  },
  "error": "Fetch timeout after 5000ms"
}
```

The probe updates the `provider_health` row (calls `recordSuccess` or `recordError`) and returns the full updated `ProviderHealth` object. Returns `200` regardless of probe outcome — `ok: false` indicates a provider-level failure, not an API error.

**Response:** `400 Bad Request` (unknown provider)

```json
{ "ok": false, "error": { "code": "APP_ERROR", "message": "Unknown provider: unknown-name" } }
```

---

### GET /api/admin/metrics/requests

Retrieve rolling request metrics per route from the in-memory window (last 15 minutes, 1-minute buckets).

**Response:** `200 OK`

```json
[
  {
    "route": "GET:/api/transactions",
    "method": "GET",
    "path": "/api/transactions",
    "count": 142,
    "errors": 3,
    "error_rate": 0.021,
    "p50_ms": 18,
    "p95_ms": 67,
    "window_minutes": 15
  }
]
```

**Notes:**
- Metrics are in-memory only and reset on backend restart
- Routes with zero traffic in the window are omitted
- `error_rate` is `errors / count` (0–1)
- Latency percentiles are computed from the rolling bucket window

---

### GET /api/admin/endpoints

Return a static manifest of all registered Express routes.

**Response:** `200 OK`

```json
[
  { "method": "GET", "path": "/api/transactions" },
  { "method": "POST", "path": "/api/transactions" },
  { "method": "PATCH", "path": "/api/transactions/:id" }
]
```

**Notes:**
- Generated by scanning the Express router stack at startup via `routeManifest.js`
- Reflects all routes registered at boot time; does not update dynamically
- Used by the frontend to display the full route matrix, joined with live metrics from `/api/admin/metrics/requests`

---

### GET /api/admin/endpoint-liveness

Return the static route manifest annotated with a `live: true` flag for each entry, confirming that all registered endpoints are reachable.

**Response:** `200 OK`

```json
[
  { "method": "GET", "path": "/api/transactions", "live": true },
  { "method": "POST", "path": "/api/transactions", "live": true },
  { "method": "PATCH", "path": "/api/transactions/:id", "live": true }
]
```

**Notes:**
- Identical source data as `GET /api/admin/endpoints` (same `getRouteManifest()` call), with each entry extended by `live: true`
- Intended for health/monitoring tooling that needs a single endpoint confirming the route manifest is served and all entries are live

---

## Environment Variables

| Variable | Description |
|----------|-------------|
| `APP_VERSION` | Current application version |
| `APP_IMAGE_TAG` | Docker image tag (fallback for version) |
| `ADMIN_AUTH_TOKEN` | Optional Bearer token required for `/api/admin/*` routes when set |

## Security and Rate Limiting

- Database reset is disabled by default (`admin.enableResetDb` setting)
- Update checks are read-only operations
- Admin auth follows the **token-or-open + CSRF guard** model per [[docs/adr/063-admin-auth-csrf-guard|ADR-063]] (supersedes the RFC 1918 IP allowlist of ADR-037):
  - **When `ADMIN_AUTH_TOKEN` is configured:** Requests must include `Authorization: Bearer <token>` (timing-safe compare); otherwise `401 Unauthorized`.
  - **When `ADMIN_AUTH_TOKEN` is unset:** Admin routes are open at the auth layer — protection is the loopback-only host port binding plus the CSRF guard.
  - **CSRF guard (all `/api/admin` state-changing requests):** cross-site requests are rejected via `Sec-Fetch-Site` (allow `same-origin`/`none`, reject `cross-site`/`same-site`) with an `Origin`-allowlist fallback for older/non-browser clients. This blocks a malicious page from POSTing to destructive routes (e.g. `database/reset`) — which the loopback binding alone cannot stop.
- Error responses for admin operations are sanitized to generic `Administrative operation failed` to avoid leaking internals.

### Docker Deployment — LAN Isolation and Admin Access

The `docker-compose.yml` binds the host port to `127.0.0.1` only:

```yaml
ports:
  - "127.0.0.1:${PORT:-3002}:3002"
```

This means only the host machine can reach the backend — devices on the same Wi-Fi or LAN cannot. Because admin auth no longer relies on an IP allowlist, the docker-proxy bridge source IP (e.g. `172.17.0.1`) is irrelevant: with no token set, admin routes are reachable from any client that can hit the loopback-bound port, and the CSRF guard blocks cross-site browser requests.

> **Warning:** If you change the port mapping back to `"${PORT:-3002}:3002"` (binding `0.0.0.0`), the loopback isolation is gone — **set `ADMIN_AUTH_TOKEN`** so admin routes require a Bearer token, and consider adding auth/CSRF protection to non-admin routes too.

### Rate Limits

Admin endpoints are subject to specialized rate limiting:

| Endpoint Type | Rate Limit | Limiter | Reason |
|---------------|-----------|---------|--------|
| **GET** (observability reads) | 500/min | `adminRateLimiter` | Admin hub makes 5-6 parallel reads on load |
| **POST** (destructive mutations) | 30/min | `adminMutateLimiter` | Database reset, VACUUM, provider probes, Kinesis sanitization |

See [[docs/security/rate-limiting|Rate Limiting]] for full details and response headers.

## See Also

- [[docs/api/index]] - API Index
- [[docs/adr/002-database-schema]] - Database Schema

Code links: [[apps/node-backend/src/routes/admin.js]], [[apps/node-backend/src/services/priceProviderService.js]]

## Test Coverage Notes (2026-04-10)

Recent backend tests validate admin update behavior for:
- `GET /api/admin/update/check`: GitHub releases response parsing, version resolution precedence (`APP_VERSION` then `APP_IMAGE_TAG`), no-release fallback payload, and invalid JSON path returning sanitized `500`.
- `POST /api/admin/update/apply` and `POST /api/admin/update/apply-and-restart`: expected success response contracts.

Code links: [[apps/node-backend/tests/routes/admin.test.js]], [[apps/node-backend/src/routes/admin.js]]
