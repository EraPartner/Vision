---
title: Admin API
type: endpoint
status: active
date: 2026-04-09
tags: [api, admin, system, updates]
description: API endpoints for system administration, database management, and application updates
aliases: [admin, system admin, health, initialization]
related_code: ["apps/node-backend/src/routes/admin.js"]
---

# Admin API

System administration endpoints for database management, health checks, and application updates.

## Base URL

```
/api/admin
```

## Endpoints

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
  "detail": "Cannot connect to database"
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
  "detail": "Update check failed: Connection timeout"
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

## Environment Variables

| Variable | Description |
|----------|-------------|
| `APP_VERSION` | Current application version |
| `APP_IMAGE_TAG` | Docker image tag (fallback for version) |

## Security

- Database reset is disabled by default (`admin.enableResetDb` setting)
- Update checks are read-only operations
- Endpoint requires no authentication (internal use)

## See Also

- [[docs/api/index]] - API Index
- [[docs/adr/002-database-schema]] - Database Schema

Code links: [[apps/node-backend/src/routes/admin.js]], [[apps/node-backend/src/services/priceProviderService.js]]
