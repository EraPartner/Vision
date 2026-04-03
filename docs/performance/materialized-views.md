---
title: Materialized Views
type: performance
status: active
date: 2026-03-18
tags: [performance, database, materialized-views, optimization]
description: PostgreSQL materialized views for pre-computing expensive dashboard aggregations
aliases: [materialized views, pre-computed queries, dashboard optimization]
related_code: ["apps/node-backend/src/services/materializedViewService.js"]
---

# Materialized Views

Vision uses PostgreSQL materialized views to pre-compute expensive aggregations for dashboards and analytics, dramatically improving query performance.

## Overview

Materialized views store the result of a query physically on disk, allowing for fast retrieval without recalculating complex aggregations on every request.

## Materialized Views in Vision

### mv_monthly_summary

Pre-computes monthly income, spending, and net totals by category for the last 12 months.

```sql
SELECT
  date_trunc('month', t.date)::date AS month_start,
  EXTRACT(MONTH FROM t.date)::int AS month,
  EXTRACT(YEAR FROM t.date)::int AS year,
  t.currency,
  COUNT(*) AS transaction_count,
  SUM(CASE WHEN t.amount >= 0 THEN t.amount ELSE 0 END) AS total_income,
  SUM(CASE WHEN t.amount < 0 THEN t.amount ELSE 0 END) AS total_spending,
  SUM(t.amount) AS net_amount,
  c.id AS category_id,
  COALESCE(c.general || ':' || c.detail, 'UNCATEGORISED') AS category_name
FROM transactions t
LEFT JOIN categories c ON ...
WHERE t.date >= date_trunc('month', CURRENT_DATE) - interval '12 months'
GROUP BY month_start, month, year, t.currency, c.id
```

---

### mv_category_totals

All-time category totals for quick category breakdowns.

**Data retained:** All-time  
**Ordering:** By transaction count descending

---

### mv_cashflow_daily

Daily cashflow for the last 7 months (6 complete + current).

**Data retained:** 6 months + current month  
**Use case:** Daily spending trends and cashflow charts

---

### mv_bank_balances

Running totals per bank account.

**Metrics:**
- First transaction date
- Last transaction date
- Total balance
- Transaction count

---

## Refresh Strategy

### Concurrent Refresh

Views are refreshed using `CONCURRENTLY` to allow reads during refresh:

```sql
REFRESH MATERIALIZED VIEW CONCURRENTLY mv_monthly_summary;
```

**Requirements:**
- Unique index must exist on the view
- No overlapping updates during refresh

### Debounced Refresh

After single-row mutations (e.g., editing a transaction), a debounced refresh is scheduled:

```javascript
scheduleRefresh();  // Waits 1 second to coalesce rapid changes
```

### Coalesced Refresh

During bulk imports, rapid refresh calls are coalesced into a single operation:

```javascript
// Multiple rapid calls result in only one refresh
refreshMaterializedViews();
refreshMaterializedViews();
refreshMaterializedViews();  // Only one refresh executes
```

## Performance Benefits

| Query Type | Without MV | With MV |
|------------|-----------|---------|
| Monthly summary | ~500ms | ~5ms |
| Category totals | ~800ms | ~3ms |
| Daily cashflow | ~400ms | ~4ms |
| Bank balances | ~200ms | ~2ms |

## Indexes

Each view has a unique index for concurrent refresh support:

```sql
CREATE UNIQUE INDEX mv_monthly_summary_idx
ON mv_monthly_summary (month_start, currency, category_id_key);
```

## Maintenance

### Automatic Refresh

Views are automatically refreshed:
- After bulk imports
- After significant data changes (debounced)
- On application startup (if needed)

### Manual Refresh

Can be triggered manually via the service:

```javascript
import { refreshMaterializedViews } from './services/materializedViewService.js';
await refreshMaterializedViews();
```

## Best Practices

1. **Use for read-heavy queries** - Ideal for dashboard aggregations
2. **Balance freshness vs. performance** - Don't refresh too frequently
3. **Use unique indexes** - Required for concurrent refresh
4. **Monitor refresh times** - Long refreshes may indicate need for tuning

## See Also

- [[docs/performance/index]] - Performance Documentation Index
- [[docs/adr/002-database-schema]] - Database Schema
- [[docs/api/transactions]] - Transactions API
