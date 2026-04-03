---
title: ADR 005 - Materialized Views for Dashboard Performance
type: adr
status: Accepted
date: 2026-04-02
tags: [architecture, database, performance, materialized-views, postgresql]
description: Decision to use PostgreSQL materialized views for pre-computed dashboard aggregations
aliases: [materialized views, dashboard caching, pre-computed aggregations]
related_code: ["apps/node-backend/src/services/materializedViewService.js", "apps/node-backend/src/routes/info.js"]
---

# ADR-005: Materialized Views for Dashboard Performance

## Status
Accepted

## Date
2026-03-18

## Context

The dashboard requires multiple aggregation queries:
- Monthly income vs. expenses
- Category breakdowns
- Cash flow comparisons
- Bank balances
- Recurring pattern detection

Running these queries on every dashboard load with thousands of transactions causes:
1. **Slow initial load** — multiple complex aggregations
2. **Database pressure** — repeated expensive queries
3. **Poor UX** — loading spinners on every navigation

## Decision

Use **PostgreSQL materialized views** to pre-compute dashboard aggregations.

### Refresh Strategy

1. **On startup** — Refresh all materialized views after schema initialization
2. **Scheduled** — Every 12 hours via `setInterval`
3. **On demand** — `POST /api/info/refresh-views` endpoint

### Views Created

| View | Purpose | Refresh Cost |
|------|---------|-------------|
| `mv_monthly_summary` | Monthly income/expense totals | Low |
| `mv_category_breakdown` | Spending by category | Medium |
| `mv_cashflow` | Daily cash flow series | Medium |
| `mv_bank_balances` | Current balance per account | Low |
| `mv_recurring_patterns` | Detected recurring transactions | High |

### Implementation

```javascript
// materializedViewService.js
export async function refreshAllViews() {
  await query('REFRESH MATERIALIZED VIEW CONCURRENTLY mv_monthly_summary');
  await query('REFRESH MATERIALIZED VIEW CONCURRENTLY mv_category_breakdown');
  // ...
}
```

## Consequences

### Positive
- **Fast dashboard loads** — pre-computed results
- **Reduced DB load** — fewer complex queries
- **CONCURRENTLY refresh** — no read locks during refresh

### Negative
- **Stale data** — data is only as fresh as last refresh
- **Storage overhead** — materialized views consume disk space
- **Startup delay** — initial refresh adds to startup time
- **Complexity** — must handle view refresh failures gracefully

## Related

- [[docs/performance/materialized-views]] — Detailed documentation
- [[docs/diagrams/materialized-view-flow.puml]] — Flow diagram
- [[docs/adr/001-technology-stack|ADR-001: Technology Stack]]
