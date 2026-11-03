---
title: Admin API
type: endpoint
status: active
date: 2026-11-03
updated: 2026-11-03
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
  - apps/node-backend/src/routes/admin.ts
  - apps/node-backend/src/services/dbEditor.ts
  - apps/node-backend/src/main.ts
  - apps/node-backend/src/config/config.ts
  - apps/node-backend/src/services/providerHealthService.ts
  - apps/node-backend/src/middleware/requestMetrics.ts
  - apps/frontend/src/lib/api/admin.ts
  - apps/frontend/src/pages/admin/TableDataEditorPage.tsx
---

# Admin API

System administration endpoints for database management, health checks, provider health tracking, and endpoint liveness metrics. Includes the [[docs/features/database-maintenance|DB data editor]] (ADR-101) for raw table inspection and editing.

## Base URL

```
/api/admin
```

## Endpoints (22 total)

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
  "ok": false,
  "error": {
    "code": "APP_ERROR",
    "message": "Failed to retrieve administration status"
  }
}
```

Implementation note:

- Internal route refactor extracted `formatAdminStatusPayload(isConnected, tableCount)` to centralize status payload construction while preserving response shape and status codes ([[apps/node-backend/src/routes/admin.ts]]).

---

### POST /api/admin/database/init

Verify database connection and initialization status.

**Response:** `201 Created`

```json
{
  "message": "Database connection verified successfully",
  "details": {
    "note": "Tables are managed by database migrations (db/migrations)"
  },
  "links": []
}
```

**Response:** `500 Internal Server Error`

```json
{
  "ok": false,
  "error": { "code": "APP_ERROR", "message": "Administrative operation failed" }
}
```

---

### POST /api/admin/database/reset

Reset the database (requires explicit confirmation).

**Request Body:**

```json
{ "force": true }
```

The required confirmation is the exact JSON boolean body `{ "force": true }`. Query-string and
string-valued confirmations are rejected. A non-boolean `force` fails body validation with
`400 VALIDATION_ERROR`; `force: false` or a missing `force` returns the confirmation error below.

**Response:** `200 OK`

```json
{
  "message": "Database reset is not performed through the API",
  "details": {
    "warning": "Restore a backup or rebuild the database with the migration runner instead"
  },
  "links": []
}
```

**Response:** `404 Not Found`

```json
{
  "ok": false,
  "error": {
    "code": "NOT_FOUND",
    "message": "Database reset endpoint disabled"
  }
}
```

**Response:** `400 Bad Request`

```json
{
  "ok": false,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Database reset requires force=true in the request body",
    "details": {
      "hint": "Set force=true in the JSON request body to confirm reset (DESTRUCTIVE)"
    }
  }
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
  "ok": false,
  "error": {
    "code": "APP_ERROR",
    "message": "Failed to sanitize Kinesis history"
  }
}
```

---

### GET /api/admin/database/stats (Phase 7)

Retrieve statistics for every user table of the SQLite database, largest table first (schema
`DbStats` in `openapi.yaml`). The table list is read from `pragma_table_list` on each request;
`sqlite_*` tables and the internal `vision_sequences` table are left out
([[docs/adr/263-sqlite-replaces-postgresql|ADR-263]]).

**Response:** `200 OK`

```json
{
  "tables": [
    {
      "table_name": "transactions",
      "live_rows": "2453",
      "last_vacuum": "2026-11-03T10:15:32.123Z",
      "last_analyze": "2026-11-03T10:15:32.123Z",
      "size": "3200 kB",
      "size_bytes": "3276800"
    }
  ],
  "db_size": "12 MB"
}
```

- `live_rows` and `size_bytes` are BIGINT values, so they arrive as decimal strings.
- `live_rows` is an exact `count(*)` of the table.
- `last_vacuum` and `last_analyze` are ISO timestamps of the last run of
  `POST /api/admin/database/vacuum` in this backend process, and `null` until one runs. SQLite does
  not record maintenance runs, so a restart resets them. `last_vacuum` is the same for every table,
  because `VACUUM` rebuilds the whole file.
- `size_bytes` is the bytes of the table's pages plus its indexes' pages, from the `dbstat` virtual
  table. A SQLite build without `dbstat` reports `size` as `"—"` and `size_bytes` as `"0"`, and the
  tables are then ordered by row count.
- `size` and `db_size` are human-readable sizes in 1024-byte units (`bytes`, `kB`, `MB`, ...).
  `db_size` is the database file plus its write-ahead log.
- Contract change (October 2026, non-breaking): `openapi.yaml` now types the responses of `GET /api/admin/database/stats` (`DbStats`), `GET /api/admin/providers/health` (`ProviderHealthList`), `POST /api/admin/providers/{provider}/probe` (`ProbeResult`), `GET /api/admin/metrics/requests` (`RouteMetricList`) and `GET /api/admin/endpoints` (`EndpointList`) with the shapes the routes already returned and `packages/types/src/contracts/admin.ts` already checked. This page previously described a `table` query parameter and a different stats body that the route never had.

**Note on Row Counts:** `live_rows` is counted on each request, so it is exact without a prior
`ANALYZE`. Before ADR-263 it was an estimate from PostgreSQL's `pg_stat_user_tables`.

**Response:** `500 Internal Server Error`

```json
{
  "ok": false,
  "error": {
    "code": "APP_ERROR",
    "message": "Failed to retrieve database statistics"
  }
}
```

See [[docs/features/database-maintenance|Database Maintenance Feature]] for details.

---

### POST /api/admin/database/vacuum (Phase 7)

Run `VACUUM`, then `ANALYZE` on one table or on all tables, then `PRAGMA optimize`.

**Request Body (JSON, optional):**

| Field   | Type           | Required | Description                                                |
| ------- | -------------- | -------- | ---------------------------------------------------------- |
| `table` | string \| null | No       | Table to vacuum; omit or send `null` to vacuum every table |

`table` must be a non-empty string naming a user table from `pragma_table_list`. A non-string or
empty `table` returns `400 VALIDATION_ERROR`; an unknown name, a `sqlite_*` table or a name in the
wrong case returns `400` with `Unknown table: <name>`. SQLite's `VACUUM` always rebuilds the whole
database file, so `table` selects only which table `ANALYZE` refreshes.

**Response:** `200 OK`

```json
{ "ok": true, "data": { "vacuumed": "transactions" } }
```

`vacuumed` is `"all"` when no table was given. The `403` for a missing `MAINTAIN` privilege is
gone: the backend opens the database file itself and has no database roles
([[docs/adr/263-sqlite-replaces-postgresql|ADR-263]] supersedes the role split of
[[docs/adr/262-app-role-maintain-for-admin-vacuum|ADR-262]]). A failed `VACUUM` returns `500`.

**Implementation note:**

- `VACUUM` cannot run inside a transaction, so the route takes the single writer connection
  exclusively (`withExclusiveWriter`). It waits for running write transactions, and other writers
  wait for it. A second request waits for the first instead of failing.
- See [[docs/features/database-maintenance|Database Maintenance Feature]] for architectural details

---

The generic data editor has no protected-table list: since [[docs/adr/231-remove-audit-history|ADR-231]] removed the audit tables, every public user table goes through the same catalog validation, primary-key, and optimistic-concurrency rules below.

### GET /api/admin/database/tables/:table/schema (ADR-101)

Retrieve the column schema and primary key for a single table. Used by the data editor to build the column header row and know which columns are part of the primary key.

**Auth:** admin Bearer + CSRF guard (same middleware stack as all `/api/admin` routes).

**Rate limit:** `adminRateLimiter`.

**Path Parameters:**

| Parameter | Description                                                          |
| --------- | -------------------------------------------------------------------- |
| `table`   | Table name (validated against `pragma_table_list`; 400 if unknown)   |

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

| Field        | Description                                                                   |
| ------------ | ----------------------------------------------------------------------------- |
| `name`       | Column name                                                                   |
| `dataType`   | PostgreSQL type name of the declared storage type (`numeric` for `DECIMAL_TEXT(p,s)`) |
| `udtName`    | PostgreSQL `udt_name` of that type (`_text` for `TEXT_ARRAY`)                         |
| `nullable`   | True when column allows NULL                                                  |
| `hasDefault` | True when column has a DEFAULT expression                                     |
| `generated`  | True when column is a generated/computed column                               |
| `writable`   | False for PK columns and generated columns — the UI skips these in edit forms |

**Response:** `400 Bad Request` (unknown or system table)

```json
{
  "ok": false,
  "error": { "code": "APP_ERROR", "message": "Unknown table: pg_secret" }
}
```

---

### GET /api/admin/database/tables/:table/rows (ADR-101)

Paginated, filterable, sortable read of table rows. Runs in one read snapshot on the read-only
connection (`PRAGMA query_only`), so it cannot mutate the database. SQLite has no statement
timeout, so a read is not cut off after a fixed time. Each row includes a hidden `__xmin` field
used by the mutate endpoint for optimistic concurrency: a 32-character hex digest of the row's
stored values (`quote()` of every column). It is not a PostgreSQL transaction id.

**Auth:** admin Bearer + CSRF guard. **Rate limit:** `adminRateLimiter`.

**Path Parameters:**

| Parameter | Description                                          |
| --------- | ---------------------------------------------------- |
| `table`   | Table name (validated against `pragma_table_list`)   |

**Query Parameters:**

| Parameter | Type            | Default     | Description                                                                                      |
| --------- | --------------- | ----------- | ------------------------------------------------------------------------------------------------ |
| `limit`   | integer         | 100         | Rows per page (max 500)                                                                          |
| `cursor`  | string          | —           | Opaque continuation cursor from the preceding page; bound to the table, sort, direction, filters |
| `orderBy` | string          | primary key | Column to sort by (validated against `pragma_table_xinfo`)                                       |
| `dir`     | `asc` \| `desc` | `asc`       | Sort direction                                                                                   |
| `filters` | JSON string     | —           | JSON array of `{column, op, value}` filter objects (see ops below)                               |

**Supported filter `op` values:** `eq`, `ne`, `lt`, `lte`, `gt`, `gte`, `contains` (ILIKE `%value%`), `startsWith` (ILIKE `value%`), `isnull`, `notnull`.

Filters and sorting follow the declared storage type. `DECIMAL_TEXT` columns compare and sort by
exact decimal value (`dec_*` functions), never as text or floats. Text sorts bytewise (SQLite's
`BINARY` collation), and `jsonb` compares its canonical text. `contains` and `startsWith` match
the stored text: canonical `YYYY-MM-DDTHH:MM:SS.ffffffZ` for timestamps, `true`/`false` for
booleans and JSON text for arrays. A table without a primary key pages by `rowid`.

**Response:** `200 OK`

```json
{
  "ok": true,
  "data": {
    "table": "transactions",
    "columns": ["id", "amount", "description", "date", "category_id"],
    "primaryKey": ["id"],
    "rows": [
      {
        "id": 1,
        "amount": "-42.50",
        "description": "Groceries",
        "date": "2026-06-15",
        "category_id": 3,
        "__xmin": "3f1c9a0e5b7d2c4486a1f0e9d3b2c7a5"
      }
    ],
    "limit": 100,
    "hasMore": true,
    "nextCursor": "eyJ2IjoxLCJ0YWJsZSI6InRyYW5zYWN0aW9ucyJ9"
  }
}
```

The service fetches `limit + 1` rows to derive `hasMore`. It does not run `COUNT(*)`, so large tables do not pay an unbounded count scan on every page. Hidden text projections of the stored values preserve exact cursor boundaries, including timestamp microseconds; those fields are removed before the response. `total` is present only when a short first page proves the exact total. The UI keeps prior cursors locally to support Previous. Changing the sort or filters starts again at page one.

`DATE` cells (and `DATE[]` elements) are calendar-day strings (`YYYY-MM-DD`) in `/rows` and in the `after` rows of `/mutate`, whatever the backend time zone, so saving an unchanged date keeps the same day.

The raw `where` parameter was removed. Use only the structured, parameterized `filters` array. A malformed cursor or one reused with different sort or filter state returns `400 Bad Request`.

- Contract change (October 2026, non-breaking): `openapi.yaml` now types the responses of
  `POST /api/admin/database/vacuum` (`DbVacuumResult`),
  `GET /api/admin/database/tables/{table}/schema` (`DbEditorTableSchema`),
  `GET /api/admin/database/tables/{table}/rows` (`DbEditorRows`) and
  `POST /api/admin/database/tables/{table}/mutate` (`DbEditorMutationResult`) with the shapes the
  routes already returned. `columns` in the rows response carries the same column objects as the
  schema response; the example above abbreviates them as names.

`filters` must be valid JSON for an array of objects. Each object needs a string `column`; `op`, if
present, must be a string. Invalid JSON, a non-array, or an entry such as `null` returns
`400 VALIDATION_ERROR` with an `Invalid filters parameter:` message. Any query parameter sent more
than once returns `400`.

---

### POST /api/admin/database/tables/:table/mutate (ADR-101)

Execute a batch of insert/update/delete operations against a single table. Supports a `dryRun` mode that returns the generated SQL without touching the database. All changes execute in one transaction (all-or-nothing). Tables with no primary key are rejected for writes.

**Auth:** admin Bearer + CSRF guard. **Rate limit:** `adminMutateLimiter` (30 req/min — stricter than reads).

**Path Parameters:**

| Parameter | Description                                          |
| --------- | ---------------------------------------------------- |
| `table`   | Table name (validated against `pragma_table_list`)   |

**Request Body:**

```json
{
  "changes": [
    {
      "op": "insert",
      "values": {
        "amount": "-15.00",
        "description": "Coffee",
        "date": "2026-06-18"
      }
    },
    {
      "op": "update",
      "pk": { "id": 42 },
      "xmin": "3f1c9a0e5b7d2c4486a1f0e9d3b2c7a5",
      "set": { "description": "Updated desc" }
    },
    { "op": "delete", "pk": { "id": 99 }, "xmin": "9b04e6d1c2a83f57e0d4b6a1c9f2e7d3" }
  ],
  "dryRun": false
}
```

**Change shapes:**

| Field    | `insert`                    | `update`                                                      | `delete`                                |
| -------- | --------------------------- | ------------------------------------------------------------- | --------------------------------------- |
| `op`     | `"insert"`                  | `"update"`                                                    | `"delete"`                              |
| `values` | Required — column/value map | —                                                             | —                                       |
| `pk`     | —                           | Required — primary key map                                    | Required — primary key map              |
| `xmin`   | —                           | Optional — optimistic-concurrency token from `/rows` response | Optional — optimistic-concurrency token |
| `set`    | —                           | Required — columns to change                                  | —                                       |

**Optimistic concurrency (`xmin`):** The batch runs in one `BEGIN IMMEDIATE` transaction on the
single writer, so no other write runs between the version read and the write. When `xmin` is
supplied, the row's current version digest is compared to the client's token. A mismatch (the
row's stored values changed since the client loaded it) or a missing row returns
`409 Conflict`. A write that stores the same values again keeps the digest, so it is not a
conflict. Omitting `xmin` skips the check (last-write-wins).

Values are written through the storage function of the column's declared type
(`vision_numeric(?, p, s)`, `vision_jsonb`, `vision_ts`, `ts_date`), so decimals are rounded half
away from zero to the column's scale and stored as canonical text. Text input is read as
PostgreSQL's input functions read it (`true`/`yes`/`on`/`1` for booleans, integers range-checked
for `int4`/`int8`). Arrays take a JSON array, not a PostgreSQL array literal. Generated columns and
the derived `mv_*` tables are read-only (`400`).

**Dry-run response (`dryRun: true`):** `200 OK` — returns generated SQL without executing it. The
preview inlines the bound values as literals, each inside its column's storage function.

```json
{
  "ok": true,
  "data": {
    "dryRun": true,
    "count": 2,
    "statements": [
      {
        "op": "insert",
        "preview": "INSERT INTO \"transactions\" (\"amount\", \"description\") VALUES (vision_numeric('-15.00', 18, 4), 'Coffee') RETURNING *"
      },
      {
        "op": "update",
        "preview": "UPDATE \"transactions\" SET \"description\" = 'Updated desc' WHERE \"id\" = 42 RETURNING *"
      }
    ]
  }
}
```

`dryRun` must be a JSON boolean. Any other type, including the string `"true"`, returns
`400 VALIDATION_ERROR`, so a mistyped preview can never commit. `changes` must be an array of
objects whose `op` is `insert`, `update`, or `delete`; `values`, `set`, and `pk` must be objects;
`xmin` may be a string or a number.

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

| Status | Scenario                                                                                                                                     |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `400`  | Malformed body (`changes`/`dryRun` shape), unknown table, missing PK for update/delete, constraint violation (NOT NULL, CHECK, invalid type) |
| `403`  | Insufficient database privileges for the operation (SQLSTATE `42501`)                                                                        |
| `409`  | `xmin` mismatch (optimistic concurrency conflict) or UNIQUE constraint violation                                                             |
| `503`  | The wait for the database write lock timed out (SQLSTATE `55P03`); retry the request                                                         |
| `500`  | Unexpected database error (rolled back)                                                                                                      |

Constraint SQLSTATEs (`23502` NOT NULL, `23503` FK violation, `23001` RESTRICT foreign key, `23505` UNIQUE, `23514` CHECK, `22P02` invalid type) are mapped to human-readable messages before the `400`/`409` response is sent.

**Change log:** After commit, each applied change is emitted on the structured logger as `db-editor mutation committed` with the table, operation, and primary key. No database table records editor changes; migration `0004_remove_audit_history` dropped `db_editor_audit` ([[docs/adr/231-remove-audit-history|ADR-231]]).

See [[docs/features/database-maintenance|Database Maintenance Feature]] and [[docs/adr/101-db-data-editor|ADR-101]] for full safety model.

---

### GET /api/admin/update/check

Check for application updates via GitHub Releases API.

**Network Timeout (2026-04-26):**

- GitHub fetch timeout: **5000ms** (5 seconds)
- A transport timeout or invalid response fails through the normal API error envelope; a valid GitHub `Not Found` payload returns the successful no-release shape below.
- Uses `https.get()` with `timeout` option and `req.on('timeout', ...)` handler that calls `req.destroy()`

**Response:** `200 OK`

```json
{
  "up_to_date": true,
  "current_version": "1.2.3",
  "latest_version": "v1.2.3",
  "published_at": "2025-03-15T12:00:00Z",
  "release_notes": "Bug fixes and improvements...",
  "html_url": "https://github.com/EraPartner/Vision/releases/tag/v1.2.3",
  "update_mode": "source"
}
```

**Response:** `200 OK` (no release exists)

```json
{
  "up_to_date": true,
  "current_version": "1.2.3",
  "error": "No published releases found",
  "latest_version": null,
  "update_mode": "source"
}
```

**Response:** `500 Internal Server Error`

```json
{
  "ok": false,
  "error": { "code": "APP_ERROR", "message": "Administrative operation failed" }
}
```

Implementation notes:

- Internal route refactor centralized release/version/update payload logic into `hasValidReleaseTag(release)`, `detectCurrentAppVersion()`, and `buildUpdateCheckPayload(release, currentVersion)`.
- Every successful response uses the same core contract: `up_to_date`, `current_version`, `latest_version`, and `update_mode`. The no-release fallback therefore remains safe for the same frontend type as a normal release response.
- `update_mode` is `source` | `native`. This HTTP route always answers `source` (browser deployments update from their host); inside Electron the renderer asks the updater bridge instead, which answers `native` for the packaged app and `source` for a development run. `source_launcher_available` and the `dev` value were removed by [[docs/adr/218-retire-source-launcher-update-channel|ADR-218]].
- The up-to-date comparison remains `latest === current` or `latest === v${current}` ([[apps/node-backend/src/routes/admin.ts]]).

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
  "note": "Updates are managed by the Vision desktop app for the active runtime provider. No manual action is required."
}
```

---

### GET /api/admin/providers/health

List health records for all tracked data providers.

**Response:** `200 OK` — canonical collection body `{ items, total }`. The list
is unpaginated, so `total` is the row count.

```json
{
  "items": [
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
  ],
  "total": 2
}
```

Providers: `binance`, `yahoo`, `kinesis` (price); `ecb`, `open.er-api` (fx); `statbel`, `eurostat` (inflation).

See [[docs/features/provider-health|Provider Health Tracking]] for full data model.

---

### POST /api/admin/providers/:provider/probe

Trigger an active on-demand health probe for a single provider.

**Path Parameters:**

| Parameter  | Description                          |
| ---------- | ------------------------------------ |
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
{
  "ok": false,
  "error": { "code": "APP_ERROR", "message": "Unknown provider: unknown-name" }
}
```

---

### GET /api/admin/metrics/requests

Retrieve rolling request metrics per route from the in-memory window (last 15 minutes, 1-minute buckets). Canonical collection body `{ items, total }` (unpaginated — `total` is the row count).

**Response:** `200 OK`

```json
{
  "items": [
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
  ],
  "total": 1
}
```

**Notes:**

- Metrics are in-memory only and reset on backend restart
- `path` is the full mounted route pattern (for example `/api/admin/database/tables/:table/mutate`),
  for failed requests too, so it lines up with `GET /api/admin/endpoints`
- Routes with zero traffic in the window are omitted
- `error_rate` is `errors / count` (0–1)
- Latency percentiles are computed from the rolling bucket window

---

### GET /api/admin/endpoints

Return a static manifest of all registered Express routes.

**Response:** `200 OK` — canonical collection body `{ items, total }`.

```json
{
  "items": [
    { "method": "GET", "path": "/api/transactions" },
    { "method": "POST", "path": "/api/transactions" },
    { "method": "PATCH", "path": "/api/transactions/:id" }
  ],
  "total": 3
}
```

**Notes:**

- Generated by scanning the Express router stack at startup via `routeManifest.ts`
- Reflects all routes registered at boot time; does not update dynamically
- Used by the frontend to display the full route matrix, joined with live metrics from `/api/admin/metrics/requests`

---

## Environment Variables

| Variable      | Description                 |
| ------------- | --------------------------- |
| `APP_VERSION` | Current application version |

## Security and Rate Limiting

- Database reset is disabled by default (`admin.enableResetDb` setting)
- Update checks are read-only operations
- Admin routes have no authentication layer ([[docs/adr/233-loopback-only-backend|ADR-233]], superseding the `ADMIN_AUTH_TOKEN` bearer check of [[docs/adr/063-admin-auth-csrf-guard|ADR-063]]). Protection is the loopback-only bind, the Host guard and the CSRF guard:
  - **Bind and Host:** the backend refuses to start on a non-loopback address, and every request must name `localhost`, `127.0.0.1` or `::1` with the backend port in `Host` (403 otherwise).
  - **CSRF guard (all `/api` requests, every method; [[docs/adr/237-cross-site-guard-for-every-method|ADR-237]]):** cross-site requests are rejected via `Sec-Fetch-Site` (allow `same-origin`/`none`, reject `cross-site`/`same-site`) with a fallback to the backend's own loopback origins for older/non-browser clients. This blocks a malicious page from POSTing to destructive routes (e.g. `database/reset`) — which the loopback binding alone cannot stop.
  - No admin route returns `401`; that status no longer exists on `/api/admin/*`.
- Error responses for admin operations are sanitized to generic `Administrative operation failed` to avoid leaking internals.

### Network boundary and admin access

Native Electron and source runs bind the backend to loopback; there is no reverse-proxy or LAN
mode. The CSRF guard remains required because network binding is not a browser-origin control.

### Rate Limits

Admin endpoints are subject to specialized rate limiting:

| Endpoint Type                    | Rate Limit | Limiter              | Reason                                                        |
| -------------------------------- | ---------- | -------------------- | ------------------------------------------------------------- |
| **GET** (observability reads)    | 500/min    | `adminRateLimiter`   | Admin hub makes 5-6 parallel reads on load                    |
| **POST** (destructive mutations) | 30/min     | `adminMutateLimiter` | Database reset, VACUUM, provider probes, Kinesis sanitization |

See [[docs/security/rate-limiting|Rate Limiting]] for full details and response headers.

## See Also

- [[docs/api/index]] - API Index
- [[docs/adr/002-database-schema]] - Database Schema

Code links: [[apps/node-backend/src/routes/admin.ts]], [[apps/node-backend/src/services/priceProviderService.ts]]

## Test Coverage Notes (2026-04-10)

Recent backend tests validate admin update behavior for:

- `GET /api/admin/update/check`: GitHub releases response parsing, version resolution precedence (`APP_VERSION` then `APP_IMAGE_TAG`), no-release fallback payload, and invalid JSON path returning sanitized `500`.
- `POST /api/admin/update/apply` and `POST /api/admin/update/apply-and-restart`: expected success response contracts.

Code links: [[apps/node-backend/tests/routes/admin.test.ts]], [[apps/node-backend/src/routes/admin.ts]]
