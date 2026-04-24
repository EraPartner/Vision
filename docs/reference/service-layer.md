---
title: Service Layer Reference
type: reference
status: active
date: 2026-04-24
tags: [backend, services, reference, business-logic, phase-1, phase-c, import-pipeline]
description: Complete reference for all 18 backend services — exported functions, dependencies, algorithms, and usage patterns. Updated for Phase C import pipeline consolidation, snapshot-backed net worth computation, quoteBackfillService refactor, and AI Chat service.
aliases: [services, service layer, business logic, backend services]
related_code: ["apps/node-backend/src/services/"]
---

# Service Layer Reference

> [!abstract] Purpose
> This document is a complete reference for every service in the backend's business logic layer. Each service is documented with its purpose, exported functions, dependencies, and key algorithms. Designed for **developers** adding features, **AI agents** analyzing code, and **computer scientists** studying implementation patterns.

---

## Architecture Overview

The service layer sits between [[docs/api/index|API routes]] and [[docs/adr/006-three-layer-architecture|repositories]], implementing business logic, orchestration, and external integrations.

```
Route Layer (Express handlers)
        │
        ▼
   Service Layer ←── External APIs (ECB, Statbel, Yahoo, Binance, Kinesis)
        │
        ▼
Repository Layer (SQL queries)
```

**Design principles:**
- Services are pure functions or function modules — no classes
- External I/O (DB, HTTP) is encapsulated within services
- Pure computation services have zero dependencies
- Side-effect services depend on `connection.js` (PostgreSQL)

---

## 1. bankAdapters.js

**File:** [[apps/node-backend/src/services/bankAdapters.js]]  
**Purpose:** Parses bank-specific CSV files into a unified transaction format. Supports 8 bank formats via a factory pattern.

### Exported Functions

| Function | Signature | Returns |
|----------|-----------|---------|
| `createAdapter` | `(bankName: string, customConfig?: object) => Function` | Parser function for the given bank |
| `getSupportedBanks` | `() => string[]` | `['belfius', 'revolut', 'kbc', 'vision', 'sabb', 'wise']` |

### Supported Banks

| Bank | Date Format | Key Characteristics |
|------|-------------|-------------------|
| Belfius | DD/MM/YYYY | Reverse balance calculation from metadata |
| Revolut | ISO 8601 | Standard CSV with type column |
| KBC | DD/MM/YYYY | Transaction type prefixes in recipient field |
| Wise | ISO 8601 | Multi-currency support |
| SABB | DD/MM/YYYY | Saudi Arabian bank format |
| Vision | ISO 8601 | Internal self-import format |

### Key Algorithms

- **Factory Pattern:** `createAdapter` selects parser from `BANK_CONFIGURATIONS` registry
- **Generic Adapter:** Accepts `column_mapping`, `date_format`, `separator`, `skip_rows` for arbitrary CSV formats
- **Reverse Balance (Belfius):** Extracts last balance from CSV metadata, computes running balances backward
- **Text Normalization:** Delegates to `cleanRecipientName`, `cleanKbcRecipientName` from [[apps/node-backend/src/services/textNormalization.js]]

### Dependencies
- `textNormalization.js`
- `logger.js`

---

## 2. belgianInflationService.js

**File:** [[apps/node-backend/src/services/belgianInflationService.js]]  
**Purpose:** Fetches, caches, and persists Belgian monthly inflation rates from Statbel (primary) and Eurostat HICP (fallback).

### Exported Functions

| Function | Signature | Returns |
|----------|-----------|---------|
| `getInflationRates` | `({ startMonth, endMonth, forceRefresh?, dbOnly?, scheduleBackgroundRefresh? }) => Promise<InflationRate[]>` | Array of `{ month, rate }` objects |
| `warmInflationCache` | `() => Promise<void>` | Loads from DB, schedules background refresh |
| `clearInflationMemoryCache` | `() => void` | Resets all in-memory state |

### Resolution Chain

```
1. Memory cache (24h TTL)
2. Database (belgian_inflation_rates table)
3. Statbel API (2 candidate URLs with retry)
4. Eurostat HICP index (fallback)
```

### Key Algorithms

- **Schema-agnostic JSON Parsing:** `extractObjectRows` recursively traverses arbitrary JSON structures; `normalizeRatesFromPayload` tries many candidate key names
- **Eurostat Index-to-Rate Conversion:** `rate = (currentIndex / previousIndex) - 1`
- **Background Refresh:** Non-blocking refresh scheduled after serving cached data
- **Throttled Warnings:** Suppresses repeated fetch failure warnings within 30-minute window

### Dependencies
- `connection.js` (PostgreSQL)
- `logger.js`

---

## 3. currencyConversionService.js

**File:** [[apps/node-backend/src/services/currency/currencyConversionService.js]]  
**Purpose:** Converts amounts between currencies using ECB (primary), open.er-api.com (supplementary), database, and hardcoded fallbacks.

**Status:** Live canonical implementation (moved to `services/currency/` in Phase 0). Direct imports use this path.

### Exported Functions

| Function | Signature | Returns |
|----------|-----------|---------|
| `convertToEur` | `(amount: number, fromCurrency: string) => number` | Amount in EUR |
| `convertToCurrency` | `(amount, fromCurrency, toCurrency) => number` | Amount in target currency |
| `convertRowsToEur` | `(rows, targetCurrency, options?) => Row[]` | Batch-converted rows |
| `warmCache` | `() => Promise<void>` | Fetches + merges + persists rates |
| `clearMemoryCache` | `() => void` | Clears 24h cache + 90-day ECB history |
| `backfillPortfolioHistoricalRates` | `() => Promise<void>` | Backfills missing FX rates |

### Rate Sources (Priority Order)

1. **ECB XML API** — Daily reference rates (primary)
2. **open.er-api.com** — Supplementary rates for gaps
3. **Database** — Persisted historical rates
4. **FALLBACK_RATES** — ~40 hardcoded currency rates

### Key Algorithms

- **Multi-source Merging:** ECB overwrites overlaps, supplementary fills gaps
- **XML Parsing:** Custom regex parser handles single-quoted (daily) and double-quoted (historical) ECB formats
- **Binary Search:** `findNearestRateInIndex` finds closest historical rate date when exact match unavailable
- **Historical Rate Index:** Per-currency sorted index for efficient nearest-date lookups
- **Batch Conversion:** `convertRowsToEur` supports `useHistoricalRatesByDate` option with configurable `dateField`

### Dependencies
- `connection.js` (PostgreSQL)
- `logger.js`

---

## 4. dataImportService.js

**File:** [[apps/node-backend/src/services/dataImportService.js]]  
**Purpose:** Handles bulk CSV import for reference data (recipients and categories), not transactions.

### Exported Functions

| Function | Signature | Returns |
|----------|-----------|---------|
| `importRecipientsCSV` | `(filePath, options?) => Promise<ImportResult>` | `{ imported, skipped, errors }` |
| `importCategoriesCSV` | `(filePath, options?) => Promise<ImportResult>` | `{ imported, skipped, errors }` |

### Key Algorithms

- **Flexible Column Matching:** Case-insensitive header matching, falls back to first column for categories
- **Non-destructive Upserts:** Never overwrites existing recipient notes or default categories
- **Category Parsing:** Splits on `:` to extract general/detail parts

### Dependencies
- `recipientRepository.js`, `categoryRepository.js`, `recipientBankAccountRepository.js`
- `connection.js`, `logger.js`

---

## 5. deduplication.js

**File:** [[apps/node-backend/src/services/deduplication.js]]  
**Purpose:** Prevents duplicate transactions during import using SHA-256 hashing and field-based matching.

### Exported Functions

| Function | Signature | Returns |
|----------|-----------|---------|
| `createTransactionHash` | `(transactionData) => string` | SHA-256 hex string |
| `createManualTransactionHash` | `({ date, amount, recipientId, memo, bankAccount }) => string` | Hash with "manual\|" prefix |
| `isDuplicate` | `(transactionData) => Promise<boolean>` | True if duplicate found |
| `isDuplicateByFields` | `(date, amount, recipientName, memo) => Promise<boolean>` | Field-based check |
| `isManualDuplicate` | `({ date, amount, recipientId, memo, bankAccount }) => Promise<{ isDuplicate, existingTransactionId }>` | Manual dedup result |
| `recordManualRawTransaction` | `(...) => Promise<void>` | Records hash for future dedup |

### Key Algorithms

- **SHA-256 Content Hashing:** Deterministic hash from raw CSV data or composite fields (date + amount + recipient + memo)
- **Dual Strategy:** Hash-based for imported, field-based for manual/fallback
- **Graceful Degradation:** Silently handles missing `manual_raw_transactions` table

### Dependencies
- `connection.js` (PostgreSQL)
- Node.js `crypto` module

---

## 6. iban.js

**File:** [[apps/node-backend/src/services/iban.js]]  
**Purpose:** Validates and normalizes IBAN (International Bank Account Number) strings.

### Exported Functions

| Function | Signature | Returns |
|----------|-----------|---------|
| `normalizeIban` | `(iban: string) => string` | Uppercased, spaceless IBAN |
| `isValidIban` | `(iban: string) => boolean` | Mod-97 checksum validation result |

### Key Algorithms

- **Mod-97 Checksum:** Rearranges IBAN (first 4 chars to end), converts letters to numbers (A=10..Z=35), computes mod 97 in 9-digit chunks to avoid BigInt overflow

### Dependencies
- None (pure utility)

---

## 7. importPipeline/ (Phase C)

**File:** [[apps/node-backend/src/services/importPipeline/index.js]]  
**Purpose:** Unified orchestrator for all CSV transaction imports (standard, custom, and streaming). Replaced legacy `importService`, `streamingImportService`, and `rawTransactionImportService` in Phase C.

### Exported Functions

| Function | Signature | Returns |
|----------|-----------|---------|
| `runImportPipeline` | `({ filePath, adapterName, customConfig?, filename?, sizeBytes?, onProgress? }) => Promise<{ batchId, total, imported, duplicates, errors }>` | Import results with batch ID |
| `createBatch` | `({ adapterName, filename?, sizeBytes?, customConfig? }) => Promise<number>` | Batch ID |
| `stageBatch` | `({ batchId, filePath, adapterName, customConfig?, onProgress? }) => Promise<{ rowsTotal }>` | Staged row count |
| `validateBatch` | `({ batchId, onProgress? }) => Promise<{ errors }>` | Validation error count |
| `matchBatch` | `({ batchId, onProgress? }) => Promise<void>` | Recipients/categories matched |
| `commitBatch` | `({ batchId, onProgress? }) => Promise<{ imported, duplicates, errors }>` | Final counts |

### Pipeline Phases

```
createBatch → stageBatch → validateBatch → matchBatch → commitBatch → scheduleRefresh
```

1. **Stage:** Parse CSV via bank adapter, store raw rows in `import_staging` table
2. **Validate:** Check required fields, dedup hashes, mark invalid rows with errors
3. **Match:** Look up or create recipients, categories, resolve aliases
4. **Commit:** Insert canonical transactions, raw references, aggregate stats
5. **Refresh:** Schedule non-blocking materialized view refresh

### Key Features

- **Idempotent Phases:** Each phase isolated; failure marks batch as `failed` without cascade
- **Async Progress Callbacks:** `onProgress` callback is `await`-ed, propagates SSE backpressure into pipeline
- **Batch Persistence:** All imports assigned `batchId`, tracked in `import_batches` table for history/rollback
- **Adaptive Concurrency:** Row batches processed with `Math.max(2, Math.floor(poolMax / 2))` concurrency based on DB pool size
- **Error Sanitization:** Generic error messages prevent internal exception leakage

### Sub-modules

| Module | Export | Purpose |
|--------|--------|---------|
| `stage.js` | `stageBatch()` | CSV parsing and row staging |
| `validate.js` | `validateBatch()` | Field validation and dedup detection |
| `match.js` | `matchBatch()` | Recipient/category lookup or creation |
| `commit.js` | `commitBatch()` | Transaction insertion and accounting |

### Dependencies
- `bankAdapters.js`, `deduplication.js`, `textNormalization.js`
- `materializedViewService.js` (post-pipeline refresh)
- `importBatchRepository.js`, `connection.js`, `logger.js`

### Related Services (Deprecated, Phase C)

> [!warning] Deprecated
> The following services are no longer used by active code paths but remain in codebase for backwards compatibility:
> - `importService.js` — legacy sequential import
> - `streamingImportService.js` — legacy streaming with callbacks
> - `rawTransactionImportService.js` — legacy raw data orchestrator
> 
> All functionality consolidated into `importPipeline`.

---

## 8. loanRepaymentService.js

**File:** [[apps/node-backend/src/services/loanRepaymentService.js]]  
**Purpose:** Generates loan repayment schedules for planned transactions.

### Exported Functions

| Function | Signature | Returns |
|----------|-----------|---------|
| `validateLoanConfig` | `(config) => { errors: string[], normalized: LoanConfig }` | Validation result |
| `generateLoanRepaymentSchedule` | `(config) => { regular_payment_amount, first_due_date, schedule[] }` | Full amortization schedule |

### Loan Types

| Type | Formula | Description |
|------|---------|-------------|
| **Amortizing** | `PMT = (P × r) / (1 - (1+r)^(-n))` | Standard annuity — equal payments |
| **Fixed Principal** | `principal/n + remaining × r` | Equal principal, declining interest |
| **Interest-Only** | `P × r` (final: `P + P × r`) | Interest only, principal at end |

### Key Algorithms

- **Month Arithmetic with Day Clamping:** `addMonthsAtDay` handles month-end edge cases (e.g., day 31 in a 30-day month)
- **Floating-Point Safety:** Uses `EPSILON` and `roundMoney` for monetary precision

### Dependencies
- None (pure computation)

---

## 9. materializedViewService.js

**File:** [[apps/node-backend/src/services/materializedViewService.js]]  
**Purpose:** Creates and refreshes PostgreSQL materialized views for pre-computed dashboard aggregations.

### Exported Functions

| Function | Signature | Returns |
|----------|-----------|---------|
| `createMaterializedViews` | `() => Promise<void>` | Creates 4 views with unique indexes |
| `ensureMaterializedViewIndexes` | `() => Promise<void>` | Retroactively ensures unique indexes |
| `refreshMaterializedViews` | `() => Promise<void>` | Refreshes all views CONCURRENTLY |
| `scheduleRefresh` | `() => void` | Debounced refresh (1s delay) |

### Materialized Views

| View | Purpose |
|------|---------|
| Monthly summaries | Aggregated income/expense per month |
| Category totals | Spending per category per period |
| Daily cashflow | Day-level income vs expense |
| Bank balances | Current bank account balances |

### Key Algorithms

- **CONCURRENTLY Refresh:** Allows reads during refresh (requires unique indexes)
- **Call Coalescing:** `refreshInFlight`/`refreshQueued` flags prevent redundant concurrent refreshes
- **Debounced Scheduling:** 1-second debounce timer coalesces rapid changes
- **Fallback:** If CONCURRENTLY fails, falls back to standard refresh

### Dependencies
- `connection.js`, `logger.js`

---

## 10. portfolioPerformanceSnapshotService.js

**File:** [[apps/node-backend/src/services/portfolioPerformanceSnapshotService.js]]  
**Purpose:** Computes and stores daily portfolio performance snapshots with per-class breakdowns, including fixed-income investments.

### Exported Functions

| Function | Signature | Returns |
|----------|-----------|---------|
| `computeAndStoreSnapshots` | `(targetCurrency) => Promise<void>` | Computes + persists daily snapshots |
| `getSnapshots` | `(startDate, endDate, currency) => Promise<Snapshot[]>` | Stored snapshots for date range |
| `getLatestSnapshot` | `(currency) => Promise<Snapshot>` | Most recent snapshot |

### Snapshot Fields

- `snapshot_date` — Date of the snapshot
- `invested_stocks_etfs`, `invested_crypto`, `invested_metals` — Per-class invested capital (unit-based only)
- `stocks_etfs_value`, `crypto_value`, `metals_value` — Per-class market value (unit-based only)
- `value` — Total portfolio value (unit-based + fixed-income)
- `cash_value` — Fixed-income portion (real_estate, savings, bond) of total value
- `invested` — Cumulative capital deployed (unit-based transactions only)
- `inflation_adjusted_value` — Value adjusted for Belgian inflation
- `gain_loss`, `return_pct` — Performance metrics

### Key Algorithms

- **Daily Forward-Fill Simulation:** Iterates every day from first data date to today, applying transactions and market prices cumulatively
- **Unit-Based Assets:** Stocks, ETFs, crypto, metals — computed from portfolio transactions and historical price history
- **Fixed-Income Assets:** Real estate, savings, bonds — value stored in `current_price`, applied from `created_at` date onward to daily snapshots
- **Price Resolution Cascade:** Historical price > last known price > last transaction price > current price
- **Spike Sanitization:** `sanitizeIsolatedDailySpikes` detects "needle" anomalies using log-return analysis (18% jump + revert) and replaces with geometric mean of neighbors
- **Cumulative Inflation Adjustment:** Compounds monthly Belgian inflation rates, divides portfolio value by cumulative factor
- **Batch Upsert:** 500-row batches with `ON CONFLICT (snapshot_date) DO UPDATE SET`

### Dependencies
- `currencyConversionService.js`
- `connection.js`, `logger.js`

---

## 11. priceProviderService.js

**File:** [[apps/node-backend/src/services/priceProviderService.js]]  
**Purpose:** Fetches live and historical asset prices from multiple providers with caching and spike sanitization.

### Exported Functions

| Function | Signature | Returns |
|----------|-----------|---------|
| `fetchLivePrices` | `(investments) => Promise<{ id: price }>` | Current price map |
| `fetchLivePricesDetailed` | `(investments, options?) => Promise<{ id: { price, source } }>` | Price + source info |
| `fetchHistoricalPrices` | `(investment, options?) => Promise<PricePoint[]>` | Historical price points |
| `getHistoricalPriceAt` | `(points, timestampMs) => number` | Price at specific timestamp |
| `saveHistoricalPointsToDatabase` | `(points, investment, source) => Promise<void>` | Persists sanitized points to DB |
| `sanitizePersistedKinesisHistory` | `() => Promise<void>` | Re-sanitizes stored Kinesis history |
| `__resetPriceCache` | `() => void` | Test-only: clears in-process cache |

> **Note:** `backfillHistoricalAssetQuotes()` moved to [[apps/node-backend/src/services/quoteBackfillService.js|quoteBackfillService.js]] (2026-04-16)

### Providers

| Provider | Assets | Batch Support |
|----------|--------|---------------|
| Binance | Crypto | Yes (multi-symbol) |
| Yahoo Finance | Stocks, ETFs | Yes (multi-symbol) |
| Kinesis | Metals, commodities | No (per-symbol) |
| Custom JSON | Any | No (per-symbol) |
| Manual | Any | N/A |

### Key Algorithms

- **Provider Grouping:** Groups investments by provider; batches Binance/Yahoo calls
- **5-minute In-Process Cache:** Per-symbol cache with TTL
- **Kinesis Spike Sanitization:** MAD-based (Median Absolute Deviation) outlier detection with 6-sigma threshold, 18% minimum move, geometric mean replacement
- **Binary Search:** `getHistoricalPriceAt` finds most recent price at or before timestamp
- **History Refresh Decision:** `_needsHistoryRefresh` checks if cached DB data covers requested range within 1-day tolerance

### Dependencies
- `yahoo-finance2` (npm package)
- `kinesisConfig.js`
- `connection.js`, `logger.js`

---

## 12. quoteBackfillService.js

**File:** [[apps/node-backend/src/services/quoteBackfillService.js]]  
**Purpose:** Orchestrates historical quote backfill and maintenance for investments with holding window awareness.

### Exported Functions

| Function | Signature | Returns |
|----------|-----------|---------|
| `computeHoldingWindows` | `(transactions) => Window[]` | Time periods where units > 0 |
| `sanitizeIsolatedSpikes` | `(points) => PricePoint[]` | Sanitized points (provider-agnostic spike detection) |
| `getInvestmentsWithHoldingWindows` | `() => Promise<Investment[]>` | All unit-based investments with computed holding windows |
| `backfillHistoricalAssetQuotes` | `() => Promise<{ processed, updated, skipped, failed }>` | Full startup backfill |
| `refreshActiveHoldingQuotes` | `() => Promise<{ processed, updated, skipped }>` | Lightweight hourly refresh |
| `refreshQuotesForInvestment` | `(investmentId) => Promise<void>` | Single-investment refresh (transaction-triggered) |
| `cleanupStaleQuotes` | `(investmentWindows) => Promise<{ deleted }>` | Remove quotes outside holding windows |

### Holding Windows

Quotes are persisted **only for periods when units > 0**, not based on `is_active` flag:
- Computed from transaction history (buy/sell/gift/etc.)
- Handles multiple buy/sell cycles per investment
- Preserved across inactive investments (users can still view historical charts)

### Spike Detection

Uses **MAD-based statistical detection** (Median Absolute Deviation):
1. Compute log-returns between consecutive points
2. Calculate MAD of returns
3. Identify outliers: return > 3σ (σ = 1.4826 × MAD)
4. Confirm isolation (outlier reverts in next period) + local ratio check (> 1.8x) + minimum jump (>= 18%)
5. Replace isolated spikes with geometric mean of neighbors

**Why MAD over Z-score:** Robust to extreme outliers; no normal distribution assumption; works well for provider trendline artifacts

### Three Refresh Modes

| Mode | Trigger | Scope | Speed |
|------|---------|-------|-------|
| Startup Backfill | Application start | All investments + full history | Slow, comprehensive |
| Hourly Refresh | `setInterval` (1h) | Open holding windows + 7-day lookback | Fast, lightweight |
| Transaction Trigger | POST/DELETE/PATCH investment transactions | Single investment | Immediate, fire-and-forget |

### Key Algorithms

- **Holding Window Computation:** Scans transactions chronologically, tracks cumulative units, marks windows where units transition 0↔positive
- **Batch Persistence:** Upserts to `asset_price_history` with ON CONFLICT DO UPDATE (idempotent)
- **Stale Cleanup:** Deletes quotes outside computed holding windows after backfill

### Dependencies
- `priceProviderService.js` — Delegates `fetchHistoricalPrices()` and `fetchLivePricesDetailed()`
- `investmentRepository.js` — Reads investment + transaction history
- `connection.js`, `logger.js`

---

## 13. rawTransactionImportService.js (Deprecated — Phase C)

> [!warning] Deprecated Service
> **Status:** Superseded by `importPipeline` (Phase C). Functionality consolidated into `importPipeline/commit.js`.
> 
> Remains in codebase for backwards compatibility; not used by active routes.

**File:** [[apps/node-backend/src/services/rawTransactionImportService.js]]  
**Previous Purpose:** Imported CSV transactions while preserving raw data in bank-specific tables for audit trail.

**Current Implementation:** `importPipeline` handles raw data preservation in the **commit phase**. The pipeline's `commitBatch()` function inserts canonical transactions and raw references in a single coordinated operation with proper error handling and batch tracking.

**Key features now in importPipeline:**
- **Dual Storage:** Raw data in bank-specific tables + normalized transactions, linked via `raw_references`
- **Hash-based Raw Dedup:** SHA-256 hash validation moved to **validate phase**
- **Atomic Commits:** Transaction + raw reference insertion coordinated in single batch
- **Batch Persistence:** All imports tracked in `import_batches` table

See [[docs/features/import#import-pipeline-orchestrator|Import Feature — Pipeline Orchestrator]] for current implementation details.

---

## 14. recurrenceService.js

**File:** [[apps/node-backend/src/services/recurrenceService.js]]  
**Purpose:** Calculates next occurrence dates for recurring patterns.

### Exported Functions

| Function | Signature | Returns |
|----------|-----------|---------|
| `calculateNextDate` | `(currentDate, recurrencePattern) => Date` | Next occurrence date |
| `isValidPattern` | `(pattern) => boolean` | Pattern validity |
| `getSupportedPatterns` | `() => string[]` | `['daily', 'weekly', 'biweekly', 'monthly', 'quarterly', 'yearly', 'every N days']` |

### Dependencies
- None (pure utility)

---

## 15. recurringDetectionService.js

**File:** [[apps/node-backend/src/services/recurringDetectionService.js]]  
**Purpose:** Analyzes transaction history to automatically detect recurring payment patterns.

### Exported Functions

| Function | Signature | Returns |
|----------|-----------|---------|
| `detectRecurringPattern` | `() => Promise<PatternSuggestion[]>` | Ranked suggestions with confidence scores |

### Detection Algorithm

1. **Group by Recipient:** Cluster transactions by recipient
2. **Compute Intervals:** Days between consecutive transactions
3. **Pattern Matching:** Match median interval against known patterns with tolerance windows:
   - Weekly: 7 ± 1 day
   - Biweekly: 14 ± 2 days
   - Monthly: 30 ± 3 days
   - Quarterly: 91 ± 5 days
   - Yearly: 365 ± 7 days
4. **Consistency Check:** >= 60% of intervals must match pattern tolerance
5. **Custom Intervals:** Coefficient of variation (`stdDev / avgInterval < 0.25`)
6. **Confidence Scoring:** `consistency × 0.5 + min(occurrences, 12) / 12 × 30 + (no changes ? 20 : 10)`
7. **Cross-Reference:** Check if pattern already tracked in `planned_transactions`

### Dependencies
- `connection.js`, `logger.js`

---

## 16. streamingImportService.js (Deprecated — Phase C)

> [!warning] Deprecated Service
> **Status:** Superseded by `importPipeline` (Phase C). Functionality consolidated into unified import orchestrator.
> 
> Remains in codebase for backwards compatibility; not used by active routes.

**File:** [[apps/node-backend/src/services/streamingImportService.js]]  
**Previous Purpose:** Imported CSV transactions with real-time progress reporting via callbacks.

**Current Implementation:** `importPipeline` handles streaming imports via the **streaming endpoint** (`POST /api/import/csv/stream`). The pipeline's `runImportPipeline()` function accepts an `onProgress` callback (async) that propagates backpressure from `createSseWriter()` into the batch processing loop.

**Key features now in importPipeline:**
- **Phase-based Progress Events:** Staging → validating → matching → committing (not raw line counts)
- **Async Backpressure:** Progress callbacks are `await`-ed to propagate TCP socket backpressure
- **Adaptive Concurrency:** Row batches processed with `Math.max(2, Math.floor(poolMax / 2))` based on DB pool size
- **Batch Persistence:** All imports tracked in `import_batches` table with `batchId`

See [[docs/features/import#streaming-import-with-server-sent-events-sse|Import Feature — Streaming Import]] for current implementation details.

---

## 17. textNormalization.js

**File:** [[apps/node-backend/src/services/textNormalization.js]]  
**Purpose:** Normalizes and cleans text data for consistent matching across the application.

### Exported Functions

| Function | Signature | Returns |
|----------|-----------|---------|
| `cleanRecipientName` | `(recipient: string) => string` | Strips common prefixes |
| `cleanKbcRecipientName` | `(recipient: string) => string` | KBC-specific cleaning |
| `normalizeToUppercase` | `(name: string) => string` | Trims and uppercases |
| `normalizeForMatching` | `(name: string) => string` | Canonical form for matching |
| `formatAmountString` | `(amountStr: string) => number` | European number format parsing |
| `extractCurrencyCode` | `(currencyStr: string) => string` | 3-letter ISO code extraction |

### Key Algorithms

- **Canonical Token Sorting:** `normalizeForMatching` produces order-independent matching: "Smith John" and "John Smith" both become "JOHN SMITH"
- **Initial Filtering:** Removes single-letter tokens (initials) but keeps single-digit tokens
- **European Number Parsing:** Distinguishes comma-as-decimal (1.234,56) from comma-as-thousands (1,234.56) based on position of last comma vs last dot

### Dependencies
- None (pure utility)

---

## 18. aiChatService.js

**File:** [[apps/node-backend/src/services/aiChatService.js]]  
**Purpose:** Orchestrates natural-language financial queries using a local Ollama LLM with tool-calling. Implements the agentic loop: user message → LLM → tool dispatch → result → assistant narrative.

### Exported Functions

| Function | Signature | Returns |
|----------|-----------|---------|
| `chat` | `({ conversationId, message, model, signal }) => Promise<ChatTurn>` | Full turn object (user + tool messages + assistant response) |
| `chatStream` | `({ conversationId, message, model, onEvent, signal }) => Promise<ChatTurn>` | Streams events + returns final turn |

### Architecture

1. **History Load** — fetch prior messages, trim to `aiChat.maxHistoryMessages` (default 20)
2. **Prompt Build** — assemble system prompt + tool schema + history + user message
3. **Tool Loop** — invoke Ollama `/api/chat`, parse response, dispatch matching tools up to `MAX_TOOL_ITERATIONS` (default 3)
4. **Persistence** — save user message, tool calls, tool results, and assistant response to `ai_messages` table
5. **Streaming** — if `onEvent` provided, emit `user_message`, `token`, `tool_call`, `tool_result`, `done` events

### Key Algorithms

- **Agentic Loop:** Tool-calling pattern — LLM receives tool registry as JSON Schema, selects by name + args, backend validates + executes, result fed back as `role: "tool"` message
- **Tool Dispatch:** `aiChat/tools/index.js` dispatcher validates args against Zod schema, rejects unknown tool names with structured error
- **Context Trimming:** Message history trimmed from oldest to newest; tool-result payloads pruned to summaries only
- **Abort Handling:** `AbortSignal` passed through Ollama client; on abort, in-flight assistant message marked aborted

### Dependencies
- `ollamaClient` (HTTP wrapper for Ollama)
- `aiChatRepository` (conversation + message CRUD)
- `aiChat/tools/*` (expense, portfolio, planned, tax tools)
- `logger.js`

### Configuration

| Env | Default | Purpose |
|-----|---------|---------|
| `AI_CHAT_ENABLED` | `true` | Feature flag |
| `OLLAMA_URL` | `http://localhost:11434` | Ollama base URL |
| `OLLAMA_DEFAULT_MODEL` | `llama3.2:3b` | Fallback model |
| `AI_CHAT_RATE_LIMIT` | `30/min` | Rate limit for `/api/ai/chat` |
| `AI_CHAT_MAX_HISTORY` | `20` | Max prior messages loaded per turn |

### Error Handling

Maps Ollama errors to `AiChatServiceError` with HTTP status:
- `OLLAMA_UNREACHABLE` → 502
- `OLLAMA_TIMEOUT` → 504
- `VALIDATION_ERROR` (tool args) → 400
- `CONVERSATION_NOT_FOUND` → 404

---

## Dependency Graph

```
┌─────────────────────────────────────────────────────────┐
│                    External APIs                         │
│  ECB  │  Statbel  │  Eurostat  │  Yahoo  │  Binance     │
│  Kinesis  │  open.er-api                                │
└────┬────────┬────────┬────────┬────────┬────────┬───────┘
     │        │        │        │        │        │
     ▼        ▼        ▼        ▼        ▼        ▼
┌────────────────┐ ┌───────────────────┐ ┌──────────────────┐ ┌────────────────┐
│ belgianInflation│ │ currencyConversion│ │ priceProvider    │ │ quoteBackfill  │
│   Service       │ │   Service         │ │ Service          │ │ Service        │
└────────────────┘ └───────────────────┘ └──────────────────┘ └────────────────┘
                          │                        │
     ┌────────────────────┼────────────────────┐   │
     ▼                    ▼                    ▼   ▼
┌────────────┐ ┌────────────────────┐ ┌─────────────────┐
│ portfolio   │ │ importPipeline     │ │ dataImport      │
│ Performance │ │ (Phase C)          │ │ Service         │
│ Snapshot    │ │                    │ │                 │
└────────────┘ └────────────────────┘ └─────────────────┘
     │                    │                    │
     ▼                    ▼                    ▼
┌────────────┐ ┌────────────────────┐ ┌─────────────────┐
│ materialized│ │ bankAdapters       │ │ deduplication   │
│ View        │ │ (+ other helpers)  │ │                 │
└────────────┘ └────────────────────┘ └─────────────────┘
     │                    │                    │
     ▼                    ▼                    ▼
┌────────────┐ ┌────────────────────┐ ┌─────────────────┐
│ recurring   │ │ deduplication      │ │ loanRepayment   │
│ Detection   │ │                    │ │ Service         │
└────────────┘ └────────────────────┘ └─────────────────┘
     │                    │                    │
     ▼                    ▼                    ▼
┌────────────┐ ┌────────────────────┐ ┌─────────────────┐
│ recurrence  │ │ textNormalization  │ │ iban            │
│ Service     │ │                    │ │                 │
└────────────┘ └────────────────────┘ └─────────────────┘
```

## Service Classification

| Category | Services |
|----------|----------|
| **Pure Computation** | `loanRepaymentService`, `recurrenceService`, `iban`, `textNormalization` |
| **External Data** | `belgianInflationService`, `currencyConversionService`, `priceProviderService` |
| **Quote Management** | `quoteBackfillService` |
| **Import Pipeline** | `importPipeline` (unified orchestrator), `bankAdapters`, `dataImportService` (reference data), deprecated: `importService`, `streamingImportService`, `rawTransactionImportService` |
| **Data Quality** | `deduplication`, `recurringDetectionService` |
| **Performance** | `materializedViewService`, `portfolioPerformanceSnapshotService` |
| **AI & Natural Language** | `aiChatService` |

## Info Repository Refactor (Net Worth)

**Note (2026-04-16):** The `infoRepository.js` underwent a major refactor for net worth computation:

- **Removed:** Old `getNetWorth()` function (~580 lines, involved network calls to price providers for real-time portfolio valuation)
- **Added:** New `getNetWorthFromSnapshots()` function (350 lines, reads pre-computed investment values from `portfolio_performance_snapshots`)

**Impact:** Net worth endpoint (`GET /api/info/net-worth`) no longer makes requests to price providers at query time. All investment values are pre-computed daily by the snapshot service and read directly from the database. This eliminates latency/network dependency at request time, making the endpoint consistently fast regardless of portfolio size or number of price providers.

See [[docs/features/net-worth|Net Worth Feature]] for details on the new snapshot-backed architecture.

## Related Documentation

- [[docs/adr/006-three-layer-architecture|ADR-006: Three-Layer Architecture]]
- [[docs/reference/code-patterns|Code Patterns]]
- [[docs/features/import|Import Feature]]
- [[docs/features/net-worth|Net Worth Feature]]
- [[docs/features/ai-chat|AI Chat Feature]]
- [[docs/integrations/price-providers|Price Providers]]
- [[docs/integrations/currency-conversion|Currency Conversion]]
- [[docs/integrations/bank-adapters|Bank Adapters]]
- [[docs/integrations/ollama|Ollama Integration]]
