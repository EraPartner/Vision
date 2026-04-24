---
title: Admin Pages
type: component
status: active
date: 2026-04-25
tags: [component, admin, observability, dashboard, provider-health, endpoint-liveness, feature-flags, phase-f]
description: System observability dashboard components (Phase F) - AdminOverviewPage, ProviderHealthPage, EndpointLivenessPage, AdminFeatureFlagsPage
aliases: [admin pages, observability dashboards, system admin UI]
related_code:
  - apps/frontend/src/pages/admin/AdminOverviewPage.tsx
  - apps/frontend/src/pages/admin/ProviderHealthPage.tsx
  - apps/frontend/src/pages/admin/EndpointLivenessPage.tsx
  - apps/frontend/src/pages/admin/AdminFeatureFlagsPage.tsx
  - apps/frontend/src/lib/api/admin.ts
  - apps/node-backend/src/routes/admin.js
---

# Admin Pages

> [!abstract] Overview
> Four system observability dashboard pages gated behind the Admin Mode toggle in Settings (ADR-034). All pages consume typed API methods from `apiClient.admin.*` with error handling and loading states.

## AdminOverviewPage

Path: `/admin`

Summary dashboard with four metric tiles:

| Tile | Metric | Source |
|------|--------|--------|
| Database Size | Total table sizes + row counts | `GET /api/admin/db/stats` |
| Data Sources | Provider health status (failing count) | `GET /api/admin/providers/health` |
| Endpoints | Total routes + error rate % | `GET /api/admin/metrics/requests` |
| Feature Flags | Enabled count + total count | `GET /api/admin/feature-flags` |

Each tile links to its detail page. Auto-refreshes every 10 seconds via polling interval.

### Usage

```tsx
<AdminOverviewPage />
```

### API Methods

- `getAdminStatus()` — Initial health check
- `getProviderHealth()` — List all providers
- `getRequestMetrics()` — Aggregate request counts
- `listFeatureFlags()` — Count enabled flags

## ProviderHealthPage

Path: `/admin/providers`

Data source health tracking for 7 providers across three kinds (price, FX, inflation):

| Provider | Kind | Tracked Metrics |
|----------|------|-----------------|
| Binance | price | Last success, last error, failure streak |
| Yahoo Finance | price | Last success, last error, failure streak |
| Kinesis | price | Last success, last error, failure streak |
| ECB | FX | Last success, last error, failure streak |
| Open Exchange Rates | FX | Last success, last error, failure streak |
| Statbel | inflation | Last success, last error, failure streak |
| Eurostat | inflation | Last success, last error, failure streak |

### UI Features

- Per-row "Check now" button triggers active probe (`POST /api/admin/providers/:provider/probe`)
- Toast feedback on probe success/failure
- Last success/error timestamps with "Never" fallback
- Failure count and streak tracking
- Passive tracking data from all operations (price fetch, FX lookup, inflation fetch)

### Usage

```tsx
<ProviderHealthPage />
```

### API Methods

- `getProviderHealth()` — List all provider rows with timestamps and error messages
- `probeProvider(provider)` — Trigger active on-demand probe for one provider

## EndpointLivenessPage

Path: `/admin/endpoints`

Route liveness matrix with rolling request metrics (15-minute window):

| Column | Data | Calculation |
|--------|------|-------------|
| Path | Route path (e.g. `/api/transactions`) | Static manifest |
| Method | HTTP method (GET, POST, etc.) | Static manifest |
| Requests | Request count in window | Rolling counter |
| Errors | Error count in window | Rolling counter |
| Error % | (Errors / Requests) * 100 | Derived |
| p50 | Median response time | Percentile from buckets |
| p95 | 95th percentile response time | Percentile from buckets |

### UI Features

- Filter input to search routes by path/method
- Sort by any column
- Color-coded error rate (green < 5%, yellow 5-20%, red > 20%)
- Metrics reset on backend restart (acceptable for single-user app)

### Usage

```tsx
<EndpointLivenessPage />
```

### API Methods

- `getEndpointManifest()` — Static list of all routes (method, path, description)
- `getRequestMetrics()` — Rolling metrics per route (counts, error count, p50/p95)

## AdminFeatureFlagsPage

Path: `/admin/feature-flags`

Feature flag table with per-row toggle:

| Column | Data | Editable |
|--------|------|----------|
| Flag | Feature flag key (e.g. `AI_CHAT_ENABLED`) | No |
| Enabled | Boolean toggle | Yes (PATCH endpoint) |
| Description | Human-readable description | No |
| Last Updated | Timestamp of last toggle | No |

### UI Features

- Empty state if no flags defined
- Per-row toggle button (PATCH endpoint)
- Success/error toasts on toggle
- Timestamps show when each flag was last modified
- Flags stored in PostgreSQL (not ephemeral; persists across restarts)

### Usage

```tsx
<AdminFeatureFlagsPage />
```

### API Methods

- `listFeatureFlags()` — List all flags with enabled status and timestamps
- `toggleFeatureFlag(key, enabled)` — PATCH a single flag's enabled state

## Type Signatures

Frontend types in `apps/frontend/src/lib/api/admin.ts`:

```typescript
export interface ProviderHealth {
  provider: string;
  kind: 'price' | 'fx' | 'inflation';
  label: string;
  last_success_at: string | null;
  last_error_at: string | null;
  last_error: string | null;
  consecutive_failures: number;
}

export interface ProbeResult {
  provider: string;
  status: 'ok' | 'error';
  message: string;
  timestamp: string;
}

export interface RouteMetric {
  path: string;
  method: string;
  count: number;
  errors: number;
  p50_ms: number;
  p95_ms: number;
}

export interface EndpointEntry {
  method: string;
  path: string;
  description: string;
}
```

## Integration Points

- **Settings**: Admin mode toggle (`adminMode: boolean`) in `AppSettings` Zustand store
- **Sidebar**: Rendered conditionally in `AppSidebar` when `adminMode === true`
- **i18n**: ~60 keys under `admin.*`, `nav.admin*`, `settings.app.admin*`

## Related Documentation

- [[docs/adr/034-admin-environment|ADR-034: Admin Environment]] — Architecture decision
- [[docs/adr/032-zustand-unified-settings-store|ADR-032: Zustand Unified Settings Store]] — Settings persistence
- [[docs/features/admin-observability|Admin Observability Feature]] — Feature spec
- [[docs/features/provider-health|Provider Health Tracking]] — Provider tracking details
- [[docs/api/admin|Admin API]] — Backend endpoint contracts
- [[docs/components/layout|Layout Components]] — AppSidebar rendering
