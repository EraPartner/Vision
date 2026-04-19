---
title: Health API
type: api
status: active
date: 2026-04-19
tags: [api, health, monitoring, backend, readiness, warmup]
description: Health check endpoints for backend readiness and cache warmup status
aliases: [health endpoints, readiness check, backend health]
---

# Health API

## Overview

The Health API provides two endpoints for monitoring backend readiness:

- **`GET /health`** — Simple liveness/readiness check (all Electron apps poll this at startup)
- **`GET /health/detailed`** — Includes warmup status for caches (exchange rates, inflation, portfolio snapshots)

Both endpoints return quickly (no I/O on success) and are safe for high-frequency polling.

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

- Electron startup health poll (200 attempts, 300ms interval, 60s timeout)
- Electron watchdog (10s interval, 3 consecutive failures triggers backend:lost event)
- Load balancer/reverse proxy readiness checks
- Kubernetes liveness probes

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
| `caches.exchangeRates` | boolean | Exchange rate cache is warm (loaded + synced from price provider) |
| `caches.inflation` | boolean | Inflation rate cache is warm |
| `caches.portfolioSnapshots` | boolean | Portfolio snapshot cache is warm |
| `caches.infoCaches` | boolean | Legacy info endpoint caches are warm |

### Warmup Behavior

At startup, the backend initializes several caches:

1. **Exchange Rates** — Fetches from price provider (e.g., Fixer, ECB), populates in-memory cache
2. **Inflation Rates** — Loads historical inflation data for tax calculations
3. **Portfolio Snapshots** — Computes portfolio snapshots for all users
4. **Info Caches** — Legacy aggregation caches (Phase 9 shadow mode)

Each warmup task:
- Runs asynchronously in the background
- Sets its flag to `true` when complete (success or error)
- Does not block `/health` or `/health/detailed` responses
- Failure is non-fatal; errors are logged, flag still set

### Status Field Semantics

- **`"ready"`** — All warmup tasks have completed (not necessarily succeeded; failures are logged)
- **`"warming"`** — At least one warmup task is still running

### Usage

- Frontend can poll `/health/detailed` to display warmup status (e.g., "Loading exchange rates…")
- Electron can show detailed error page if a specific cache failed
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

## Related

- [[docs/adr/022-electron-sandbox-hardening-and-recovery|ADR-022: Electron Sandbox Hardening]] — Health polling strategy
- [[docs/features/settings|Settings Feature]] — Backend initialization
- [[docs/reference/code-patterns|Code Patterns]] — Warmup task pattern
