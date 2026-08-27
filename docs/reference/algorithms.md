---
title: Algorithms & Data Structures
type: algorithm-doc
status: active
date: 2026-04-02
updated: 2026-08-26
tags: [algorithms, computer-science, performance, data-structures, snapshot-valuation, fixed-income, real-estate, accrued-interest]
description: Formal documentation of Vision algorithms — deduplication hashing, recurring pattern detection, currency conversion, portfolio snapshot valuation, and historical LTTB context
aliases: [algorithms, data structures, CS, computational methods]
---

# Algorithms & Data Structures

> [!abstract] Purpose
> This document formally describes the algorithms and data structures used throughout Vision. It is designed for **computer scientists**, **algorithm researchers**, and **developers** who need to understand the computational foundations of the system.

---

## LTTB (Largest-Triangle-Three-Buckets) Downsampling

> [!note] Removed
> Vision no longer runs LTTB in either application. This section is historical algorithm context;
> the removal rationale and former implementation are recorded in
> [[docs/performance/chart-downsampling|Chart Downsampling]]. Current charts render the full daily
> series, so there is no live source location.

### Problem Statement

Time-series charts can contain tens of thousands of data points. Rendering all points causes:
1. **DOM overload** — too many SVG/Canvas elements
2. **Memory pressure** — large arrays in JavaScript heap
3. **Interactivity degradation** — laggy pan/zoom

The goal is to reduce N points to a configurable threshold T while preserving the **visual shape** of the original series.

### Algorithm Description

LTTB is a perceptually-motivated downsampling algorithm that selects points maximizing the **triangle area** formed by consecutive buckets.

#### Input
- `data`: Array of `{x: number, y: number}` points, sorted by x
- `threshold`: Target number of output points (T)

#### Output
- Array of T points preserving visual shape

#### Steps

```
1. If data.length ≤ threshold, return data unchanged
2. Compute bucket_width = (data.length - 2) / (threshold - 2)
   - First and last points are always preserved
3. For each bucket i from 0 to (threshold - 3):
   a. Define bucket range: [start, end) where
      start = floor(i * bucket_width) + 1
      end = floor((i + 1) * bucket_width) + 1
   b. Compute average point of next bucket (i+1):
      avg_next = mean(data[end .. end + bucket_width])
   c. For each point p in current bucket:
      Compute triangle area formed by:
      - selected_point (from previous bucket)
      - p (current candidate)
      - avg_next (average of next bucket)
   d. Select the point p that maximizes triangle area
4. Return: [first_point, selected_points..., last_point]
```

#### Triangle Area Formula

For points A, B, C:

```
area = |(B.x - A.x)(C.y - A.y) - (B.y - A.y)(C.x - A.x)| / 2
```

This is the **cross product** magnitude, proportional to the area of the triangle formed by the three points.

#### Complexity

- **Time:** O(N) — each point is visited exactly once
- **Space:** O(T) — output array of size T
- **Optimal:** Cannot be faster than O(N) since all points must be examined

#### Why LTTB?

| Algorithm | Shape Preservation | Speed | Visual Quality |
|-----------|-------------------|-------|----------------|
| Random sampling | Poor | O(N) | Bad |
| Uniform sampling | Poor | O(N) | Bad (aliasing) |
| Min-Max | Good | O(N) | Moderate |
| **LTTB** | **Excellent** | **O(N)** | **Excellent** |
| Douglas-Peucker | Excellent | O(N log N) | Excellent |

LTTB is preferred because it:
- Runs in linear time (unlike Douglas-Peucker)
- Preserves peaks and troughs better than uniform sampling
- Is perceptually motivated (maximizes visual deviation)

#### Implementation Notes

```typescript
// Key optimization: use squared area to avoid sqrt
const area = Math.abs(
  (pointX - prevSelectedX) * (nextAvgY - prevSelectedY) -
  (pointY - prevSelectedY) * (nextAvgX - prevSelectedX)
);
```

### Related

- [[docs/performance/chart-downsampling]] — Performance impact documentation
- [[docs/features/views#statistics]] — Charts using downsampling

---

## Deduplication Hashing (SHA-256)

**Location:** [[apps/node-backend/src/services/deduplication.js]]

### Problem Statement

When importing bank CSV files, the same transaction may appear in multiple imports (e.g., overlapping date ranges). The system must detect and prevent duplicate entries.

### Algorithm Description

Each transaction is hashed using **SHA-256** based on its semantic content.

#### Hash Input Construction

```
hash_input = normalize(date) + "|" + normalize(amount) + "|" + normalize(memo) + "|" + normalize(recipient)
```

Where `normalize()` applies:
1. **Date:** ISO 8601 format (YYYY-MM-DD)
2. **Amount:** Fixed precision (2 decimal places)
3. **Memo:** Lowercase, trimmed, whitespace-normalized
4. **Recipient:** Lowercase, trimmed, whitespace-normalized

#### Hash Computation

```javascript
import { createHash } from 'crypto';
const hash = createHash('sha256').update(normalizedInput).digest('hex');
```

#### Collision Analysis

- **Hash space:** 2^256 possible values
- **Birthday bound:** ~2^128 inputs for 50% collision probability
- **Practical risk:** Negligible for financial transaction volumes

#### False Positive Mitigation

The hash is used as a **unique constraint** in the database. If a hash collision occurs (extremely unlikely), the transaction is rejected as a duplicate. This is acceptable because:
1. SHA-256 collision probability is astronomically low
2. The cost of a false positive (missed duplicate) is higher than a false negative (rejected unique transaction)

#### Complexity

- **Time:** O(L) where L is the length of the normalized input string
- **Space:** O(1) — fixed 32-byte output

### Related

- [[docs/features/import]] — Import deduplication
- [[docs/performance/caching-strategies]] — Cache key strategies

---

## Recurring Pattern Detection

**Location:** [[apps/node-backend/src/services/recurringDetectionService.js]]

### Problem Statement

Automatically identify recurring transactions (subscriptions, rent, utilities) from historical data without user configuration.

### Algorithm Description

The algorithm uses **temporal pattern analysis** on transaction sequences.

#### Input
- List of transactions for a given recipient
- Configurable parameters:
  - `minOccurrences`: Minimum number of transactions to detect a pattern (default: 3)
  - `toleranceDays`: Allowed day variance (default: 2)
  - `amountTolerance`: Allowed amount variance percentage (default: 5%)

#### Steps

```
1. Group transactions by recipient
2. For each recipient with ≥ minOccurrences transactions:
   a. Sort transactions by date
   b. Compute inter-transaction intervals (days between consecutive transactions)
   c. Calculate interval statistics:
      - mean_interval = mean(intervals)
      - median_interval = median(intervals) — for even-length arrays, average of two middle values
      - std_interval = stddev(intervals)
   d. If std_interval ≤ toleranceDays:
      - Pattern is consistent
      - Classify as recurring with period = round(median_interval)
   e. Map interval to named pattern:
      - 7 ± toleranceDays → weekly
      - 14 ± toleranceDays → bi-weekly
      - 30 ± toleranceDays → monthly
      - 90 ± toleranceDays → quarterly
      - 365 ± toleranceDays → yearly
   f. Verify amount consistency:
      - If all amounts within amountTolerance%, mark as amount-stable
```

#### Pattern Classification

| Interval (days) | Pattern | Tolerance |
|-----------------|---------|-----------|
| 6-8 | Weekly | ±2 days |
| 12-16 | Bi-weekly | ±2 days |
| 28-32 | Monthly | ±2 days |
| 88-92 | Quarterly | ±2 days |
| 363-367 | Yearly | ±2 days |

#### Complexity

- **Time:** O(N log N) for sorting + O(N) for interval analysis
- **Space:** O(N) for storing intervals

#### Edge Cases Handled

1. **Missing months:** A monthly subscription skipped one month — the algorithm detects the 60-day gap and still classifies as monthly if the overall pattern is consistent
2. **Amount drift:** Subscriptions with annual price increases — handled by `amountTolerance`
3. **Multiple patterns:** A recipient with both weekly and monthly payments — detected as separate patterns

### Related

- [[docs/features/plannedTransactions]] — Planned transactions with recurrence
- [[docs/diagrams/recurring-detection-flow.puml]] — Flow diagram

---

## Currency Conversion Service

**Location:** [[apps/node-backend/src/services/currency/currencyConversionService.js]]

### Problem Statement

Convert amounts between currencies using historical exchange rates for accurate financial reporting.

### Algorithm Description

Multi-layer conversion with historical rate support.

#### Conversion Flow

```
1. If source_currency == target_currency, return amount unchanged
2. Look up exchange rate:
   a. Check in-memory cache (latest rates)
   b. Check database for historical rate on transaction date
   c. If missing, backfill from ECB historical data
   d. If still missing, use nearest available date
3. Convert: result = amount × (rate_to_eur[source] / rate_to_eur[target])
```

#### Historical Rate Backfill

```
For each currency with missing historical rates:
  1. Fetch ECB historical data
  2. For each missing (currency, date) pair:
     a. Find nearest date with available rate
     b. Use linear interpolation if rates exist on both sides
     c. Otherwise, use nearest available rate
  3. Store in exchange_rates table
```

#### Batch Conversion

For converting multiple rows (e.g., bank balances by date):

```javascript
convertRowsToEur(rows, targetCurrency, {
  useHistoricalRatesByDate: true,
  dateField: 'date'
})
```

This performs a **single pass** over rows, building a rate lookup map to avoid repeated database queries.

#### Complexity

- **Single conversion:** O(1) with cache, O(log N) with DB lookup
- **Batch conversion:** O(M + N) where M = rows, N = unique dates
- **Space:** O(N) for rate lookup map

#### Precision

- Exchange rates stored as `NUMERIC(20,10)` — 10 decimal places
- Conversion results maintain precision through intermediate calculations
- Final display formatting applied at the UI layer

### Related

- [[docs/integrations/currency-conversion]] — Integration documentation
- [[docs/adr/002-database-schema#exchange-rates]] — Database schema

---

## Text Normalization

**Location:** [[apps/node-backend/src/lib/textNormalization.js]]

### Problem Statement

Bank transaction descriptions are inconsistent and noisy. Normalize them for consistent recipient matching and categorization.

### Algorithm Description

Multi-pass normalization pipeline:

```
1. Unicode normalization (NFC)
2. Lowercase conversion
3. Remove special characters (keep alphanumeric, spaces)
4. Collapse multiple spaces → single space
5. Trim leading/trailing whitespace
6. Remove common prefixes/suffixes (e.g., "BETALING MET", "KAARTNR")
7. Standardize known patterns:
   - IBAN patterns → extract bank code
   - Date patterns → normalize format
   - Amount patterns → standardize
```

#### Complexity

- **Time:** O(L) where L is the input string length
- **Space:** O(L) for intermediate strings

### Related

- [[docs/features/import]] — Import text processing

---

## Net Worth Snapshot Algorithm

**Location:** [[apps/node-backend/src/services/portfolio/snapshotBuilder.js]] (day walk + non-unit valuation), [[apps/node-backend/src/repositories/infoRepository.js]] (liquid component + cache layer)

### Problem Statement

Compute daily net worth snapshots across multiple asset classes with proper handling of contribution flows, price history, accrued interest, appreciation, and spike sanitization. The snapshot pipeline must produce values that reconcile with the live `portfolioSummaryService` formulas used by the Dashboard and Performance pages.

### Algorithm Description

#### Seed Date Discovery

```
seed_date = min(
  first_portfolio_transaction_date,
  first_active_investment_creation_date,
  first_active_transaction_date
)
```

#### Daily Snapshot Computation

```
For each day from seed_date to today:
  1. Apply transactions for this day to running accumulators
  2. Investment component — unit-based (stock, etf, crypto, metals):
     a. price = asset_price_history forward-fill (binary-search for latest day ≤ current)
     b. Exception: on the latest day, use investments.current_price directly
        (guarantees reconciliation with live summary after a price refresh)
     c. value += units × price, converted to target currency
  3. Investment component — fixed-income (savings, bond):
     a. runningInvested accumulates buy+gift amounts (minus sells), per-txn FX
     b. lastInterestDate tracks most recent `interest` transaction (resets clock)
     c. firstBuyDate tracks first `buy` transaction
     d. startDate = lastInterestDate ?? firstBuyDate
     e. accruedInterest = runningInvested × (interestRate/100/365)
                          × calendarDaysBetween(startDate, day)
     f. value = runningInvested + accruedInterest
  4. Investment component — real estate:
     a. runningInvested accumulates buy amounts (minus sells)
     b. runningAppreciation accumulates `appreciation` transaction amounts
     c. value = runningInvested + runningAppreciation
  5. Legacy fallback (no transactions):
     If non-unit investment has no buy transactions AND current_price > 0
     AND day >= active_from: value = current_price (converted to target currency)
  6. Liquid component:
     a. Cumulative transaction flow from seed_date
     b. If account balance snapshots available, use those instead
  7. Total = Investments + Liquid
  8. Apply spike sanitization (see below)
```

`calendarDaysBetween` uses `APP_TIMEZONE` (ADR-009) for exact integer day counts.

#### Spike Sanitization

Isolated one-day spikes (needles) are sanitized to prevent chart distortion:

The canonical implementation is `lib/calculations/valueSpikeSanitizer.js`.
Portfolio snapshots call it through `sanitizeSnapshotSpikes`; net-worth history
uses `lib/calculations/netWorthSanitizer.js` as a thin wrapper that recomputes
`netWorth` after the shared rule corrects `investments`. Corrected money fields
remain plain JavaScript numbers on both JSON paths.

```
For each day i (not first or last):
  1. Check if day i is an isolated spike:
     - |value[i] - value[i-1]| > threshold × |value[i-1]|
     - |value[i+1] - value[i]| > threshold × |value[i]|
     - value[i-1] and value[i+1] are on the same side of value[i]
  2. If spike detected:
     value[i] = geometric_mean(value[i-1], value[i+1])
```

##### Decomposition reconciliation

Every portfolio snapshot row is built so that

```
value == stocks_etfs_value + crypto_value + metals_value + cash_value
```

(unit-priced legs plus the non-unit savings/bond/real-estate bucket). Smoothing
each leg with its own geometric mean does **not** preserve that sum, so
`sanitizeSnapshotSpikes` passes the decomposition as `sumFields`: on a detected
needle the price-feed legs are smoothed, then `value` is reconciled to the sum
of the legs rather than to `geometric_mean(value[i-1], value[i+1])`.

`cash_value` is in `sumFields` but **not** in `extraFields` — it is replayed from
the ledger plus deterministic interest accrual rather than from a daily price
series, so it does not carry price-feed needles and is passed through untouched.
Smoothing it would invent a balance the user never held, and because detection
runs on the *total*, a genuine one-day cash transit (deposit in, withdrawal out)
trips the needle rule; preserving the cash leg makes that day reconcile back to
its real total instead of persisting a loss that never happened.

(`cash_value` is not perfectly price-independent: a non-unit investment with no
transactions at all falls back to `current_price` converted at the day's FX rate,
and `investmentRepository.updatePrice` / `updatePricesBulk` carry no
`asset_class` filter, so a provider refresh can move that fallback. It is a
single re-valuation rather than a per-day series, and smoothing it would still
invent a balance.)

#### FX-neutral parallel total

`value_fx_neutral` is not a leg of the sum — it is the same portfolio valued at
purchase-date FX, and it shares the *identical* `cash_value` figure (the day walk
adds `fixedIncomeValue` to both totals). It is declared as a `parallelTotal` with
`sharedFields: ['cash_value']` and rebuilt from the reconciled `value` at the FX
ratio its neighbors show:

```
ratio    = geometric mean of (value_fx_neutral - cash) / (value - cash)
           over the neighbours that hold anything outside cash
new_fxn  = (reconciled_value - cash) × ratio + cash
```

This matters because an all-EUR portfolio has `value_fx_neutral == value` on
every day by construction, and `PerformancePage` lights up the FX-attribution
line when *any* day's two totals differ by more than 0.01. Reconciling `value`
while leaving `value_fx_neutral` on its own geometric mean would show a currency
effect to a user holding no foreign currency. A price needle scales a position's
converted and FX-neutral values by the same factor, so the ratio itself never
needles and is safe to interpolate. When neither neighbour holds anything outside
cash the ratio is indeterminate but moot — the non-cash part reconciles to zero —
and a factor of 1 keeps an all-cash portfolio's two totals exactly equal.

Rows that do not decompose in the input (legacy or partial series) fall back to
the plain geometric-mean rule.

The snapshot builder applies this sanitization before persisting each series,
then derives `gain_loss` and `return_pct` from the sanitized `value`. The
`/portfolio-performance` response therefore treats persisted rows as the only
source of truth and does not smooth them a second time. It re-derives those two
fields at the response boundary so every served row keeps
`gain_loss == value - invested` and the matching return percentage. The removed
second pass used only the total `value`; it could flatten a real one-day cash
movement while leaving `cash_value` and `value_fx_neutral` untouched.

#### Parity Invariant (2026-05-18)

The snapshot builder mirrors `portfolioSummaryService` formulas so that:

```
snapshot[todayYmd].value ≈ portfolioSummary.totals.currentValue
```

This invariant is verified by regression tests in `portfolioPerformanceSnapshotService.test.js`.

#### Live Overlay at Read Time (2026-05-31, ADR-064)

Because `computeAndStoreSnapshots` runs only at startup, the stored snapshot's investments value drifts from the live summary after each hourly price refresh. To close this freshness gap, `infoRepositoryNetWorth.getNetWorthFromSnapshots` accepts an optional `liveInvestments` argument. When finite, it overwrites the latest snapshot row's `investments` and recomputes `netWorth = liquid + liveInvestments` before deriving `current` and `monthlyChange`. The caller (`netWorth.js` and the startup warmup path in `info.js`) resolves this value from `portfolioSummaryService` via the shared `portfolioSummaryCache` (60s TTL) using `resolveLivePortfolioValue(targetCurrency)` in `_liveSummary.js`. Historical snapshot rows are not modified. If the live resolution fails, `liveInvestments` is `undefined` and the algorithm falls back to the stored snapshot value.

#### Dense Input via Daily Gap-Fill (2026-05-31, ADR-065)

The snapshot algorithm assumes `asset_price_history` contains daily close prices for every held day. Prior to ADR-065 this assumption was violated by the Binance 365-day history cap and the `needsHistoryRefresh` endpoint-only check, producing forward-fill runs of 14+ days that manifested as biweekly granularity in the output series. ADR-065 ensures the input table is kept dense by a daily gap-detecting backfill job (`backfillHoldingGaps`). When the job writes new rows, it triggers `computeAndStoreSnapshots()` so the snapshot pipeline re-runs with the denser input. The algorithm itself is unchanged; only the quality of `asset_price_history` input improved.

#### Complexity

- **Time:** O(D × A) where D = days, A = active investments
- **Space:** O(D) for snapshot array + O(A) for per-investment accumulators
- **Caching:** 60-second in-memory cache per currency with in-flight request deduplication

### Related

- [[docs/features/portfolio#net-worth-tracking]] — Net worth feature docs
- [[docs/features/net-worth#non-unit-asset-valuation-formulas-2026-05-18-adr-061]] — Detailed formula description
- [[docs/adr/061-snapshot-valuation-parity|ADR-061]] — Decision record for the parity fix
- [[docs/adr/064-net-worth-current-value-live-overlay|ADR-064]] — Live overlay for the current snapshot point
- [[docs/adr/065-daily-gap-fill-dense-asset-history|ADR-065]] — Daily gap-fill ensuring dense daily input to the snapshot algorithm
- [[docs/adr/044-portfolio-summary-single-source-of-truth|ADR-044]] — Live summary as source of truth for dashboard + performance totals
- [[docs/performance/caching-strategies]] — Caching strategy

---

## Performance Return Calculations

### Modified Dietz Method (Relative Performance)

**Location:** [[apps/frontend/src/pages/portfolio/PerformancePage.tsx]]

For contribution-adjusted return calculation:

```
monthlyReturn = (currValue - prevValue - netFlow) / denominator
denominator = prevValue + netFlow / 2
if denominator ≤ 0: denominator = prevValue
```

Chained returns for multi-period:

```
totalReturn = Π(1 + monthlyReturn_i) - 1
```

#### Complexity

- **Time:** O(M) where M = number of months
- **Space:** O(M) for monthly return array

### CAGR (Annualized Return)

```
CAGR = (currentValue / investedCapital)^(1/years) - 1
```

### Related

- [[docs/features/portfolio]] — Portfolio feature documentation

---

## Summary of Algorithm Complexities

| Algorithm | Time | Space | Key Property |
|-----------|------|-------|--------------|
| LTTB Downsampling | O(N) | O(T) | Perceptually optimal |
| SHA-256 Deduplication | O(L) | O(1) | Cryptographic collision resistance |
| Recurring Detection | O(N log N) | O(N) | Tolerance-based pattern matching |
| Currency Conversion | O(1) cached | O(N) map | Historical rate support |
| Text Normalization | O(L) | O(L) | Multi-pass pipeline |
| Net Worth Snapshots | O(D × A) | O(D + A) | Parity-invariant valuation + spike sanitization |
| Modified Dietz Return | O(M) | O(M) | Contribution-adjusted |
| CAGR | O(1) | O(1) | Geometric mean |

Where:
- N = number of data points
- T = threshold (downsampling target)
- L = string length
- D = number of days
- A = number of active investments
- M = number of months
