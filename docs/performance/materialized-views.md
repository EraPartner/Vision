---
title: Materialized Views & Aggregation Strategy
type: performance
status: active
date: 2026-04-25
tags: [performance, database, materialized-views, aggregations, optimization, phase-1]
description: PostgreSQL materialized views and trigger-maintained tables for pre-computing dashboard aggregations. Phase 1 aggregation refactor.
aliases: [materialized views, pre-computed queries, dashboard optimization, aggregation tables, trigger-maintained tables]
related_code: ["apps/node-backend/src/services/aggregationRefresh.js", "apps/node-backend/src/services/materializedViewService.js", "alembic/versions/0026_finance_aggregations.py"]
---

# Materialized Views & Aggregation Strategy

Vision uses PostgreSQL as the **single aggregation caching tier** via two complementary strategies: **Materialized Views** (on-demand refresh) and **Trigger-Maintained Tables** (real-time maintenance). This eliminates the need for Redis or in-process caches.

See [[docs/adr/010-phase1-aggregation-strategy|ADR-010]] for the full architecture decision and rationale.

## Overview

### Two Maintenance Strategies

| Strategy | Use Case | Maintenance | Latency | Examples |
|----------|----------|-------------|---------|----------|
| **Materialized Views** | Expensive temporal aggregates (monthly rollups, category breakdowns) | On-demand refresh after mutations | ~50–150ms | `mv_monthly_summary`, `mv_recipient_monthly` |
| **Trigger-Maintained Tables** | Real-time aggregates requiring consistency with source tables | Automatic via row-level triggers | <1ms | `agg_recipient_totals`, `agg_split_outstanding` |

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

**Fast Path (Recent Months Only):**

`getMonthlyFinancialSummary()` in `infoRepositoryMonthly.js` uses a fast-path optimization to read from `mv_monthly_summary` when all of the following conditions are met:
- `allTime=false` (default; requesting recent months only, not full history)
- No category exclusions (`excluded_category_ids` is empty)
- No recipient exclusions (`excluded_recipient_ids` is empty)
- MV is available (has been refreshed)

When all conditions are true, the query skips live SQL and returns aggregated data directly from the MV (~5–10ms). **When `allTime=true`, the fast path is always bypassed** — the method executes live SQL against full transaction history to ensure complete all-time data, since MVs only retain recent months (12–24 months).

See [[apps/node-backend/src/repositories/infoRepositoryMonthly.js]] line 30 for the condition: `if (!allTime && validIds.length === 0 && validRecipientIds.length === 0 && await mvAvailable('mv_monthly_summary'))`.

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

### Phase 1 Views (Aggregation Refactor)

#### mv_recipient_monthly

Pre-computed monthly aggregates per recipient per currency. Rolls up sub-recipients under a primary recipient when `primary_recipient_id` is set.

**Data retained:** Last 24 months (older totals available from `agg_recipient_totals`)

**Key columns:**
- `month_start` — first day of the month (bucketed in `APP_TIMEZONE`)
- `recipient_id` — rolled up to primary recipient
- `currency` — ISO currency code
- `transaction_count`, `total_income`, `total_spending`, `net_amount`

**Use case:** Recipient insights page, top-recipient widgets

**Timezone handling:** Buckets transactions in `APP_TIMEZONE` (not UTC) via:
```sql
date_trunc('month', t.date AT TIME ZONE 'Europe/Brussels')
```

---

#### Trigger-Maintained Tables (Real-Time Aggregates)

Two new tables are kept in sync by row-level triggers on source tables. **Application code never refreshes these** — they update automatically on `INSERT`, `UPDATE`, `DELETE`.

##### agg_recipient_totals

Running all-time totals per recipient per currency.

**PK:** `(recipient_id, currency)`

**Maintained by:** `fn_agg_recipient_totals_sync()` trigger on `transactions`

**Respects:** `is_active` flag (inactive transactions excluded)

**Use case:** Phase 6 fuzzy recipient auto-link, recipient stats queries

**Example trigger call:**
```javascript
// App code does nothing special — trigger handles it:
await query('INSERT INTO transactions (...) VALUES (...)');
// Automatically: agg_recipient_totals updated in <1ms
```

##### agg_split_outstanding

Outstanding balance per split (original minus paid).

**PK:** `split_id`

**Maintained by:**
- `fn_trg_split_sync()` on `transaction_splits`
- `fn_trg_split_payment_sync()` on `split_payments`

**Recomputes:** `outstanding = original_amount - SUM(split_payments.amount)`

**Use case:** Owed-balance endpoint (Phase 4), dashboard balance widget

**Example:** When a split payment is recorded:
```javascript
// App code does nothing special — triggers handle it:
await query('INSERT INTO split_payments (split_id, amount) VALUES (...)');
// Automatically: agg_split_outstanding.outstanding_amount updated in <1ms
```

---

## Refresh Strategy

All refreshes are orchestrated via a single entrypoint: **`aggregationRefresh.js`** (`refreshAggregations()`, `scheduleAggregationRefresh()`).

### Manual Refresh (Bulk Operations)

After bulk imports or mass updates, trigger a full refresh:

```javascript
import { refreshAggregations } from './services/aggregationRefresh.js';

// After import completes:
await refreshAggregations();
// Refreshes all legacy + Phase-1 MVs in parallel (~100–200ms typical)
```

**What it does:**
- Delegates legacy views (`mv_monthly_summary`, `mv_category_totals`, etc.) to `materializedViewService.refreshMaterializedViews()`
- Refreshes Phase-1 views (`mv_recipient_monthly`) in parallel
- No-op for trigger-maintained tables (they update automatically)

### Debounced Refresh (Single-Row Mutations)

After editing or deleting a single transaction:

```javascript
import { scheduleAggregationRefresh } from './services/aggregationRefresh.js';

// In route handler after mutation:
await scheduleAggregationRefresh();
// Coalesces rapid changes into one refresh (1s debounce)
```

**Behavior:**
- First call schedules refresh in 1 second
- Additional calls within 1s don't queue more refreshes (coalescing)
- Triggers fire immediately (trigger-maintained tables stay in sync)
- MV refresh happens once per debounce window

### Concurrent vs. Non-Concurrent Refresh

Views are refreshed using `CONCURRENTLY` to allow reads during refresh:

```sql
REFRESH MATERIALIZED VIEW CONCURRENTLY mv_monthly_summary;
```

**Requirements:**
- Unique index must exist on the view
- View must have been populated at least once
- No overlapping CONCURRENTLY refreshes on the same view

**Fallback:** On first refresh after migration, if `CONCURRENTLY` fails with "has not been populated", the orchestrator falls back to non-concurrent refresh:

```javascript
try {
  await query(`REFRESH MATERIALIZED VIEW CONCURRENTLY ${view}`);
} catch (err) {
  if (err.message.includes('has not been populated')) {
    await query(`REFRESH MATERIALIZED VIEW ${view}`);  // Blocks reads during refresh
  }
}
```

### Request Coalescing

The orchestrator prevents refresh storms during concurrent user activity:

```javascript
// Scenario: 10 users edit transactions simultaneously
// Each calls scheduleAggregationRefresh()
// Result: 1 refresh at end of 1s window (not 10)

// Behind the scenes:
let phase1InFlight = false;
let phase1Queued = false;

// First call:
phase1InFlight = true;  // Lock acquired
// ... refresh runs ...
phase1InFlight = false; // Lock released

// If calls arrived during refresh:
if (phase1Queued) {
  phase1Queued = false;
  // Schedule another refresh (deferred)
}
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

## Call-Site Patterns

### After Bulk Import

```javascript
import { refreshAggregations } from './services/aggregationRefresh.js';

// In import service, after all transactions inserted:
await refreshAggregations();
logger.info('All aggregations refreshed');
```

### After Single-Row Mutation

```javascript
import { scheduleAggregationRefresh } from './services/aggregationRefresh.js';

// In transaction route handler:
app.patch('/api/transactions/:id', async (req, res) => {
  const updated = await transactionService.update(req.params.id, req.body);
  
  // Schedule debounced refresh (doesn't block response)
  scheduleAggregationRefresh().catch(err => logger.error('Refresh failed', err));
  
  res.json(updated);
});
```

### Cron-Based Safety Refresh (Optional)

For additional safety, schedule a full refresh nightly:

```javascript
// In a cron job or scheduled task:
setInterval(async () => {
  logger.info('Running nightly aggregation refresh');
  await refreshAggregations();
}, 24 * 60 * 60 * 1000);
```

## Best Practices

### For Materialized Views
1. **Use for read-heavy queries** — Ideal for dashboard aggregations
2. **Balance freshness vs. performance** — Don't refresh too frequently; use debounce for single-row edits
3. **Use unique indexes** — Required for concurrent refresh; prevents duplicate rows
4. **Monitor refresh times** — Long refreshes may indicate need for indexing on source tables
5. **Set scope appropriately** — e.g., `mv_recipient_monthly` covers 24 months to keep refreshes fast
6. **Understand scope limitations** — MVs retain recent months only, not all-time history. Queries requesting `allTime=true` (full transaction history) must always use live SQL, not MVs. Fast-path optimizations check this condition and fall back to live SQL when needed (see `mv_monthly_summary` fast path in [[#mv-monthly-summary]])

### For Trigger-Maintained Tables
1. **Never call refresh from app code** — Triggers maintain these automatically
2. **Document in code** — Mark aggregates with a comment: `// Maintained by agg_recipient_totals trigger`
3. **Verify trigger firing** — If aggregates look stale, check that triggers are enabled: `SELECT * FROM pg_trigger WHERE NOT tgisinternal`
4. **Plan for trigger latency** — Row-level triggers add ~1ms per mutation; acceptable for single-row edits, noticeable during bulk operations (mitigate with CONCURRENTLY refreshes post-import)

> [!warning] Do Not Manually Update Aggregates
> Never UPDATE or INSERT directly into `agg_recipient_totals` or `agg_split_outstanding`. Triggers are the source of truth. Direct updates will be overwritten on the next mutation.

## Timezone Awareness

All aggregation queries (especially MVs) that bucket by date use `AT TIME ZONE 'APP_TIMEZONE'` to ensure consistent bucketing with the application's configured timezone. See [[docs/adr/009-timezone-policy|ADR-009]] for details.

```sql
-- CORRECT: Uses APP_TIMEZONE (e.g., Europe/Brussels)
date_trunc('month', t.date AT TIME ZONE 'Europe/Brussels')

-- WRONG: Uses database server timezone (may differ)
date_trunc('month', t.date)
```

## See Also

- [[docs/adr/010-phase1-aggregation-strategy|ADR-010: Aggregation Strategy]] — Full architecture decision
- [[docs/adr/009-timezone-policy|ADR-009: Timezone Policy]] — Timezone bucketing strategy
- [[docs/reference/data-model|Data Model Reference]] — Aggregation entity definitions
- [[docs/performance/index]] — Performance Documentation Index
- [[docs/reference/database-triggers|Database Triggers]] — All trigger definitions
- [[apps/node-backend/src/services/aggregationRefresh.js|aggregationRefresh.js]] — Orchestrator source
- [[alembic/versions/0026_finance_aggregations.py|Migration 0026]] — Aggregation layer schema
