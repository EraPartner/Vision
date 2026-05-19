---
title: Admin Observability Dashboard
type: feature
status: active
date: 2026-04-25
updated: 2026-05-08
tags: [feature, admin, observability, provider-health, endpoint-liveness, shadow-divergences, aggregation, migration, phase-f, phase-9-complete, rate-limiting, admin-guard, route-gating]
description: Unified admin hub — DB maintenance, provider health, endpoint liveness, and request metrics — gated via Settings toggle.
aliases: [admin dashboard, system observability, admin monitoring, admin hub]
related_code:
  - apps/node-backend/src/routes/admin.js
  - apps/node-backend/src/services/providerHealth/providerHealthService.js
  - apps/node-backend/src/middleware/requestMetrics.js
  - apps/frontend/src/pages/admin/AdminOverviewPage.tsx
  - apps/frontend/src/pages/admin/ProviderHealthPage.tsx
  - apps/frontend/src/pages/admin/EndpointLivenessPage.tsx
  - apps/frontend/src/lib/api/admin.ts
  - apps/frontend/src/components/layout/AppSidebar.tsx
  - apps/frontend/src/stores/settingsStore.ts
---

# Admin Observability Dashboard

> [!abstract] Overview
> A cohesive admin hub gated by a Settings toggle. Surfaces DB maintenance, data-source health (7 providers), and endpoint liveness metrics in one place. Admin failures appear only inside admin pages — no global toasts or badges.

## Overview

The admin section provides operational visibility through four focused pages, accessible only when **Admin Mode** is enabled in Settings → App → Developer:

1. **Overview** (`/admin`) — Three summary tiles linking to each detail page
2. **Database Maintenance** (`/admin/db`) — Table stats and VACUUM operations
3. **Data Sources** (`/admin/providers`) — Provider health with passive tracking + active probes
4. **Endpoints** (`/admin/endpoints`) — Route liveness matrix with rolling metrics

## Enabling Admin Mode

Settings → App tab → Developer section → "Admin Mode" toggle. Persisted via `AppSettings` Zustand store (same persistence channel as all other app settings).

### Frontend Route Gating (2026-05-08)

All `/admin/*` routes are now wrapped with the `RequireAdmin` guard component ([[apps/frontend/src/components/auth/RequireAdmin.tsx]]). The guard reads `appSettings.adminMode` from the settings store:
- If `adminMode === true`: children are rendered
- If `adminMode === false`: user is redirected to `/` (dashboard)

**Note:** The backend `adminAuth.js` middleware is the actual security boundary — it rejects `/api/admin/*` requests without valid admin credentials. The frontend guard exists purely for UX: without it, deep-linking to `/admin` renders an empty page with cascading API failures. With it, users are redirected gracefully until they enable Admin Mode in settings.

> [!note] Shadow Divergences (Phase F → Removed Phase 9)
> The Shadow Divergences page (`/admin/shadow-divergences`) was used to track aggregation endpoint parity during the Phase 2→9 migration. It has been removed as of Phase 9, along with the underlying `agg_shadow_divergences` table (dropped via migration 0009). All validation criteria were met and aggregation parity confirmed.

## Shadow Divergences Monitoring (Phase F → Removed Phase 9)

> [!warning] Archived
> This section documents the Shadow Divergences feature, which was active during Phase F→8 and removed in Phase 9. Kept for historical reference and to understand the migration strategy used.

### Purpose (Historical)

During the migration from legacy `/api/info/*` to new `/api/aggregations/*` endpoints, the shadow middleware logged divergences between the two surfaces. The `/admin/shadow-divergences` page allowed operators to validate parity in production without waiting for the Phase 9 cutover.

**Original Use Cases:**
- Spot which endpoints have drift above the tolerance threshold (1¢)
- Investigate high-drift periods with detailed divergence logs
- Validate that fixes have resolved a previously-drifting endpoint
- Schedule the Phase 9 cutover once all endpoints show zero divergences

### Data Model (Removed)

The `agg_shadow_divergences` table was created in Phase F to store shadow divergence logs:
- `id` — Unique row ID
- `endpoint` — Path of the diverged endpoint (e.g., `/api/aggregations/monthly-summary`)
- `request_params` — JSONB snapshot of the request query parameters
- `divergences` — JSONB array of up to 20 divergences (capped for log volume)
- `divergence_count` — Total count of divergences found in that request
- `created_at` — Timestamp when the divergence was detected

**Removal:** This table was dropped in Phase 9 via migration 0009 after parity validation was complete.

### Dashboard Features (Historical)

#### Summary Card
- **Total Divergence Count** — Grand total across all endpoints
- Visual indicator with Activity icon

#### Per-Endpoint Summary Table
| Column | Data | Purpose |
|--------|------|---------|
| Endpoint | Path (e.g. `/api/aggregations/monthly-summary`) | Quick identification |
| Count | Number of divergent requests | Frequency metric |
| Max Diff | Highest divergence_count for that endpoint | Severity indicator |
| Last Seen | Most recent divergence timestamp | Activity/freshness |

#### Paginated Recent Log Table
| Column | Data | Purpose |
|--------|------|---------|
| Endpoint | Path | Filter context |
| Diff Count | divergence_count for this specific request | Severity badge (red if >5) |
| Params | request_params as JSON | Debug divergence context |
| Created At | Timestamp | Chronological sorting |

**Pagination:** 50 rows per page, filterable by endpoint via dropdown

**Removal:** The ShadowDivergencesPage.tsx component was deleted in Phase 9; the feature is no longer available in the admin UI.

### Endpoints (Removed in Phase 9)

The following endpoints were removed in Phase 9 after successful parity validation:

#### GET /api/admin/shadow-divergences/summary (Removed)

Per-endpoint summary with counts and timing. **No longer available.**

Example response (historical):
```json
{
  "endpoints": [
    {
      "endpoint": "/api/aggregations/monthly-summary",
      "count": 3,
      "last_seen": "2026-04-25T14:32:10.123Z",
      "max_divergence_count": 2
    }
  ],
  "total": 4
}
```

#### GET /api/admin/shadow-divergences (Removed)

Paginated detailed divergence log with optional endpoint filter. **No longer available.**

Example response (historical):
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

### Workflow (Historical)

**Phase F→Phase 8 (Shadow Window)**

1. Operators check dashboard daily (or via alerting integration)
2. Any divergence in logs triggers investigation:
   - Review the `divergences` array for affected field paths
   - Reproduce with `request_params` in local testing
   - File bug or verification task
3. Fixes are deployed and validated by checking dashboard
4. Once zero divergences for 1+ release cycles, proceed to Phase 9

**Phase 9 (Cutover) — COMPLETE**

Removal completed (2026-04-25):
1. Removed `createAggregationShadow` middleware (`aggregationShadow.js`, `aggregationShadowWiring.js`)
2. Removed `/api/info/*` aggregation fallback routes from wiring
3. Decommissioned `agg_shadow_divergences` table (dropped via migration 0009)
4. Removed `/api/admin/shadow-divergences*` endpoints
5. Deleted ShadowDivergencesPage.tsx frontend component

See [[docs/adr/016-aggregation-shadow-mode|ADR-016]] for historical context and removal criteria.

## Provider Probe Response

The `POST /api/admin/providers/:provider/probe` endpoint returns a `ProbeResult` with a full `ProviderHealth` object (not a string provider name). The frontend toast accesses `result.provider.label` with fallback to `result.provider.provider` to display the provider's human-readable name. See [[docs/api/admin#post-apiadminprovidersproviderprobe]] for the full response contract.

## Admin Hub Architecture

### Settings Gating

`adminMode: boolean` in `AppSettings` (ADR-032 Zustand store). Toggled in `DashboardSettingsDialog` → AppTab → Developer section. Persisted automatically via existing `apiClient.saveSetting('app_settings', ...)` debounced flow.

### Sidebar

`AppSidebar.tsx` renders the Admin `SidebarGroup` conditionally:
```tsx
{appSettings.adminMode && <SidebarGroup>…</SidebarGroup>}
```
Four entries: Overview, Database, Data Sources, Endpoints.

### Backend Modules

| Module | Purpose |
|--------|---------|
| `services/providerHealth/` | `recordSuccess`, `recordError`, `listHealth`, `probe` |
| `middleware/requestMetrics.js` | In-memory rolling window (15 min / 1 min buckets), p50/p95 |
| `services/routeManifest.js` | Express router stack scan → static endpoint list |

### API Endpoints

| Method | Path | Description | Rate Limit |
|--------|------|-------------|-----------|
| GET | `/api/admin/providers/health` | List all provider health rows | 500/min |
| POST | `/api/admin/providers/:provider/probe` | Active probe for one provider; returns full `ProviderHealth` object | 30/min |
| GET | `/api/admin/metrics/requests` | Rolling request metrics per route | 500/min |
| GET | `/api/admin/endpoints` | Static endpoint manifest | 500/min |
| GET | `/api/admin/db/stats` | Database table statistics | 500/min |
| POST | `/api/admin/db/vacuum` | VACUUM ANALYZE on tables | 30/min |
| POST | `/api/admin/investments/kinesis/sanitize-history` | Sanitize Kinesis spikes | 30/min |

### Rate Limiting

Admin endpoints use two specialized rate limiters:

- **500 req/min** (`adminRateLimiter`): Read-heavy operations (GET /api/admin/*). The admin hub makes 5-6 parallel page loads that would exceed a normal rate limit.
- **30 req/min** (`adminMutateLimiter`): Destructive operations (POST /api/admin/*) including database reset, VACUUM, provider probes, and Kinesis sanitization.

See [[docs/security/rate-limiting|Rate Limiting]] for details on response headers and behavior.

## Related

- [[docs/adr/035-remove-feature-flags|ADR-035: Remove Feature Flags]] — Why feature flags were removed
- [[docs/adr/034-admin-environment|ADR-034: Admin Environment]] — Architecture decision
- [[docs/adr/016-aggregation-shadow-mode|ADR-016: Aggregation Shadow Mode]] — Historical context; now retired
- [[docs/adr/011-phase2-aggregation-envelope-standard|ADR-011: Aggregation Envelope Standard]] — Now production path
- [[docs/features/provider-health|Provider Health Tracking]] — Provider health spec
- [[docs/features/database-maintenance|Database Maintenance UI]] — Table stats and VACUUM operations
- [[docs/api/admin|Admin API]] — Full endpoint documentation
- [[docs/reference/api-endpoint-matrix|API Endpoint Matrix]] — Current endpoint count

## See Also

- Settings persistence: [[docs/adr/032-zustand-unified-settings-store|ADR-032]]
- For database health diagnostics, see [[docs/features/database-maintenance|Database Maintenance]]
- For aggregation API details, see [[docs/api/aggregations|Aggregations API]]
