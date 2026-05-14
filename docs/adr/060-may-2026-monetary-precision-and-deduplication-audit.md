---
title: ADR-060 - May 2026 Monetary Precision & Deduplication Audit
type: adr
status: Accepted
date: 2026-05-14
tags: [adr, backend, precision, decimal, deduplication, import, portfolio, performance, bug-fixes, may-2026-audit]
description: Systematic audit extending Decimal.js enforcement to portfolio aggregation, import precision, and database deduplication; adds tx_hash UNIQUE constraint for race-safe dedup
aliases: [adr-060, may-2026-audit, monetary-precision-audit, tx-hash-dedup]
---

# ADR-060: May 2026 Monetary Precision & Deduplication Audit

## Status
Accepted

## Date
2026-05-14

## Context

The May 2026 curated TODO audit identified gaps in monetary precision enforcement and import deduplication robustness:

1. **Portfolio aggregation drift** — FX conversions across 20+ stock lots were using native JavaScript number arithmetic, accumulating ±0.01 EUR phantom balances
2. **Import running balance precision** — CSV streaming imports held cumulative balances as native JS number, losing precision over long imports
3. **Cash flow forecast accumulation** — Long forecasts with multi-day splits accumulated rounding errors in cumulative balance
4. **Import deduplication races** — Intra-batch and inter-batch duplicates relied on legacy bank-specific tables without canonical UNIQUE constraint
5. **Timezone bucketing inconsistency** — Date-based aggregations were not consistently using APP_TIMEZONE for all month/day boundary calculations

## Decision

### 1. Extend Decimal.js to All Monetary Aggregation

All monetary accumulation paths now route through Decimal.js:

- **Portfolio**: `portfolioSummaryService.js` per-investment accumulators, FX multiplier aggregation; `snapshotBuilder.js` cumulative invested, total value; `portfolioMath.js` accrued interest and metrics
- **Import pipeline**: `streamingImportService.js`, `importPipeline/adapters/_shared.js` (Belfius, Revolut, SABB) running-balance accumulation; `importPipeline/commit.js` transaction INSERT with Decimal amounts
- **Cash flow forecast**: `cashflowForecast.js`, `calculations/aggregation/cashflowForecast.js` cumulative net flows, per-category splits
- **Exports & calculations**: `transactionExport.js` running balance, `calculations/recurrence.js` allocation per day, `aiChat/tools/tax.js` tax bracket accumulation

### 2. Add `multiply()` and `divide()` Helpers to money.js

Extended `apps/node-backend/src/lib/money.js` with:

```js
export function multiply(a, b)    // Decimal × Decimal → Decimal
export function divide(a, b)      // Decimal ÷ Decimal → Decimal (returns to 2 DP)
export function roundMoney(v, places=2)  // Round to N decimal places (banker's rounding)
```

**Usage:**
- `multiply(fxRate, amount)` for currency conversions (FX multiplier, portfolio aggregation)
- `divide(totalAmount, units)` for per-unit costs, per-row allocation (split distribution, fee sharing)
- `roundMoney(value, 8)` for extended precision (e.g., `belgianInflationService.js` now rounds `monthly_rate` to 8 DP before DB persist)

### 3. Frontend Decimal Module

Added `apps/frontend/src/lib/decimal.ts` mirroring backend `money.js` for form parsing and display calculations. Frontend uses Decimal for:
- `SplitTransactionDialog.tsx`: Split amount input validation
- `usePortfolioCalculations.ts`: Frontend aggregation hooks (fixes `totalSellProceeds` scaling bug via Decimal division)

### 4. Transaction Hash Deduplication (tx_hash)

**Migration 0036** adds canonical deduplication to the `transactions` table:

```sql
ALTER TABLE transactions ADD COLUMN tx_hash TEXT;
CREATE UNIQUE INDEX uniq_transactions_tx_hash 
  ON transactions (tx_hash) WHERE tx_hash IS NOT NULL;
```

**Hash computation:** SHA-256 of `date|amount|recipient|memo|bank_account` (matches legacy bank-specific dedup).

**Race-safe conflict handling:**
- `INSERT ... ON CONFLICT (tx_hash) WHERE tx_hash IS NOT NULL DO NOTHING RETURNING id`
- Concurrent imports no longer need cross-import duplicate checking; per-batch intra-dedup via in-memory Set tracks committed hashes
- Validation phase marks second rows with identical `tx_hash` as `duplicate` in the same batch
- `prepareImport` now requires `unresolved > 0` to trigger review (blank-recipient batches no longer auto-commit)

**Benefits:**
- Idempotent transaction INSERT across retries (same hash → same row returned)
- Database enforces uniqueness; no application-level dedup race conditions
- Legacy bank-specific raw tables preserved for audit trail but superseded by canonical `tx_hash` enforcement

### 5. Timezone Consistency (ADR-009 Enforcement)

All date bucketing now strictly uses APP_TIMEZONE:
- `cashflowForecast.js`: Month windows anchored to APP_TIMEZONE via `toAppTz()` / `appDateStringToUtc()`
- `infoRepositoryPlanned.js`: Month boundaries derived in APP_TIMEZONE
- `recurringDetectionService.js`: Recurrence next-date advanced in UTC, bucketed via APP_TIMEZONE
- `portfolioMath.js`: `calendarDaysBetween()` helper counts whole APP_TIMEZONE days (not float averages)
- SQL aggregations: `date_trunc(...) AT TIME ZONE 'Europe/Brussels'` (parametrized at migration time)

### 6. Database Connection Robustness

**Connection**:
- `query()` retry restricted to read-only statements; mutating statements fail-fast
- `withTransaction()` destroys client if ROLLBACK throws (prevents stale connection)

**Graceful shutdown**:
- `main.js` `shutdown()` calls `server.close()` to drain in-flight requests before exit
- Double-signal guard + 10-second force-exit timeout

**Repository improvements**:
- `investmentRepository.updatePrice()` checks schema before update (inheritance-aware)
- `deduplication.js` `isDuplicate()` uses LEFT JOIN + COALESCE instead of subquery for recipient matching
- `splitRepository.js` auto-settle compares ROUND(SUM, 2) >= ROUND(ts.amount, 2) for exact 2-DP matching
- `recipientBankAccountRepository.createOrGet()` transactional insert + unset-siblings (race-safe)
- `transactionRepository.js` `running_balance` window now PARTITION BY `bank_account` (per-account balance, not global)

### 7. API & Route Improvements

- **rateLimiter.js**: Trusts `X-Forwarded-For` from loopback + private/link-local ranges (docker bridge)
- **materializedViewService.js**: Non-fallback-eligible refresh errors re-thrown (fail-fast)
- **transactionExport.js**: Streaming respects backpressure (`writeWithBackpressure()`)
- **attachments.js**: `GET /:id/download` callback → clean 404 for missing-on-disk files; `DELETE` file-removal logged (non-fatal)
- **routes/transactions.js** POST: Validates `recipient_id` is positive integer
- **routes/watchlist.js**, **routes/marketLookup.js**: Coercion helpers for query string safety (arrays no longer throw)
- **startup/warmup.js**: Scheduled tasks wrapped in `withInFlightGuard()` (no overlapping runs)

### 8. Charts & Frontend Correctness

- **LTTB downsample**: Backend + frontend tail-bucket average now counts actual iterations
- **portfolioMath.computeHeatmap()**: Only computes returns between consecutive calendar months
- **aiChat/tools/**: Range upper bounds set to end-of-day; `getRecipientInsights` adds `truncated` meta flag at 50k-row scan cap
- **useConfirmDialog.tsx**: Stable ConfirmDialog identity (live state via ref)
- **useCountUp.ts**: Animates from currently-visible value, not previous target
- **VirtualDataTable.tsx** / **DataTable.tsx**: Stable row keys, pagination bounds, search-sync guard, column-width re-seeding
- **ChatMessageList.tsx**: Auto-scroll effect keys on streaming-tool content length
- **WatchlistChartDialog.tsx**: Per-item state reset on item change
- **currency.ts** `formatAmountWithSymbol()`: Honors user's decimal places + locale grouping

### 9. Import Pipeline Precision

- **parseDecimalSafe()** in adapters `_shared.js` (reused by all adapters: Vision, Revolut, SABB, Belfius)
- Belfius, Revolut, SABB adapters accumulate running balances as Decimal throughout streaming parse
- `streamingImportService.js` per-import recipient cache (performance)
- `recipientPatternService.previewPatternMatches()` regex path capped at 10k rows; returns `truncated` flag

### 10. Deferred Product Decisions (Left As-Is)

Not included in this audit (require product decisions):
- ~~`KAU_EUR`→`KAU_USD` historical FX conversion~~ **COMPLETED (May 2026, follow-up)**
- `portfolioMath.calculateCostBasis()` weighted-avg vs FIFO/LIFO discrepancy (accounting-policy decision)
- `refreshCashflowForecastMc.js` `includeBacktest: true` (docstring corrected, behavior unchanged)

**Follow-up (May 2026):** Kinesis EUR-denominated investments now fully convert USD prices to investment currency. Live prices use current FX rate; historical series use per-date historical rates via bulk-loaded rate index (single query, no per-date round-trips). EUR-denominated Kinesis investments store currency-native prices in both `asset_price_history` and live-price endpoints. See [[docs/integrations/kinesis-price-provider|Kinesis Price Provider]] for implementation details.

## Consequences

### Positive

- **Eliminated monetary drift** — All accumulations (portfolio FX, import running balance, forecast cumulative, split allocation) now exact to 2 DP via Decimal.js
- **Race-safe import deduplication** — `tx_hash` UNIQUE constraint + ON CONFLICT is idempotent; concurrent imports cannot create duplicates
- **Consistent timezone bucketing** — All date-based business logic uses APP_TIMEZONE; month/day boundaries match user expectations
- **Database robustness** — Transaction retry safety, graceful shutdown, per-account balance isolation, inheritance-aware queries
- **Frontend correctness** — Stable component identities, deterministic animations, proper backpressure handling, accessibility improvements
- **Performance wins** — Per-import recipient cache, single-query pagination, duplicate-dedup single-pass scan, LTTB tail-bucket accuracy

### Negative

- **Code verbosity** — More explicit `toDecimal()`, `multiply()`, `divide()` calls throughout codebase (intentional for correctness)
- **Migration required** — New `tx_hash` column + UNIQUE index requires migration; legacy dedup still works but canonical enforcement is new
- **Historic data** — Pre-existing phantom balances in splits/aggregates now exact; no retroactive data correction (future edits use new precision)

### Neutral

- **Decimal.js footprint** — ~50kb gzipped; acceptable given correctness gains
- **SQL complexity** — More explicit timezone wrapping in aggregations; documented in MV definitions

## Implementation

**Completed May 2026:**

1. ✅ Extended `money.js`: `multiply()`, `divide()`, `roundMoney()` exported
2. ✅ Portfolio aggregation: `portfolioSummaryService.js`, `snapshotBuilder.js`, `portfolioMath.js` all route through Decimal
3. ✅ Import precision: All adapters + `streamingImportService.js` + `importPipeline/commit.js` use Decimal
4. ✅ Cash flow precision: `cashflowForecast.js`, `calculations/aggregation/cashflowForecast.js`, `calculations/recurrence.js` all route through Decimal
5. ✅ Frontend `decimal.ts` mirroring backend patterns
6. ✅ Transaction `tx_hash` column + UNIQUE index (migration 0036)
7. ✅ Import `prepareImport` now requires `unresolved > 0` for review
8. ✅ Timezone consistency audit: `cashflowForecast.js`, `infoRepositoryPlanned.js`, `recurringDetectionService.js`, `portfolioMath.js` all use APP_TIMEZONE
9. ✅ Database robustness: graceful shutdown, connection retry safety, per-account balance isolation
10. ✅ API improvements: rate limiter, error handling, backpressure, coercion safety
11. ✅ Frontend correctness: component identity, animation timing, table rendering, accessibility

**Tests:** 80%+ coverage maintained; no test regressions.

**Rollout:** Applied to main branch; no feature flags (all improvements are internal correctness fixes).

## Rollback

If critical issues arise:
1. `tx_hash` column can be left NULL (constraint allows NULL values via WHERE clause)
2. `divide()`, `multiply()` functions remain backward-compatible; any caller can switch to native arithmetic if needed
3. Timezone changes are in SQL aggregations; reverting MV definitions removes `AT TIME ZONE` wrapping

## Related

- [[docs/adr/009-timezone-policy|ADR-009: Timezone Policy]] — APP_TIMEZONE enforcement
- [[docs/adr/021-decimal-arithmetic-for-monetary-values|ADR-021: Decimal Arithmetic for Monetary Values]] — Phase 9 decimal foundation
- [[docs/adr/046-import-review-category-assignment|ADR-046: Import Review & Category Assignment]] — Import pipeline architecture
- [[docs/reference/code-patterns#money-utility-pattern|Code Patterns: Money Utility]]
- [[docs/features/import|Feature: CSV Import & Deduplication]]
- [[docs/features/portfolio|Feature: Portfolio & Investments]]
- [[docs/features/cash-flow-forecast|Feature: Cash Flow Forecast]]
