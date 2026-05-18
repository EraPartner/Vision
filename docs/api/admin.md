---
title: Admin API
type: endpoint
status: active
date: 2026-04-26
updated: 2026-04-24
tags:
  - api
  - admin
  - system
  - updates
  - observability
  - provider-health
  - endpoint-liveness
  - phase-f
description: API endpoints for system administration, database management, provider health, and endpoint liveness
aliases:
  - admin
  - system admin
  - health
  - initialization
related_code:
  - apps/node-backend/src/routes/admin.js
  - apps/node-backend/src/main.js
  - apps/node-backend/src/config/config.js
  - apps/node-backend/src/services/providerHealth/providerHealthService.js
  - apps/node-backend/src/middleware/requestMetrics.js
  - apps/frontend/src/lib/api/admin.ts
---

# Admin API

System administration endpoints for database management, health checks, provider health tracking, and endpoint liveness metrics.

## Base URL

```
/api/admin
```

## Endpoints (13 total)

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
- These estimates are updated when VACUUM ANALYZE is executed; between runs, the values reflect the last known statistics
- All tables display their current row count estimates regardless of vacuum/analyze history (newly created tables may show zero until their first VACUUM ANALYZE)
- This is expected PostgreSQL behavior; see [[docs/features/database-maintenance|Database Maintenance Feature]] for context

**Response:** `500 Internal Server Error`

```json
{ "ok": false, "error": { "code": "APP_ERROR", "message": "Failed to retrieve database statistics" } }
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
{ "ok": false, "error": { "code": "APP_ERROR", "message": "VACUUM already running. Please wait." } }
```

**Implementation note:**
- Uses raw database client (not connection pool) because VACUUM cannot run inside a transaction
- See [[docs/features/database-maintenance|Database Maintenance Feature]] for architectural details

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
{ "ok": false, "error": { "code": "APP_ERROR", "message": "Failed to retrieve shadow divergences" } }
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

## Environment Variables

| Variable | Description |
|----------|-------------|
| `APP_VERSION` | Current application version |
| `APP_IMAGE_TAG` | Docker image tag (fallback for version) |
| `ADMIN_AUTH_TOKEN` | Optional Bearer token required for `/api/admin/*` routes when set |

## Security and Rate Limiting

- Database reset is disabled by default (`admin.enableResetDb` setting)
- Update checks are read-only operations
- Admin auth middleware enforces per [[docs/adr/037-admin-auth-localhost-fallback|ADR-036]]:
  - **When `ADMIN_AUTH_TOKEN` is configured:** Requests must include `Authorization: Bearer <token>`
  - **When `ADMIN_AUTH_TOKEN` is unset:** Requests must originate from a local network address — loopback (`127.0.0.1`, `::1`, `::ffff:127.0.0.1`) or RFC 1918 private ranges (`10.x.x.x`, `172.16–31.x.x`, `192.168.x.x`) including IPv4-mapped and IPv6 ULA (`fc00::/7`). All other origins receive `401 Unauthorized`.
- Error responses for admin operations are sanitized to generic `Administrative operation failed` to avoid leaking internals.

### Docker Deployment — LAN Isolation and Admin Access

The `docker-compose.yml` binds the host port to `127.0.0.1` only:

```yaml
ports:
  - "127.0.0.1:${PORT:-3002}:3002"
```

This means only the host machine can reach the backend — devices on the same Wi-Fi or LAN cannot. Inside the container, the host browser's request arrives via docker-proxy with a Docker bridge source IP (e.g. `172.17.0.1`). The admin middleware trusts RFC 1918 ranges, so admin endpoints work without a token.

> **Warning:** If you change the port mapping back to `"${PORT:-3002}:3002"` (binding `0.0.0.0`), LAN devices will also pass the private-IP check because their source IPs fall in RFC 1918 ranges. Set `ADMIN_AUTH_TOKEN` and consider adding auth to non-admin routes in that case.

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
