---
title: Algorithms & Data Structures
type: algorithm-doc
status: active
date: 2026-04-02
updated: 2026-04-25
tags: [algorithms, computer-science, performance, data-structures]
description: Formal documentation of all algorithms used in Vision — LTTB downsampling, deduplication hashing, recurring pattern detection, currency conversion, and more
aliases: [algorithms, data structures, CS, computational methods]
---

# Algorithms & Data Structures

> [!abstract] Purpose
> This document formally describes the algorithms and data structures used throughout Vision. It is designed for **computer scientists**, **algorithm researchers**, and **developers** who need to understand the computational foundations of the system.

---

## LTTB (Largest-Triangle-Three-Buckets) Downsampling

**Location:** [[apps/frontend/src/utils/downsample.ts]]

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

**Location:** [[apps/node-backend/src/services/textNormalization.js]]

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

**Location:** [[apps/node-backend/src/repositories/infoRepository.js]]

### Problem Statement

Compute daily net worth snapshots across multiple asset classes with proper handling of contribution flows, price history, and spike sanitization.

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
  1. Liquid component:
     a. Cumulative transaction flow from seed_date
     b. If account balance snapshots available, use those
  2. Investment component (per unit-priced asset):
     a. Start from investment's first activity date
     b. Use provider historical close quotes when available
     c. Fall back to last known transaction unit price (carry-forward)
     d. Never use mutable current_price for past days
  3. Total = Liquid + Investments
  4. Apply spike sanitization (see below)
```

#### Spike Sanitization

Isolated one-day spikes (needles) are sanitized to prevent chart distortion:

```
For each day i (not first or last):
  1. Check if day i is an isolated spike:
     - |value[i] - value[i-1]| > threshold × |value[i-1]|
     - |value[i+1] - value[i]| > threshold × |value[i]|
     - value[i-1] and value[i+1] are on the same side of value[i]
  2. If spike detected:
     value[i] = geometric_mean(value[i-1], value[i+1])
```

#### Complexity

- **Time:** O(D × A) where D = days, A = active investments
- **Space:** O(D) for snapshot array
- **Caching:** 60-second in-memory cache per currency with in-flight request deduplication

### Related

- [[docs/features/portfolio#net-worth-tracking]] — Net worth feature docs
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
| Net Worth Snapshots | O(D × A) | O(D) | Spike sanitization |
| Modified Dietz Return | O(M) | O(M) | Contribution-adjusted |
| CAGR | O(1) | O(1) | Geometric mean |

Where:
- N = number of data points
- T = threshold (downsampling target)
- L = string length
- D = number of days
- A = number of active investments
- M = number of months
