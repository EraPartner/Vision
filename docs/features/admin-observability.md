---
title: Admin Observability Dashboard
type: feature
status: active
date: 2026-04-25
tags: [feature, admin, observability, shadow-divergences, aggregation, migration, phase-f]
description: Administrative dashboards for monitoring system health, database maintenance, feature flags, and aggregation shadow divergences during the Phase 2→9 migration window.
aliases: [admin dashboard, system observability, shadow divergences, admin monitoring]
related_code:
  - apps/node-backend/src/routes/admin.js
  - apps/frontend/src/pages/DbMaintenancePage.tsx
  - apps/frontend/src/pages/ShadowDivergencesPage.tsx
  - apps/frontend/src/lib/api/admin.ts
  - apps/frontend/src/components/layout/AppSidebar.tsx
---

# Admin Observability Dashboard (Phase F)

> [!abstract] Overview
> A suite of administrative dashboards providing real-time system observability, including shadow divergence monitoring during the aggregation migration, database maintenance, and feature flag management.

## Overview

The admin dashboard provides operational visibility into Vision's health and performance through multiple focused pages:

1. **Database Maintenance** (`/admin/db`) — Monitor table statistics and run VACUUM operations
2. **Shadow Divergences** (`/admin/shadow-divergences`) — Track aggregation endpoint parity during Phase 2→9 migration
3. **Feature Flags** (in-dashboard toggles) — Enable/disable experimental features

## Shadow Divergences Monitoring (Phase F)

### Purpose

During the migration from legacy `/api/info/*` to new `/api/aggregations/*` endpoints, the shadow middleware logs divergences between the two surfaces. This page lets operators validate parity in production without waiting for the Phase 9 cutover.

**Use Cases:**
- Spot which endpoints have drift above the tolerance threshold (1¢)
- Investigate high-drift periods with detailed divergence logs
- Validate that fixes have resolved a previously-drifting endpoint
- Schedule the Phase 9 cutover once all endpoints show zero divergences

### Data Model

The `agg_shadow_divergences` table stores:
- `id` — Unique row ID
- `endpoint` — Path of the diverged endpoint (e.g., `/api/aggregations/monthly-summary`)
- `request_params` — JSONB snapshot of the request query parameters
- `divergences` — JSONB array of up to 20 divergences (capped for log volume)
- `divergence_count` — Total count of divergences found in that request
- `created_at` — Timestamp when the divergence was detected

### Dashboard Features

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

### Endpoints

#### GET /api/admin/shadow-divergences/summary

Per-endpoint summary with counts and timing.

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

#### GET /api/admin/shadow-divergences

Paginated detailed divergence log with optional endpoint filter.

**Query Parameters:**
- `endpoint` — Filter to single endpoint (omit for all)
- `limit` — Results per page (default 50, max 200)
- `offset` — Pagination offset (default 0)

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

### Workflow

**Phase F→Phase 8 (Shadow Window)**

1. Operators check dashboard daily (or via alerting integration)
2. Any divergence in logs triggers investigation:
   - Review the `divergences` array for affected field paths
   - Reproduce with `request_params` in local testing
   - File bug or verification task
3. Fixes are deployed and validated by checking dashboard
4. Once zero divergences for 1+ release cycles, proceed to Phase 9

**Phase 9 (Cutover)**

When all removal criteria are met:
1. Remove `createAggregationShadow` middleware
2. Remove `/api/info/*` fallback routes
3. Decommission `agg_shadow_divergences` table (can be archived or dropped)

See [[docs/adr/016-aggregation-shadow-mode|ADR-016]] for removal criteria and tracking.

## Related

- [[docs/adr/016-aggregation-shadow-mode|ADR-016: Aggregation Shadow Mode]] — Decision and removal criteria
- [[docs/features/database-maintenance|Database Maintenance UI]] — Table stats and VACUUM operations
- [[docs/api/admin|Admin API]] — Full endpoint documentation
- [[docs/reference/api-endpoint-matrix|API Endpoint Matrix]] — All 146+ endpoints

## See Also

- Feature flags are managed via the Admin UI callout in [[docs/features/settings|Settings Feature]]
- For database health diagnostics, see [[docs/features/database-maintenance|Database Maintenance]]
