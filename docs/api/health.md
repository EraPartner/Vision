---
title: Health API
type: api
status: active
date: 2026-04-19
updated: 2026-08-02
tags: [api, health, monitoring, backend, readiness, warmup, electron, liveness, startup]
description: Health check endpoints for backend readiness and cache warmup status. GET /health is a shallow liveness probe; GET /health/detailed is the warmup readiness gate used by the Electron shell for initial navigation.
aliases: [health endpoints, readiness check, backend health]
---

# Health API

## Overview

The Health API provides two endpoints that serve distinct roles:

- **`GET /health`** — Shallow **liveness** probe. Returns 200 as soon as Express is listening, before any warmup tasks have run. Used by the Electron runtime watchdog and by restart/update/dev-rebuild flows.
- **`GET /health/detailed`** — **Warmup readiness** probe. Returns `status: warming | ready` and per-cache boolean flags. Used by the Electron shell to gate the **first** page navigation (`pollReady()`), preventing a blank dashboard on cold start.

> [!info] Why two probes?
> `GET /health` can return 200 before the materialized views are built/refreshed and the other backend warmup tasks finish. The Electron shell previously navigated on this shallow check, causing cold-start blank dashboards. It now navigates only when `/health/detailed` reports `status === 'ready'` OR `caches.materializedViews === true`. The watchdog intentionally keeps polling the lighter `/health` — "is the backend process alive?" is the right question there, not "are all caches warm?".

Both endpoints return quickly (no I/O on the hot path) and are safe for high-frequency polling.

## GET /health

Simple health check; returns HTTP 200 if backend is ready to serve requests.

### Request

```http
GET /health
```

### Response

**Status:** `200 OK`

**Body:**
```json
{
  "status": "ok"
}
```

### Usage

- **Electron runtime watchdog** — polls every 10s; 3 consecutive failures trigger `backend:lost` IPC event
- **Electron restart/update/dev-rebuild flows** — uses `pollHealth` (shallow liveness) because these flows only need to know when Express is back up
- **Load balancer / reverse proxy readiness checks**
- **Kubernetes liveness probes**

> [!note]
> The Electron shell does **not** use `GET /health` for initial navigation. It uses `GET /health/detailed` via `pollReady()` to wait for materialized-view warmup. See below.

## GET /health/detailed

Detailed health check including cache warmup status.

### Request

```http
GET /health/detailed
```

### Response

**Status:** `200 OK`

**Body:**
```json
{
  "status": "ready",
  "service": "financial-transaction-manager-node",
  "version": "1.0.0",
  "timestamp": "2026-04-19T14:30:45.123Z",
  "caches": {
    "materializedViews": true,
    "exchangeRates": true,
    "inflation": true,
    "portfolioSnapshots": true,
    "infoCaches": true
  }
}
```

### Response Fields

| Field | Type | Description |
|-------|------|-------------|
| `status` | string | Either `"ready"` (all caches warmed) or `"warming"` (still loading) |
| `service` | string | Service identifier (always `"financial-transaction-manager-node"`) |
| `version` | string | Application version |
| `timestamp` | string | ISO 8601 timestamp when response was generated |
| `caches` | object | Map of cache names to boolean warmup flags |
| `caches.materializedViews` | boolean | The whole materialized-view lifecycle has settled — create, index, refresh (`startup/warmup.js`). **This is the primary gate used by the Electron shell for initial navigation** — it is DB-only, so it becomes true well before network-bound tasks. On a warm boot the views already exist and creation is a metadata no-op; on a first boot (or after a migration that drops a view to redefine it) it also covers building them, which is a full aggregation scan of `transactions` per view. |
| `caches.exchangeRates` | boolean | Exchange rate cache is warm (loaded + synced from price provider) |
| `caches.inflation` | boolean | Inflation rate cache is warm |
| `caches.portfolioSnapshots` | boolean | Portfolio snapshot cache is warm |
| `caches.infoCaches` | boolean | Legacy info endpoint caches are warm |

### Warmup Behavior

At startup, the backend initializes several caches:

1. **Materialized Views** — Creates any missing view, ensures its unique index, then refreshes (`materializedViewService.js`). Deliberately *not* pre-`listen`: a missing view means a full aggregation scan of `transactions`, and reads fall back to live queries while it is absent
2. **Exchange Rates** — Fetches from price provider (e.g., Fixer, ECB), populates in-memory cache
3. **Inflation Rates** — Loads historical inflation data for tax calculations
4. **Portfolio Snapshots** — Computes portfolio snapshots for all users
5. **Info Caches** — Legacy aggregation caches (Phase 9 shadow mode)

Each warmup task:
- Runs asynchronously in the background
- Sets its flag to `true` when complete (success or error)
- Does not block `/health` or `/health/detailed` responses
- Failure is non-fatal; errors are logged, flag still set

### Status Field Semantics

- **`"ready"`** — All warmup tasks have completed (not necessarily succeeded; failures are logged)
- **`"warming"`** — At least one warmup task is still running

### Electron Initial Navigation Gate

The Electron shell (`packaging/electron/main.js`) uses `GET /health/detailed` via `pollReady()` to gate the first page load:

- **Navigate when:** `status === 'ready'` OR `caches.materializedViews === true`
- **materializedViews flag** — DB-only and fast; used as the gating condition so network-bound tasks (exchange rates, portfolio snapshots) cannot stall startup if they're slow
- **404 / unparseable 2xx fallback** — If the endpoint is absent (older backend) or the response cannot be parsed, the shell treats it as ready and navigates, ensuring it never blocks longer than the old shallow check
- Boot mark `poll_ready` (renamed from `poll_health`) is emitted on success

### Other Usage

- Frontend can poll `/health/detailed` to display warmup status (e.g., "Loading exchange rates…")
- Electron can show a detailed error page if a specific cache failed
- Observability: check which caches are taking longest to warm

## Error Responses

### Startup Failure (Alembic Not Run)

If database migrations have not run:

**Status:** `503 Service Unavailable`

**Body:**
```json
{
  "error": "Database not initialized. Run alembic upgrade head."
}
```

### Other Errors

General database or initialization errors return HTTP 500.

## Implementation Notes

- Both endpoints are synchronous (no I/O on the hot path)
- Warmup flags are set module-level; checked synchronously at request time
- No rate limiting on health endpoints
- Suitable for high-frequency polling (Electron: 200 attempts in 60s = ~3/sec)
- `GET /health` returns 200 as soon as Express's `listen()` callback fires — **before** any `warmup.js` tasks complete
- `GET /health/detailed` reflects live warmup state; once all flags are `true`, `status` transitions from `"warming"` to `"ready"` permanently until the process restarts

## Related

- [[docs/architecture/electron|Electron Desktop Architecture]] — `pollReady()` / `pollHealth()` split, startup sequence
- [[docs/adr/022-electron-sandbox-hardening-and-recovery|ADR-022: Electron Sandbox Hardening]] — Health polling strategy
- [[docs/features/settings|Settings Feature]] — Backend initialization
- [[docs/reference/code-patterns|Code Patterns]] — Warmup task pattern
