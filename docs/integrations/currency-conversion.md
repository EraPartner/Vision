---
title: Currency Conversion
type: integration
status: active
date: 2026-04-25
updated: 2026-08-26
tags: [integration, currency, exchange-rates, phase-0, phase-1, phase-3-1, offline-resilience, network-reachability, startup-optimization, historical-rates, ecb-full-history, purchase-date-rates, fx-attribution, adr-074]
description: Multi-currency support with automatic conversion to target currencies using ECB and supplementary exchange rates, including date-aware historical conversion and batch grouped conversion (Phase 3.1+). Startup FX warmup is skipped when offline (2026-05-03). 2026-06-11 (ADR-074): ECB full-history tier (daily since 1999), on-or-before weekend convention, one-time repair of fabricated old rates, and bulk-stamp of fx_rate_to_eur on non-EUR portfolio transactions.
related_code: ["apps/node-backend/src/services/currency/rateFetcher.js", "apps/node-backend/src/services/currency/currencyConversionService.js", "apps/node-backend/src/repositories/infoRepositoryHelpers.js", "apps/node-backend/src/lib/network.js"]
---

# Currency Conversion

Vision provides multi-currency support with conversion to EUR or another requested target currency using official exchange rates.

## Overview

The currency conversion service handles all currency-related operations, including:
- Fetching live exchange rates
- Converting transaction amounts to a requested target currency
- Handling currencies not covered by ECB
- Preserving historical exchange-rate rows while updating the latest per currency
- Date-aware historical lookup for portfolio conversion (exact date, otherwise nearest stored date)

## Data Sources

### Tier 1: ECB Daily Feed (Primary, live rates)

- **URL**: `https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml`
- **Update frequency**: Daily (~16:00 CET)
- **Currencies**: ~30 major currencies
- **Cache TTL**: 24 hours in-memory

### Tier 2: ECB Full History Feed (Historical, 2026-06-11 — ADR-074)

- **URL**: `https://www.ecb.europa.eu/stats/eurofxref/eurofxref-hist.xml`
- **Coverage**: Daily rates since 1999-01-04
- **Cache TTL**: 24 hours in-memory
- **Lookup convention**: **on-or-before** — a Saturday or Sunday uses Friday's close; lookups never advance to a future trading day
- **Role**: Provides transaction-date rates for `getRateToEurForDate` when the target date is older than the 90-day feed window; results are persisted to `exchange_rates` and never re-fetched once stored

> [!info] Weekend and holiday convention
> The on-or-before convention applies throughout: if the exact date is missing (weekend, bank holiday, ECB closure), the most recent prior trading day's rate is used. This matches how the ECB's own API behaves and avoids look-ahead bias.

### Tier 3: Supplementary — Open Exchange Rates API

- **URL**: `https://open.er-api.com/v6/latest/EUR`
- **Coverage**: ~150 currencies
- **Use case**: Currencies not covered by ECB (AED, SAR, KWD, etc.)

**Priority**: ECB rates always take precedence over supplementary source

### Sanity Bounds (2026-04-25)

Both ECB XML and Open Exchange Rates API feed parsers now validate exchange rates before persisting:

- **Range**: Rates must be in the open interval `(0.0001, 100000)` — allows realistic forex ranges while rejecting pathological values
- **Finiteness**: Rate values must pass `Number.isFinite()` — rejects NaN, Infinity, and non-numeric values
- **Impact**: Prevents corrupted feed values (e.g., rate of `0` or `999999`) from being persisted to the `exchange_rates` table, which would corrupt all downstream conversions until manually cleared

Invalid rates are silently skipped during parsing; only valid rates are included in the response.

---

## Fallback Strategy

The service implements a multi-layer fallback:

1. **In-memory cache** - 24-hour TTL
2. **Database rates** - Stored in `exchange_rates` table
3. **Hardcoded constants** - Last resort fallback

For date-aware conversion requests, the service also opportunistically queries ECB's 90-day historical feed for exact-date matches before falling back to nearest stored database rates.

```
┌─────────────────────────────────────┐
│         Request                      │
└─────────────────┬───────────────────┘
                  │
          ┌───────▼────────┐
          │ Memory Cache   │
          │ (24h TTL)      │
          └───────┬─────────┘
                  │ miss
          ┌───────▼────────┐
          │  Database      │
          └───────┬─────────┘
                  │ miss
          ┌───────▼────────┐
          │ Hardcoded      │
          │ Fallback       │
          └────────────────┘
```

---

## Supported Currencies

### ECB Currencies (Primary)

| Code | Currency |
|------|----------|
| EUR | Euro |
| USD | US Dollar |
| GBP | British Pound |
| CHF | Swiss Franc |
| JPY | Japanese Yen |
| SEK | Swedish Krona |
| NOK | Norwegian Krone |
| DKK | Danish Krone |
| PLN | Polish Zloty |
| CZK | Czech Koruna |
| HUF | Hungarian Forint |
| RON | Romanian Leu |
| TRY | Turkish Lira |
| AUD | Australian Dollar |
| CAD | Canadian Dollar |
| CNY | Chinese Yuan |
| INR | Indian Rupee |
| BRL | Brazilian Real |

### Supplementary Currencies

| Code | Currency |
|------|----------|
| AED | UAE Dirham |
| SAR | Saudi Riyal |
| KWD | Kuwaiti Dinar |
| QAR | Qatari Riyal |
| BHD | Bahraini Dinar |
| OMR | Omani Rial |
| PKR | Pakistani Rupee |
| EGP | Egyptian Pound |
| NGN | Nigerian Naira |
| MAD | Moroccan Dirham |
| KES | Kenyan Shilling |

---

## API Usage

### Get Exchange Rates

```
GET /api/info/exchange-rates
```

Response:
```json
{
  "source": "ecb",
  "timestamp": "2025-03-18T12:00:00Z",
  "rates": {
    "EUR": 1.0,
    "USD": 0.917,
    "GBP": 1.176
  }
}
```

### Force Refresh

```
POST /api/info/exchange-rates/refresh
```

---

## Performance

- **Cache hit**: < 5ms
- **Cache miss + DB**: ~50ms
- **API fetch**: ~500ms

---

## Implementation Details

### Canonical Import Path (Phase 0+)

**New code should import directly:**

```javascript
import {
  convertRowsToEur,
  convertToCurrency,
  warmCache,
  clearMemoryCache,
  backfillPortfolioHistoricalRates,
  FALLBACK_RATES,
} from './services/currency/currencyConversionService.js';
```

This is the canonical direct path (moved from `services/calculations/currency.js` in Phase 0). The service is the **active implementation** for all currency conversion operations.

**Legacy import (removed):**
```javascript
// This path has been removed — use direct import above
import { convertToCurrency } from './services/calculations/currency.js';
```

### Cache Management

```javascript
// Cache TTL: 24 hours
const CACHE_LIFETIME_MS = 24 * 60 * 60 * 1000;
```

**Implementation Note:** In-memory cache (24h TTL) is the current caching strategy. Postgres-backed `exchange_rate_cache` table was planned for Phase 0 consolidation but is not yet implemented; in-memory rates remain standard.

### Batch Conversion

Convert multiple rows at once:

```javascript
import { convertRowsToEur } from './services/currency/currencyConversionService.js';

const converted = await convertRowsToEur(transactions, 'USD');
```

Date-aware conversion can be enabled for row sets that contain a date column:

```javascript
const converted = await convertRowsToEur(rows, 'USD', {
  useHistoricalRatesByDate: true,
  dateField: 'day'
});
```

### Batch Grouped Conversion (Phase 3.1+)

Convert N row groups in a single `convertRowsToEur()` call to eliminate redundant `exchange_rates` database queries:

```javascript
import { batchConvertGroupsWithHistoricalRateFallback } from './repositories/infoRepositoryHelpers.js';

// Merge multiple independent row groups (e.g., current balances + history)
// with a `_batchGroup` tag for later splitting
const groups = [
  { _batchGroup: 'current', currency: 'USD', amount: 5000, date: '2026-04-23' },
  { _batchGroup: 'current', currency: 'GBP', amount: 3000, date: '2026-04-23' },
  { _batchGroup: 'history', currency: 'USD', amount: 4500, date: '2026-04-01' },
  { _batchGroup: 'history', currency: 'GBP', amount: 2800, date: '2026-04-01' },
];

// Single batch conversion + single exchange_rates query
const converted = await batchConvertGroupsWithHistoricalRateFallback(
  groups,
  'EUR',
  'date' // dateField for historical lookup
);

// Split results back by _batchGroup
const currentConverted = converted.filter(r => r._batchGroup === 'current');
const historyConverted = converted.filter(r => r._batchGroup === 'history');
```

**Benefit**: Converts N independent row groups in 1 `exchange_rates` query instead of N queries.

**Example savings** (Phase 3.1 info endpoints):
- `getCashflowComparison`: Saved 3 redundant `exchange_rates` queries
- `getBankBalances`: Saved 1 redundant `exchange_rates` query

### Historical Rate Fallback Flag

When `useHistoricalRatesByDate: true` and the exact (or nearest) historical rate is unavailable for a row's date, the service falls back to the current in-memory rate and surfaces this in the conversion result:

```json
{
  "amount_eur": 92.15,
  "used_fallback_rate": true,
  "fallback_reason": "historical_rate_missing"
}
```

| Field | Type | Description |
|-------|------|-------------|
| `used_fallback_rate` | `boolean` | `true` when a fallback to current rates occurred |
| `fallback_reason` | `string` | Always `"historical_rate_missing"` when set |

A `WARN`-level log entry is also emitted: `Historical FX missing, falling back to current rate` with `{ currency, date }` metadata.

Callers (e.g. portfolio history aggregator) can expose these fields to the frontend so affected rows are clearly labeled. Rows where the rate resolved normally carry neither field.

**Cache invalidation after backfill:** `backfillPortfolioHistoricalRates()` calls `clearHistoricalCache()` after inserting new rates, ensuring the in-memory historical index reflects the newly stored rows on the next conversion.

#### Fallback Behavior (Fixed 2026-04-25)

`resolveRateWithFallback()` now correctly implements the fallback chain:

1. **EUR currency**: Always returns `{ rate: 1, fellBack: false }` (EUR has no FX rate)
2. **Current-rate mode** (`useHistoricalRatesByDate=false` or `rowDate` is null): Returns in-memory rate without warning
3. **Historical mode** with date present:
   - Try in-memory historical index (fastest)
   - Try ECB 90-day fetch + nearest-DB lookup via `getRate()`
   - Fall back to current rate only if historical source is unavailable
   - Emit `WARN` log + set `fellBack: true` only when fallback occurs
4. **No rate found anywhere** (historical and current rates both missing): Sets `fellBack: true` so the frontend fallback indicator displays correctly

**Previous bugs (fixed):**
- EUR rows incorrectly warned because EUR is filtered from `exchange_rates` saves
- Rows with `rowDate=null` always triggered warning path
- Short-circuit before ECB/DB fallback when historical index lacked currency
- When no rate was found in any source, `fellBack` was incorrectly set to `false` instead of `true`, preventing frontend fallback indicator display

---

### Sparse Historical Backfill (Portfolio)

- `backfillPortfolioHistoricalRates()` backfills only missing `(portfolio_transactions.currency, portfolio_transactions.date)` pairs (excluding EUR)
- Existing historical rows are preserved
- Backfill favors exact-date ECB data when available, then falls back to nearest local rate

### Full History Startup Backfill (ADR-074, 2026-06-11)

Three new startup phases run once (guarded by flags in `user_settings`):

| Phase | What it does | Guard flag |
|-------|-------------|------------|
| **One-time repair** | Identifies rows in `exchange_rates` that were previously written as nearest-rate guesses (before ADR-074) and overwrites them with correct ECB full-history values. Safe because no manual rate-entry path exists. | `fx_full_history_repair_done` |
| **Gap fill** | Fills any (currency, date) pairs missing from `exchange_rates` using the ECB full-history feed. Does **not** persist guessed/nearest rates — only exact-date or on-or-before confirmed ECB values. | Internal per-run tracking |
| **Bulk stamp** | Iterates all `portfolio_transactions` (including legacy `portfolio_transactions_base` layout) that have `currency ≠ EUR` and no `fx_rate_to_eur` set, and writes the on-or-before stored rate (≤7-day lookback). Never blocks on HTTP — uses only already-stored `exchange_rates` rows. | None (idempotent upsert) |

If the app starts offline, the repair and gap-fill phases are skipped (the `fx_full_history_repair_done` flag is not set), so they will retry on the next online startup.

### Transaction Write-Time Stamping (ADR-074)

When a portfolio transaction is created or edited without an explicit `fx_rate_to_eur` and `currency ≠ EUR`, the backend controller resolves the rate from the stored `exchange_rates` table using the on-or-before convention (≤7-day lookback) and stamps it on the row. The write path never makes an outbound HTTP call — it uses only already-persisted rows. If no suitable stored rate exists within 7 days, the field is left unset and `usedFallbackRate` will be `true` in summary responses.

Generic amount conversion:

```javascript
import { convertToCurrency } from './services/currency/currencyConversionService.js';

const amountInSar = await convertToCurrency(125, 'USD', 'SAR');
```

---

## Configuration

No configuration required - service auto-initializes on startup.

Startup triggers a background sparse historical backfill for portfolio transaction dates.

**Optional environment variables:**
- None currently required

---

## Error Handling

- **API failures**: Falls back to database, then hardcoded rates
- **Invalid source currencies**: Returns 1:1 passthrough amount
- **Invalid target currencies**: Falls back to EUR conversion behavior
- **Stale data**: Uses hardcoded fallback if all sources fail

**Startup Behavior When Offline (May 2026):**
During server startup, a network reachability probe determines if the host has internet connectivity. When offline is detected:
- **Exchange rate cache warmup skipped**: `warmExchangeRateCache()` is not called
- **Portfolio historical FX backfill skipped**: `backfillPortfolioHistoricalRates()` is not called
- **No API timeouts**: Avoids 5–15s hang on ECB/Open Exchange Rates APIs
- **Cached/DB fallback**: In-memory cache (24h TTL) + database → hardcoded rates
- **Faster readiness**: `/health/detailed` ready status reached ~15 seconds sooner

Scheduled 12h exchange rate refreshes also skip themselves when `isInternetReachable({ force: true })` returns false, avoiding unnecessary timeout delays.

---

## Use Cases

1. **Multi-currency transactions** - Track spending in original currency
2. **Target-currency reporting** - Normalize all amounts to the selected currency for analysis
3. **Investment tracking** - Convert foreign investments to home currency
4. **Tax reporting** - Required for EUR-based tax calculations

---

> [!info] Locked contracts (Phase 8)
> Currency round-trip correctness is pinned by [[apps/node-backend/tests/property/currencyRoundTrip.property.test.js]]. Bounded random amount + rate pairs must satisfy `convert(convert(x, A→B), B→A) ≈ x` within cent tolerance, and cross-rate composition `A→B→C` must equal the direct `A→C` conversion within the same tolerance. See [[docs/testing/testing#property-test-pattern-phase-8|Property Test Pattern]] and [[apps/node-backend/tests/golden/INVENTORY.md|Calculation Inventory]].

## Historical FX in Portfolio Snapshots (2026-05-29)

The portfolio snapshot builder (`snapshotBuilder.js`) owns a separate, lightweight historical FX lookup that it loads in bulk directly from the `exchange_rates` table (not through `currencyConversionService`). This is intentional: the snapshot builder walks every day from first transaction to today in a single pass, so it pre-loads the full rate history once per snapshot run rather than making per-row service calls.

Key differences from `currencyConversionService`:

| Concern | `currencyConversionService` | `snapshotBuilder` internal lookup |
|---|---|---|
| Data source | ECB + Open Exchange Rates → DB + in-memory cache | `exchange_rates` table only (bulk preload) |
| Lookup granularity | Per-conversion call | Binary-search in pre-sorted per-currency day arrays |
| Fallback | In-memory cache → hardcoded constants | Latest `is_latest` rate |
| Scope | All backend services | Snapshot day-walk only |

The `is_latest` rows in `exchange_rates` are the same rows consumed by `currencyConversionService`'s `warmCache()`, so the latest-day snapshot always uses the same rate as the live portfolio summary endpoint, ensuring the headline portfolio value reconciles between Net Worth and Portfolio Overview.

See [[docs/features/portfolio#historical-fx-in-snapshots-2026-05-29|Portfolio — Historical FX in Snapshots]] for the correctness implications on the invested cost-basis column.

## See Also

- [[docs/adr/074-fx-attribution-historical-rates|ADR-074: FX attribution with purchase-date rates]] — Decision record for full-history backfill and transaction-date semantics
- [[docs/reference/data-model#ExchangeRateCache]] - Database schema
- [[docs/performance/caching-strategies]] - Caching implementation
- [[docs/api/settings]] - Settings API
- [[docs/integrations/index]] - Integrations Index
- [[docs/reference/code-patterns#Filter Builder Pattern]] - Related Phase 0 patterns

Code links: [[apps/node-backend/src/services/currency/rateFetcher.js|Rate fetcher (ECB tiers)]], [[apps/node-backend/src/services/currency/currencyConversionService.js|Canonical implementation]], [[apps/node-backend/src/repositories/infoRepositoryHelpers.js|Batch grouped conversion (Phase 3.1)]], [[apps/node-backend/src/main.js]]
