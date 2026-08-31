---
title: Materialized Views & Aggregation Strategy
type: performance
status: active
date: 2026-08-25
updated: 2026-08-31
tags:
  [
    performance,
    database,
    materialized-views,
    aggregations,
    optimization,
    phase-1,
    migration-0035,
    migration-0038,
    migration-0080,
    migration-0082,
    adr-068,
  ]
description: Current PostgreSQL materialized views and trigger-maintained tables for dashboard aggregation, including the retired recipient and bank-balance caches.
aliases:
  [
    materialized views,
    pre-computed queries,
    dashboard optimization,
    aggregation tables,
    trigger-maintained tables,
  ]
related_code:
  [
    "apps/node-backend/src/services/aggregationRefresh.js",
    "apps/node-backend/src/services/materializedViewService.js",
    "alembic/versions/0035_add_recipient_aggregations.py",
    "alembic/versions/0038_drop_mv_recipient_monthly.py",
    "alembic/versions/0080_drop_agg_recipient_totals.py",
    "alembic/versions/0082_drop_mv_bank_balances.py",
  ]
---

# Materialized Views & Aggregation Strategy

Vision uses PostgreSQL as the **single aggregation caching tier** via two complementary strategies: **Materialized Views** (on-demand refresh) and **Trigger-Maintained Tables** (real-time maintenance). This eliminates the need for Redis or in-process caches.

See [[docs/adr/010-phase1-aggregation-strategy|ADR-010]] for the full architecture decision and rationale.

## Overview

### Two Maintenance Strategies

| Strategy                      | Use Case                                                             | Maintenance                       | Latency   | Examples                                                                                                                                                      |
| ----------------------------- | -------------------------------------------------------------------- | --------------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Materialized Views**        | Expensive temporal aggregates (monthly rollups, category breakdowns) | On-demand refresh after mutations | ~50–150ms | `mv_monthly_summary`, `mv_category_totals`, `mv_cashflow_daily` (`mv_recipient_monthly` was dropped in 0038; `mv_bank_balances` was dropped for good in 0082) |
| **Trigger-Maintained Tables** | Real-time aggregates requiring consistency with source tables        | Automatic via row-level triggers  | <1ms      | `agg_split_outstanding` (`agg_recipient_totals` was dropped in 0080)                                                                                          |

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

### mv_bank_balances — DROPPED (July 2026, migration 0082)

> [!warning] Removed
> `mv_bank_balances` was dropped by migration `0082_drop_mv_bank_balances.py`. **Do not reference this view in new code.**

The view held all-time totals per account and currency, but application code had no readers while every transaction mutation paid to refresh it. Its simple `SUM(amount)` also omitted opening-balance anchors and could not represent the live account-balance contract. Current account balances are computed from the ledger and anchors through `accountBalanceSql.js`.

The migration downgrade recreates the historical `(account_id, currency)` view with no data for rollback only; it does not make the view part of the current runtime.

---

### Phase 1 Views (Aggregation Refactor)

#### mv_recipient_monthly — DROPPED (June 2026, ADR-068)

> [!warning] Removed
> `mv_recipient_monthly` was dropped by migration `0038_drop_mv_recipient_monthly.py`. **Do not reference this view in new code.**

**Reason:** The view was never read by application code after the trigger-maintained `agg_recipient_totals` table was introduced. It added write-amplification (every transaction mutation triggered a concurrent MV refresh) with no query serving it. The `aggregationRefresh.js` service no longer refreshes it.

**Downgrade path:** The `downgrade()` function in `0038` recreates the 24-month version of the view for safe rollback.

**What replaced it:** Recipient-insights endpoints already used live aggregation queries; the removed view had no reader. The separate `agg_recipient_totals` table only served a recipient-activity existence probe until migration `0080` replaced that probe with a direct `transactions` query and dropped the table. The recipient-insights envelope correctly reports `source: 'live'`.

See [[docs/adr/068-drop-mv-recipient-monthly|ADR-068]] for the full decision record.

---

#### Trigger-Maintained Tables (Real-Time Aggregates)

`agg_split_outstanding` is the only live trigger-maintained aggregate table. **Application code never refreshes it** — its source-table triggers update it automatically on `INSERT`, `UPDATE`, `DELETE`.

##### agg_recipient_totals — DROPPED (July 2026, migration 0080)

> [!warning] Removed
> `agg_recipient_totals` was dropped by migration `0080_drop_agg_recipient_totals.py`. **Do not reference this table or its triggers in new code.**

The table maintained all-time totals per recipient and currency through a row-level transaction trigger. Its only remaining reader was an activity-existence check. That check now probes active, non-transfer transactions directly, so the table, trigger, and helper functions were pure write overhead and were removed together.

The migration downgrade can recreate and backfill the historical table, but it is not part of the current schema.

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
await query("INSERT INTO split_payments (split_id, amount) VALUES (...)");
// Automatically: agg_split_outstanding.outstanding_amount updated in <1ms
```

---

## Refresh Strategy

Application mutation refreshes are orchestrated through **`aggregationRefresh.js`**. Startup and explicit maintenance may call `materializedViewService` directly.

### Explicit Full Refresh (Maintenance)

Explicit maintenance that must wait for current projections can trigger a full refresh:

```javascript
import { refreshAggregations } from "./services/aggregationRefresh.js";

// Explicit maintenance operation:
await refreshAggregations();
// Refreshes the three managed MVs, then clears forecast caches.
```

**What it does:**

- Delegates legacy views (`mv_monthly_summary`, `mv_category_totals`, etc.) to `materializedViewService.refreshMaterializedViews()`
- `mv_recipient_monthly` is no longer refreshed — it was dropped in migration `0038` (June 2026, ADR-068)
- No-op for trigger-maintained tables (they update automatically)

### Import Completion

An import does not await the full materialized-view scans. After transfer reconciliation, it awaits both attempts made by `clearForecastMcCaches()` and calls `scheduleMaterializedViewRefresh()` once. Each invalidation failure is logged and non-fatal, so the response confirms durable canonical rows and attempted forecast-cache invalidation, while MV-backed monthly and category projections remain eventually consistent until the scheduled refresh completes.

The materialized-view scheduler uses a five-second trailing debounce and a ten-second maximum wait for a continuous burst. Refresh execution time and a possible wait behind an in-flight refresh are additional. A successful refresh clears the process statistics cache again after the views switch snapshots, preventing a request during refresh from preserving the old projection.

### Debounced Refresh (Single-Row Mutations)

After editing or deleting a single transaction:

```javascript
import { scheduleAggregationRefresh } from "./services/aggregationRefresh.js";

// In route handler after mutation:
scheduleAggregationRefresh();
// Coalesces rapid changes into one MV refresh.
```

**Behavior:**

- The MV rebuild uses a five-second trailing debounce and a ten-second burst cap
- The forecast-cache clear uses its own one-second trailing debounce
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
  if (err.message.includes("has not been populated")) {
    await query(`REFRESH MATERIALIZED VIEW ${view}`); // Blocks reads during refresh
  }
}
```

### Request Coalescing

The orchestrator prevents refresh storms during concurrent user activity:

```javascript
// Scenario: 10 users edit transactions simultaneously
// Each calls scheduleAggregationRefresh()
// Result: 1 refresh at the end of the coalescing window (not 10)

// Behind the scenes:
let refreshInFlight = false;
let refreshQueued = false;

// First call:
refreshInFlight = true; // Lock acquired
// ... refresh runs ...
refreshInFlight = false; // Lock released

// If calls arrived during refresh:
if (refreshQueued) {
  refreshQueued = false;
  // Start one deferred rerun after 500 ms
}
```

## Performance Benefits

| Query Type      | Without MV | With MV |
| --------------- | ---------- | ------- |
| Monthly summary | ~500ms     | ~5ms    |
| Category totals | ~800ms     | ~3ms    |
| Daily cashflow  | ~400ms     | ~4ms    |

## Indexes

Each view has a unique index for concurrent refresh support:

```sql
CREATE UNIQUE INDEX mv_monthly_summary_idx
ON mv_monthly_summary (month_start, currency, category_id_key);
```

## Call-Site Patterns

### After Bulk Import

```javascript
import {
  clearForecastMcCaches,
  scheduleMaterializedViewRefresh,
} from "./services/aggregationRefresh.js";

// In import service, after all transactions inserted:
await reconcileTransfers();
await clearForecastMcCaches();
scheduleMaterializedViewRefresh();
// The response may now return; the MV rebuild is asynchronous.
```

### After Single-Row Mutation

```javascript
import { scheduleAggregationRefresh } from "./services/aggregationRefresh.js";

// In transaction route handler:
app.patch("/api/transactions/:id", async (req, res) => {
  const updated = await transactionService.update(req.params.id, req.body);

  // Schedule debounced refresh (doesn't block response)
  scheduleAggregationRefresh();

  res.json(updated);
});
```

### Cron-Based Safety Refresh (Optional)

For additional safety, schedule a full refresh nightly:

```javascript
// In a cron job or scheduled task:
setInterval(
  async () => {
    logger.info("Running nightly aggregation refresh");
    await refreshAggregations();
  },
  24 * 60 * 60 * 1000,
);
```

## Best Practices

### For Materialized Views

1. **Use for read-heavy queries** — Ideal for dashboard aggregations
2. **Balance freshness vs. performance** — Don't refresh too frequently; use debounce for single-row edits
3. **Use unique indexes** — Required for concurrent refresh; prevents duplicate rows
4. **Monitor refresh times** — Long refreshes may indicate need for indexing on source tables
5. **Set scope appropriately** — e.g., `mv_monthly_summary` retains recent months, while all-time requests use live SQL
6. **Understand scope limitations** — `mv_monthly_summary` and `mv_cashflow_daily` retain bounded recent windows, while `mv_category_totals` is all-time. Queries requesting `allTime=true` bypass the bounded monthly-summary fast path and use live SQL.

### For Trigger-Maintained Tables

1. **Never call refresh from app code** — Triggers maintain these automatically
2. **Document in code** — Mark aggregates with a comment such as `// Maintained by agg_split_outstanding triggers`
3. **Verify trigger firing** — If aggregates look stale, check that triggers are enabled: `SELECT * FROM pg_trigger WHERE NOT tgisinternal`
4. **Plan for trigger latency** — Row-level triggers add ~1ms per mutation; acceptable for single-row edits, noticeable during bulk operations (mitigate with CONCURRENTLY refreshes post-import)

> [!warning] Do Not Manually Update Aggregates
> Never UPDATE or INSERT directly into `agg_split_outstanding`. Its triggers are the source of truth, and direct updates will be overwritten on the next mutation.

## Timezone Awareness

Materialized views aggregate the canonical `transactions.date` DATE column. Timestamp-based application queries follow [[docs/adr/009-timezone-policy|ADR-009]] before values reach that date boundary.

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
- **Migrations:**
  - [[alembic/legacy_versions/0026_finance_aggregations.py|0026_finance_aggregations.py]] (legacy, archived)
  - [[alembic/versions/0035_add_recipient_aggregations.py|0035_add_recipient_aggregations.py]] (historical Phase 1 baseline)
  - [[alembic/versions/0080_drop_agg_recipient_totals.py|0080_drop_agg_recipient_totals.py]]
  - [[alembic/versions/0082_drop_mv_bank_balances.py|0082_drop_mv_bank_balances.py]]
