---
title: Materialized Views & Aggregation Strategy
type: performance
status: active
date: 2026-11-03
updated: 2026-11-03
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
    migration-0094,
    adr-068,
  ]
description: Current SQLite summary tables (the former PostgreSQL materialized views) and trigger-maintained tables for dashboard aggregation, including the retired recipient, bank-balance, and daily-cashflow caches.
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
    "apps/node-backend/src/services/aggregationRefresh.ts",
    "apps/node-backend/src/services/materializedViewService.ts",
    "db/migrations/0001_baseline.sql",
  ]
---

# Materialized Views & Aggregation Strategy

Vision uses its SQLite database as the **single aggregation caching tier** via two complementary strategies: **Materialized Views** (on-demand refresh) and **Trigger-Maintained Tables** (real-time maintenance). This eliminates the need for Redis or in-process caches.

> [!note] Summary tables since ADR-263
> SQLite has no materialized views. Since [[docs/adr/263-sqlite-replaces-postgresql|ADR-263]], `mv_monthly_summary` and `mv_category_totals` are ordinary tables created by the baseline migration. The backend refills them from their defining `SELECT` statements. This page keeps the name "materialized view" because the code and the `mv_` prefix still use it.

See [[docs/adr/010-phase1-aggregation-strategy|ADR-010]] for the full architecture decision and rationale.

## Overview

### Two Maintenance Strategies

| Strategy                      | Use Case                                                             | Maintenance                       | Latency   | Examples                                                                                                                                                           |
| ----------------------------- | -------------------------------------------------------------------- | --------------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Materialized Views**        | Expensive temporal aggregates (monthly rollups, category breakdowns) | On-demand refresh after mutations | ~50–150ms | `mv_monthly_summary`, `mv_category_totals` (`mv_recipient_monthly`, `mv_bank_balances`, and `mv_cashflow_daily` were dropped after their last readers disappeared) |
| **Trigger-Maintained Tables** | Real-time aggregates requiring consistency with source tables        | Automatic via row-level triggers  | <1ms      | `agg_split_outstanding` (`agg_recipient_totals` was dropped in 0080)                                                                                               |

## Materialized Views in Vision

### mv_monthly_summary

Pre-computes monthly income, spending, and net totals by category for the last 12 months.

```sql
INSERT INTO mv_monthly_summary (...)
SELECT
  date_trunc('month', t.date) AS month_start,
  date_part('month', t.date) AS month,
  date_part('year', t.date) AS year,
  t.currency,
  count(*) AS transaction_count,
  dec_sum(CASE WHEN dec_sign(t.amount) >= 0 THEN t.amount ELSE 0 END) AS total_income,
  dec_sum(CASE WHEN dec_sign(t.amount) < 0 THEN t.amount ELSE 0 END) AS total_spending,
  dec_sum(t.amount) AS net_amount,
  c.id AS category_id,
  COALESCE(c.path_name, 'UNCATEGORISED') AS category_name
FROM transactions t
LEFT JOIN categories c ON ...
WHERE t.is_active = 1 AND t.is_transfer = 0
  AND t.date >= add_months(date_trunc('month', today()), -12)
GROUP BY ...
```

Money columns are decimal text, so the sums use `dec_sum` and the sign test uses `dec_sign`. See [[docs/reference/sqlite-sql-dialect|SQLite SQL dialect]] for these functions.

**Fast Path (Recent Months Only):**

`getMonthlyFinancialSummary()` in `infoRepositoryMonthly.ts` uses a fast-path optimization to read from `mv_monthly_summary` when all of the following conditions are met:

- `allTime=false` (default; requesting recent months only, not full history)
- No category exclusions (`excluded_category_ids` is empty)
- No recipient exclusions (`excluded_recipient_ids` is empty)
- The summary table is available (it exists and holds rows)

When all conditions are true, the query skips live SQL and returns aggregated data directly from the summary table. **When `allTime=true`, the fast path is always bypassed** — the method executes live SQL against full transaction history to ensure complete all-time data, since MVs only retain recent months (12–24 months).

See [[apps/node-backend/src/repositories/infoRepositoryMonthly.ts]] for the condition. `mvAvailable()` in `infoRepositoryHelpers.ts` probes the table with `SELECT 1 ... LIMIT 1` and caches the answer for 60 seconds.

---

### mv_category_totals

All-time category totals for quick category breakdowns.

**Data retained:** All-time  
**Ordering:** By transaction count descending

---

### mv_cashflow_daily — DROPPED (September 2026, migration 0094)

> [!warning] Removed
> `mv_cashflow_daily` was dropped by migration `0094_drop_mv_cashflow_daily.py`. **Do not reference this view in new code.**

The seven-month daily projection had no application readers, but was still created, indexed, analyzed, and refreshed after every relevant mutation. Current cash-flow charts use live repository queries and the dedicated forecast cache tables. The downgrade recreates the historical view with no data for rollback only.

---

### mv_bank_balances — DROPPED (July 2026, migration 0082)

> [!warning] Removed
> `mv_bank_balances` was dropped by migration `0082_drop_mv_bank_balances.py`. **Do not reference this view in new code.**

The view held all-time totals per account and currency, but application code had no readers while every transaction mutation paid to refresh it. Its simple `SUM(amount)` also omitted opening-balance anchors and could not represent the live account-balance contract. Current account balances are computed from the ledger and anchors through `accountBalanceSql.ts`.

The migration downgrade recreates the historical `(account_id, currency)` view with no data for rollback only; it does not make the view part of the current runtime.

---

### Phase 1 Views (Aggregation Refactor)

#### mv_recipient_monthly — DROPPED (June 2026, ADR-068)

> [!warning] Removed
> `mv_recipient_monthly` was dropped by migration `0038_drop_mv_recipient_monthly.py`. **Do not reference this view in new code.**

**Reason:** The view was never read by application code after the trigger-maintained `agg_recipient_totals` table was introduced. It added write-amplification (every transaction mutation triggered a concurrent MV refresh) with no query serving it. The `aggregationRefresh.ts` service no longer refreshes it.

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

- `trg_split_outstanding_sync__insert`, `__update`, and `__delete` on `transaction_splits`
- `trg_split_payment_outstanding_sync__insert`, `__update`, and `__delete` on `split_payments`

**Recomputes:** `outstanding = original_amount - SUM(split_payments.amount)`, written with `dec_sub`, `dec_sum`, and `vision_numeric(..., 18, 4)`

**Use case:** Owed-balance endpoint (Phase 4), dashboard balance widget

**Example:** When a split payment is recorded:

```typescript
// App code does nothing special — triggers handle it:
await db.insertInto("split_payments").values({ split_id, amount /* ... */ }).execute();
// Automatically: agg_split_outstanding.outstanding_amount updated in <1ms
```

---

## Refresh Strategy

Application mutation refreshes are orchestrated through **`aggregationRefresh.ts`**. Startup and explicit maintenance may call `materializedViewService` directly.

### Explicit Full Refresh (Maintenance)

Explicit maintenance that must wait for current projections can trigger a full refresh:

```javascript
import { refreshAggregations } from "./services/aggregationRefresh.ts";

// Explicit maintenance operation:
await refreshAggregations();
// Refills the two summary tables, then clears forecast caches.
```

**What it does:**

- Delegates the two current summary tables (`mv_monthly_summary`, `mv_category_totals`) to `materializedViewService.refreshMaterializedViews()`
- `mv_recipient_monthly` is no longer refreshed — it was dropped in migration `0038` (June 2026, ADR-068)
- No-op for trigger-maintained tables (they update automatically)

### Import Completion

An import does not await the full materialized-view scans. After transfer reconciliation, it awaits both attempts made by `clearForecastMcCaches()` and calls `scheduleMaterializedViewRefresh()` once. Each invalidation failure is logged and non-fatal, so the response confirms durable canonical rows and attempted forecast-cache invalidation, while MV-backed monthly and category projections remain eventually consistent until the scheduled refresh completes.

The materialized-view scheduler uses a five-second trailing debounce and a ten-second maximum wait for a continuous burst. Refresh execution time and a possible wait behind an in-flight refresh are additional. A refresh clears the process statistics cache before it starts. A successful refresh clears it again after the new rows commit, so a request during the refresh cannot keep the old projection.

Startup fills empty summary tables, makes sure their unique indexes exist, and refreshes them after Express begins listening. View preparation and transfer backfill settle before one refresh is requested. A successful late backfill still refreshes existing views if preparation failed; that preparation failure remains reported. A rejected backfill is logged and does not prevent prepared views from refreshing. The boot trace records these separately as `materialized_views_create`, `materialized_views_indexes`, and `materialized_views_refresh`; `/health/detailed` reports the combined warmup result.

### Debounced Refresh (Single-Row Mutations)

After editing or deleting a single transaction:

```javascript
import { scheduleAggregationRefresh } from "./services/aggregationRefresh.ts";

// In route handler after mutation:
scheduleAggregationRefresh();
// Coalesces rapid changes into one MV refresh.
```

**Behavior:**

- The MV rebuild uses a five-second trailing debounce and a ten-second burst cap
- The forecast-cache clear uses its own one-second trailing debounce
- Triggers fire immediately (trigger-maintained tables stay in sync)
- MV refresh happens once per debounce window

### Refill in One Transaction

A refresh deletes the rows of both summary tables and inserts them again with `INSERT ... SELECT`. Both refills run in one `withTransaction()` call, which is a `BEGIN IMMEDIATE` transaction on the single writer connection.

- Readers use the reader connection. They see the old rows until `COMMIT` and the new rows after it. They never see an empty table.
- Both tables describe the same ledger state, because they change in the same transaction.
- A failed refill rolls the whole refresh back. The tables keep their previous rows, and the error is logged.
- A refresh waits for the write lock like any other write. See [[docs/adr/263-sqlite-replaces-postgresql|ADR-263]] for the single-writer model.

On a first launch the tables are empty. `createMaterializedViews()` fills each empty table in one write transaction and runs `ANALYZE` on both tables afterwards. A table that already holds rows keeps them until the refresh replaces them.

### Request Coalescing

The orchestrator prevents refresh storms during concurrent user activity:

```javascript
// Scenario: 10 users edit transactions simultaneously
// Each calls scheduleAggregationRefresh()
// Result: 1 refresh at the end of the coalescing window (not 10)

// Behind the scenes:
let refreshInFlight = null; // Shared Promise while a refresh is active
let refreshQueued = false;

// First call:
refreshInFlight = refreshPromise; // All callers observe the same work
// ... refresh runs ...
refreshInFlight = null; // Work settled

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

> [!note] Measured on PostgreSQL
> These timings come from the PostgreSQL build, before [[docs/adr/263-sqlite-replaces-postgresql|ADR-263]]. Do not read them as SQLite figures.

## Indexes

Each summary table has a unique index that refuses duplicate rows. The baseline migration creates both indexes. Startup runs `CREATE UNIQUE INDEX IF NOT EXISTS` again, so an index dropped by hand comes back.

```sql
CREATE UNIQUE INDEX idx_mv_monthly_summary
ON mv_monthly_summary (month_start, currency, category_id_key);

CREATE UNIQUE INDEX idx_mv_category_totals
ON mv_category_totals (category_id, currency);
```

## Call-Site Patterns

### After Bulk Import

```javascript
import {
  clearForecastMcCaches,
  scheduleMaterializedViewRefresh,
} from "./services/aggregationRefresh.ts";

// In import service, after all transactions inserted:
await reconcileTransfers();
await clearForecastMcCaches();
scheduleMaterializedViewRefresh();
// The response may now return; the MV rebuild is asynchronous.
```

### After Single-Row Mutation

```javascript
import { scheduleAggregationRefresh } from "./services/aggregationRefresh.ts";

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
3. **Use unique indexes** — They prevent duplicate rows
4. **Monitor refresh times** — Long refreshes may indicate need for indexing on source tables
5. **Set scope appropriately** — e.g., `mv_monthly_summary` retains recent months, while all-time requests use live SQL
6. **Understand scope limitations** — `mv_monthly_summary` retains a bounded recent window, while `mv_category_totals` is all-time. Queries requesting `allTime=true` bypass the bounded monthly-summary fast path and use live SQL.

### For Trigger-Maintained Tables

1. **Never call refresh from app code** — Triggers maintain these automatically
2. **Document in code** — Mark aggregates with a comment such as `// Maintained by agg_split_outstanding triggers`
3. **Verify trigger firing** — If aggregates look stale, check that the triggers exist: `SELECT name FROM sqlite_schema WHERE type = 'trigger' AND tbl_name IN ('transaction_splits', 'split_payments')`
4. **Plan for trigger latency** — Row-level triggers add work to every mutation. This is acceptable for single-row edits and noticeable during bulk operations

> [!warning] Do Not Manually Update Aggregates
> Never UPDATE or INSERT directly into `agg_split_outstanding`. Its triggers are the source of truth, and direct updates will be overwritten on the next mutation.

## Timezone Awareness

Summary tables aggregate the canonical `transactions.date` DATE column. Timestamp-based application queries follow [[docs/adr/009-timezone-policy|ADR-009]] before values reach that date boundary.

The monthly window starts from `today()`. This registered SQL function returns the current date in the backend process's local time zone.

```sql
-- CORRECT: group the DATE column and anchor the window on today()
date_trunc('month', t.date)
add_months(date_trunc('month', today()), -12)

-- WRONG: AT TIME ZONE does not exist in SQLite, and date('now') uses UTC
date_trunc('month', t.date AT TIME ZONE 'Europe/Brussels')
date('now')
```

## See Also

- [[docs/adr/010-phase1-aggregation-strategy|ADR-010: Aggregation Strategy]] — Full architecture decision
- [[docs/adr/009-timezone-policy|ADR-009: Timezone Policy]] — Timezone bucketing strategy
- [[docs/reference/data-model|Data Model Reference]] — Aggregation entity definitions
- [[docs/performance/index]] — Performance Documentation Index
- [[docs/reference/database-triggers|Database Triggers]] — All trigger definitions
- [[docs/adr/263-sqlite-replaces-postgresql|ADR-263]] — SQLite replaces PostgreSQL; summary tables replace materialized views
- [[apps/node-backend/src/services/aggregationRefresh.ts|aggregationRefresh.ts]] — Orchestrator source
- **Migrations:**
  - `0026_finance_aggregations` (legacy, archived)
  - `0035_add_recipient_aggregations` (historical Phase 1 baseline)
  - `0080_drop_agg_recipient_totals`
  - `0082_drop_mv_bank_balances`
