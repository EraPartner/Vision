---
title: Repository Layer Reference
type: reference
status: active
date: 2026-04-23
updated: 2026-08-26
tags: [backend, repositories, reference, data-access, postgresql, phase-0, phase-1, phase-3, phase-3-1, phase-9, phase-q, decimal, money, recipient-groups]
aliases: [repositories, repository layer, data access, DAL, database access]
description: Complete reference for all 21 backend repository domains (plus infoRepository's 7 sub-modules and portfolioTransactionRepository's 3 split files). Phase 3.1: infoRepository split into 7 domain sub-modules with batch FX optimization. Phase Q: transactionRepository supports recipientGroupId filtering via filterBuilder.
related_code: ["apps/node-backend/src/repositories/"]
---

# Repository Layer Reference

> [!abstract] Purpose
> This document is a complete reference for every repository in the backend's data access layer. Each repository is documented with its purpose, exported methods, and key query patterns. Designed for **developers** adding features, **AI agents** analyzing code, and **computer scientists** studying data access patterns.

---

## Architecture Overview

The repository layer is the lowest layer in Vision's [[docs/adr/006-three-layer-architecture|three-layer architecture]], responsible for all SQL queries and database interactions.

```
Service Layer (business logic)
        │
        ▼
   Repository Layer ←── connection.js (PostgreSQL pool)
        │
        ▼
   PostgreSQL Database
```

**Design principles:**
- Repositories are function modules — no classes
- All SQL uses parameterized queries via `connection.js` or prepared statements (Phase 0+)
- Repositories return plain JavaScript objects, not domain models
- Error handling is delegated to the calling service/route

**Phase 0+ Note:** Hot-path queries now use `queryPrepared()` for plan caching. This includes frequent repository methods like `getById`, `create`, `hardDelete` in `transactionRepository`, and equivalents in `infoRepository`. The prepared-statement name is the function name + operation, e.g., `'tx_get_by_id'` for `transactionRepository.getById`. See `apps/node-backend/src/database/connection.js` for the implementation and `docs/reference/query-patterns.md` for usage guidelines.

**Phase 9+ Note — Decimal Enforcement (Mandatory):** All repositories returning monetary values must coerce NUMERIC/DECIMAL columns on emit to eliminate IEEE 754 floating-point drift (node-postgres returns NUMERIC as JS strings; no global type parser is set deliberately to avoid loss in the decimal.js pipeline). Two helpers in `packages/shared-utils/src/money.js` (re-exported via `apps/node-backend/src/lib/money.js`) cover the boundary:
- `numericColumn(v)` — converts a single NUMERIC value to number; `null`/`undefined` pass through unchanged; `''` → `undefined`
- `coerceNumericFields(row, fields)` — shallow-copy coercion of named columns via `numericColumn`; no-op on nullish rows

Enforced across all monetary API output paths (Phase 9 + June 2026 stragglers):
- `splitRepository.js` — split amounts, outstanding balance
- `infoRepositoryBanks.js`, `infoRepositoryHelpers.js`, `infoRepositoryMonthly.js` — balance, total, running sums
- `portfolioTransactionRepository.js` / `portfolioTxRepo.reads.js` + `portfolioTxRepo.writes.js` — amounts, units, fees, taxes, fx_rate_to_eur, getSummary totals
- `rawTransactionRepository.js` — amounts, valuations
- `investmentRepository.js` — current_price, interest_rate, cadastral_income, municipality_tax_rate (all read paths + create/update/updatePrice return through getById)
- `watchlistRepository.js` — target_price

See [[docs/adr/021-decimal-arithmetic-for-monetary-values|ADR-021]] and [[docs/reference/code-patterns#money-utility-pattern-phase-9--june-2026|Money Utility Pattern]] for guidance.

---

## 1. transactionRepository.js

**File:** [[apps/node-backend/src/repositories/transactionRepository.js]]  
**Purpose:** CRUD operations for the `transactions` table with filtering, pagination, and virtual table support.

### Exported Methods

| Method | Signature | Returns |
|--------|-----------|---------|
| `getAll` | `(opts: { filters?, limit?, offset?, sort? }) => Promise<Transaction[]>` | Filtered transaction list |
| `getCount` | `(opts: { filters? }) => Promise<number>` | Total count matching filters |
| `getAllWithCount` | `(opts: { filters?, limit?, offset?, sort? }) => Promise<{ rows, total }>` | Paginated results with total |
| `getUncategorised` | `(opts: { limit?, offset? }) => Promise<Transaction[]>` | Transactions without categories |
| `getById` | `(id: number) => Promise<Transaction \| null>` | Single transaction or null |
| `create` | `(data: TransactionCreate) => Promise<Transaction>` | Created transaction |
| `update` | `(id: number, fields: Partial<Transaction>) => Promise<Transaction>` | Updated transaction |
| `hardDelete` | `(id: number) => Promise<boolean>` | Deletion success |

### Key Query Patterns

- **Dynamic WHERE Building:** Constructs filter clauses from `opts.filters` object (date range, category, recipient, amount, bank account, currency, active status)
- **Pagination:** `LIMIT/OFFSET`, with the total as a **separate count query** issued in parallel with the row query (`getAllWithCount`). `COUNT(*) OVER ()` was removed: the window function forced the planner to materialize and sort the whole filtered join before `LIMIT` on every page. Same `WHERE`, so the total is unchanged.
- **Count join sets:** `getUncategorisedWithCount`'s total CTE counts over a **reduced** join set (`LEFT JOIN recipients r` only) rather than the full 6-way `TRANSACTION_JOINS` the row query uses for its labels. `r` is the one alias `buildTransactionWhere` can reference (`recipientName`'s `r.name ILIKE`); the other five are projection-only and a count selects no labels. All six are `LEFT JOIN`s onto a **primary key**, so dropping the unreferenced ones can neither drop nor duplicate a row — the count is identical.
- **Soft Delete:** Sets `is_active = false`, rather than deleting the row
- **Recipient Group Filtering (Phase Q):** Supports `recipientGroupId` via `filterBuilder` to resolve full primary-recipient groups with an indexable semi-join on `recipients`; enables linked-recipient transaction discovery in OwesPage

### Dependencies
- `connection.js`
- `filterBuilder.js` (Phase Q)

---

## 2. recipientRepository.js

**File:** [[apps/node-backend/src/repositories/recipientRepository.js]]  
**Purpose:** CRUD for `recipients` table with merge/unmerge, alias management, and name-based matching.

### Exported Methods

| Method | Signature | Returns |
|--------|-----------|---------|
| `getAll` | `(opts: { filters?, limit?, offset? }) => Promise<Recipient[]>` | Filtered recipient list |
| `getCount` | `(opts: { filters? }) => Promise<number>` | Total count matching filters |
| `getById` | `(id: number) => Promise<Recipient \| null>` | Single recipient or null |
| `getByName` | `(name: string) => Promise<Recipient \| null>` | Recipient by exact name |
| `createOrGet` | `(data: { name, ... }) => Promise<{ recipient, created }>` | Existing or new recipient |
| `update` | `(id: number, fields: Partial<Recipient>) => Promise<Recipient>` | Updated recipient |
| `hardDelete` | `(id: number) => Promise<boolean>` | Deletion success |
| `mergeRecipients` | `(primaryId: number, aliasIds: number[]) => Promise<number[]>` | Merged alias IDs |
| `unmergeRecipient` | `(id: number) => Promise<boolean>` | Unmerge success |
| `getAliases` | `(primaryId: number) => Promise<Recipient[]>` | Alias recipients |

### Key Query Patterns

- **Optimistic Upsert:** `INSERT ... ON CONFLICT (normalized_name) DO NOTHING RETURNING id`
- **Merge Operation:** Updates `primary_id` on alias recipients, transfers transaction associations
- **Normalized Name Matching:** Uses `normalizeForMatching()` for case-insensitive, order-independent matching

### Dependencies
- `connection.js`
- `textNormalization.js`

---

## 3. categoryRepository.js

**File:** [[apps/node-backend/src/repositories/categoryRepository.js]]  
**Purpose:** CRUD for `categories` table with hierarchical `GENERAL:DETAIL` structure and recipient assignment.

### Exported Methods

| Method | Signature | Returns |
|--------|-----------|---------|
| `getAll` | `(opts: { filters?, limit?, offset? }) => Promise<Category[]>` | Category list |
| `getCount` | `(opts: { filters? }) => Promise<number>` | Total count |
| `getById` | `(id: number) => Promise<Category \| null>` | Single category or null |
| `getByGeneralDetail` | `(general: string, detail: string) => Promise<Category \| null>` | Category by parts |
| `createOrGet` | `(data: { general, detail }) => Promise<{ category, created }>` | Existing or new category |
| `update` | `(id: number, fields: Partial<Category>) => Promise<Category>` | Updated category |
| `hardDelete` | `(id: number) => Promise<boolean>` | Deletion success |
| `assignToRecipients` | `(categoryId: number, recipientIds: number[]) => Promise<number>` | Assignment count |

### Key Query Patterns

- **General/Detail Split:** Categories stored as separate columns, joined with `:` for display
- **Assignment Table:** Many-to-many via `category_recipients` junction table

### Dependencies
- `connection.js`

---

## 4. plannedTransactionRepository.js

**File:** [[apps/node-backend/src/repositories/plannedTransactionRepository.js]]  
**Purpose:** CRUD for `planned_transactions` table with recurrence patterns and loan schedule management.

### Exported Methods

| Method | Signature | Returns |
|--------|-----------|---------|
| `getAll` | `(opts: { filters?, limit?, offset? }) => Promise<{ items, total }>` | Paginated planned transactions |
| `getById` | `(id: number) => Promise<PlannedTransaction \| null>` | Single planned transaction |
| `create` | `(data: PlannedTransactionCreate) => Promise<PlannedTransaction>` | Created planned transaction |
| `update` | `(id: number, fields: Partial<PlannedTransaction>) => Promise<PlannedTransaction>` | Updated planned transaction |
| `hardDelete` | `(id: number) => Promise<boolean>` | Deletion success |
| `addExecution` | `(plannedTransactionId: number, txId: number, date: string) => Promise<void>` | Record execution |
| `replaceLoanSchedule` | `(id: number, schedule: LoanSchedule[]) => Promise<void>` | Replace loan amortization |

### Key Query Patterns

- **Recurrence Storage:** JSON field for recurrence pattern configuration
- **Loan Schedule:** Separate `loan_schedule` table linked to planned transaction
- **Execution Tracking:** `planned_executions` junction table tracks which planned transactions created which actual transactions

### Dependencies
- `connection.js`

---

## 5. recipientBankAccountRepository.js

**File:** [[apps/node-backend/src/repositories/recipientBankAccountRepository.js]]  
**Purpose:** CRUD for `recipient_bank_accounts` table with IBAN validation and primary account management.

### Exported Methods

| Method | Signature | Returns |
|--------|-----------|---------|
| `getAll` | `(opts: { recipientId? }) => Promise<RecipientBankAccount[]>` | Bank account list |
| `getById` | `(id: number) => Promise<RecipientBankAccount \| null>` | Single account or null |
| `getByRecipient` | `(recipientId: number) => Promise<RecipientBankAccount[]>` | Accounts for recipient |
| `create` | `(data: BankAccountCreate) => Promise<RecipientBankAccount>` | Created account |
| `update` | `(id: number, fields: Partial<BankAccount>) => Promise<RecipientBankAccount>` | Updated account |
| `hardDelete` | `(id: number) => Promise<boolean>` | Deletion success |

### Key Query Patterns

- **IBAN Normalization:** Stored uppercase, no spaces
- **Primary Flag:** Boolean `is_primary` per recipient (enforced at application level)

### Dependencies
- `connection.js`
- ~~`iban.js`~~ (deleted 2026-05-29; IBAN validation now handled inline)

---

## 6. investmentRepository.js

**File:** [[apps/node-backend/src/repositories/investmentRepository.js]]  
**Purpose:** CRUD for investment inheritance tables (`investments_base` + type-specific child tables) with legacy view compatibility.

### Exported Methods

| Method | Signature | Returns |
|--------|-----------|---------|
| `getAll` | `(opts: { assetClass?, limit?, offset? }) => Promise<Investment[]>` | Investment list |
| `getCount` | `(opts: { assetClass? }) => Promise<number>` | Total count |
| `getById` | `(id: number) => Promise<Investment \| null>` | Single investment or null |
| `create` | `(data: InvestmentCreate) => Promise<Investment>` | Created investment (routes to child table) |
| `update` | `(id: number, fields: Partial<Investment>) => Promise<Investment>` | Updated investment |
| `hardDelete` | `(id: number) => Promise<boolean>` | Deletion success |

### Key Query Patterns

- **PostgreSQL Inheritance:** Writes to child tables (`stock_investments`, `crypto_investments`, etc.), reads from `investments` legacy view
- **Type Routing:** `create` inserts into the appropriate child table based on `asset_class`
- **Legacy View Compatibility:** `investments` view unions all child tables for backward compatibility
- **NUMERIC Coercion (June 2026):** `coerceNumericFields(row, ['current_price', 'interest_rate', 'cadastral_income', 'municipality_tax_rate'])` applied via `mapInvestmentRow` on every row emitted by `getAll`, `getAllWithCount`, `getById`, `create`, `update`, and `updatePrice`. All inheritance paths return through `getById`, so coercion is covered end-to-end.

### Dependencies
- `connection.js`
- `../lib/money.js` (`coerceNumericFields`)

---

## 7. portfolioTransactionRepository.js

**File:** [[apps/node-backend/src/repositories/portfolioTransactionRepository.js]]  
**Purpose:** CRUD for portfolio transaction inheritance tables (`portfolio_transactions_base` + type-specific children).

### Exported Methods

| Method | Signature | Returns |
|--------|-----------|---------|
| `getAll` | `(opts: { investmentId?, limit?, offset? }) => Promise<PortfolioTransaction[]>` | Portfolio transaction list |
| `getById` | `(id: number) => Promise<PortfolioTransaction \| null>` | Single transaction or null |
| `getByInvestment` | `(investmentId: number) => Promise<PortfolioTransaction[]>` | Transactions for investment |
| `create` | `(data: PortfolioTransactionCreate) => Promise<PortfolioTransaction>` | Created transaction |
| `update` | `(id: number, fields: Partial<PortfolioTransaction>) => Promise<PortfolioTransaction>` | Updated transaction |
| `hardDelete` | `(id: number) => Promise<boolean>` | Deletion success |

### Key Query Patterns

- **Inheritance:** Same pattern as investments — writes to child tables, reads from `portfolio_transactions` view
- **Units Tracking:** `units`, `price_per_unit`, `total_amount` for unit-based assets
- **NUMERIC Coercion (June 2026):** `mapPortfolioTxRow` (exported from `portfolioTxRepo.reads.js`) coerces `['amount', 'units', 'price_per_unit', 'fees', 'taxes', 'fx_rate_to_eur']` on every row; reused in `portfolioTxRepo.writes.js` so write paths are also coerced. `getSummary` additionally coerces totals (`total_amount`, `total_units`, `total_fees`, `total_taxes`) and applies `parseInt` to `count`.

### Dependencies
- `connection.js`
- `../lib/money.js` (`coerceNumericFields`)

---

## 8. watchlistRepository.js

**File:** [[apps/node-backend/src/repositories/watchlistRepository.js]]  
**Purpose:** CRUD for `watchlist` table — track symbols without owning them.

### Exported Methods

| Method | Signature | Returns |
|--------|-----------|---------|
| `getAll` | `(opts: { limit?, offset?, assetClass? }) => Promise<Watchlist[]>` | Watchlist items |
| `getAllWithCount` | `(opts: { limit?, offset?, assetClass? }) => Promise<{ rows, total }>` | Paginated results with total |
| `getCount` | `(opts: { assetClass? }) => Promise<number>` | Total count |
| `getById` | `(id: number) => Promise<Watchlist \| null>` | Single item or null |
| `create` | `(data: WatchlistCreate) => Promise<Watchlist>` | Created item |
| `update` | `(id: number, fields: Partial<Watchlist>) => Promise<Watchlist>` | Updated item |
| `delete` | `(id: number) => Promise<boolean>` | Deletion success |

### Key Query Patterns

- **NUMERIC Coercion (June 2026):** `coerceNumericFields(row, ['target_price'])` via `mapWatchlistRow` on every emitted row. `current_price` and `price_change` are not stored in this table — they are appended by the route from the price provider.

### Dependencies
- `connection.js`
- `../lib/money.js` (`coerceNumericFields`)

---

## 9. splitRepository.js

**File:** [[apps/node-backend/src/repositories/splitRepository.js]]  
**Purpose:** Manages transaction splits, owed summaries, payments, and settlements.

### Exported Methods

| Method | Signature | Returns |
|--------|-----------|---------|
| `getTransactionSplitTotals` | `(transactionId: number) => Promise<{ transaction_total, current_split_total } \| null>` | Split totals |
| `createSplit` | `({ transaction_id, recipient_id, amount, note }) => Promise<Split>` | Created split |
| `getSplitsByTransaction` | `(transactionId: number) => Promise<Split[]>` | Splits for transaction |
| `getOwedSummary` | `() => Promise<OwedSummary[]>` | Who owes whom summary |
| `getOwedByRecipient` | `(recipientId: number) => Promise<OwedData>` | Detailed owed data |
| `getOwedExportRowsByRecipient` | `(recipientId: number) => Promise<OwedExportRow[]>` | CSV export rows |
| `addPayment` | `({ split_id, amount, note, paid_at }) => Promise<Payment>` | Recorded payment |
| `getPayments` | `(splitId: number) => Promise<Payment[]>` | Payments for split |
| `settleSplit` | `(splitId: number) => Promise<Split>` | Settled split |
| `settleAllByRecipient` | `(recipientId: number) => Promise<{ settled_count: number }>` | Bulk settle count |
| `deleteSplit` | `(splitId: number) => Promise<boolean>` | Deletion success |

### Key Query Patterns

- **Owed Aggregation:** Complex CTE query joining splits, payments, and transactions to compute net owed amounts
- **Amount Validation:** `getTransactionSplitTotals` ensures split amounts don't exceed transaction total
- **Partial Payments:** Multiple payments per split tracked in `split_payments` table

### Dependencies
- `connection.js`

---

## 10. settingsRepository.js

**File:** [[apps/node-backend/src/repositories/settingsRepository.js]]  
**Purpose:** Key-value settings storage with JSON serialization.

### Exported Methods

| Method | Signature | Returns |
|--------|-----------|---------|
| `get` | `(key: string) => Promise<any>` | Setting value or undefined |
| `set` | `(key: string, value: any) => Promise<void>` | Set single setting |
| `setMany` | `(settings: Record<string, any>) => Promise<void>` | Bulk upsert |
| `getAll` | `() => Promise<Record<string, any>>` | All settings as object |
| `delete` | `(key: string) => Promise<boolean>` | Deletion success |

### Key Query Patterns

- **JSON Storage:** Values stored as JSONB in `user_settings` table
- **Upsert Pattern:** `INSERT ... ON CONFLICT (key) DO UPDATE SET`

### Dependencies
- `connection.js`

---

## 11. savedChartsRepository.js

**File:** [[apps/node-backend/src/repositories/savedChartsRepository.js]]  
**Purpose:** CRUD for `saved_charts` table — user-configurable chart configurations.

### Exported Methods

| Method | Signature | Returns |
|--------|-----------|---------|
| `getAll` | `() => Promise<SavedChart[]>` | All saved charts |
| `getById` | `(id: number) => Promise<SavedChart \| null>` | Single chart or null |
| `create` | `(data: SavedChartCreate) => Promise<SavedChart>` | Created chart |
| `update` | `(id: number, fields: Partial<SavedChart>) => Promise<SavedChart>` | Updated chart |
| `hardDelete` | `(id: number) => Promise<boolean>` | Deletion success |

### Dependencies
- `connection.js`

---

## 12. rawTransactionRepository.js

**File:** [[apps/node-backend/src/repositories/rawTransactionRepository.js]]  
**Purpose:** Manages raw transaction data in bank-specific tables for audit trail and deduplication.

### Exported Methods

| Method | Signature | Returns |
|--------|-----------|---------|
| `getAll` | `(opts: { bankName?, limit?, offset? }) => Promise<RawTransaction[]>` | Raw transaction list |
| `getByHash` | `(hash: string) => Promise<RawTransaction \| null>` | Transaction by SHA-256 hash |
| `insert` | `(data: RawTransactionCreate) => Promise<RawTransaction>` | Inserted raw transaction |
| `hardDelete` | `(id: number) => Promise<boolean>` | Deletion success |

### Key Query Patterns

- **Bank-Specific Tables:** Separate tables per bank (`raw_belfius`, `raw_revolut`, etc.) for raw CSV data
- **Hash-based Dedup:** SHA-256 hash of raw CSV line prevents re-importing same data
- **Reference Linking:** `transaction_raw_references` table links raw rows to normalized transactions

### Dependencies
- `connection.js`

---

## 13. infoRepository.js (Composite Module — Phase 3.1)

**File:** [[apps/node-backend/src/repositories/infoRepository.js]]  
**Purpose:** Barrel module (37 lines) that re-exports analytics and statistics repositories organized by domain. Originally 1445-line monolithic repository; refactored in Phase 3.1 into 7 domain-specific sub-repositories for improved maintainability and separation of concerns.

**Phase 3.1 Refactoring (2026-04-23):**
- Monolithic 1445-line `infoRepository.js` split into domain-organized sub-modules
- Batch FX conversion optimization: combined N-row groups into single `convertRowsToEur` call with one `exchange_rates` query, eliminating redundant per-group lookups
- `getCashflowComparison`: 4 sequential queries → `Promise.all` + 1 batch FX call (saved 3 `exchange_rates` queries)
- `getAverageVsCurrentSpending`: 2 sequential queries → `Promise.all` (FX already cached)
- `getBankBalances`: 2 sequential queries → `Promise.all` + 1 batch FX call (saved 1 `exchange_rates` query)
- All 1223 tests pass; API contracts unchanged

### Domain Sub-Repositories

| Sub-Module | File | Lines | Purpose |
|-----------|------|-------|---------|
| `infoRepositoryHelpers.js` | `[[apps/node-backend/src/repositories/infoRepositoryHelpers.js]]` | 268 | Repository-specific MV cache, aggregation, category, row-mapping, and currency-conversion helpers; compatibility re-exports point generic helpers to their canonical owners |
| `statisticsRepository` | `[[apps/node-backend/src/repositories/infoRepositoryStatistics.js]]` | 186 | `getStatistics`, `getCategoryBreakdown`, `getBanks`, `getTransactionCount`, `getTransactionSummary` |
| `monthlyRepository` | `[[apps/node-backend/src/repositories/infoRepositoryMonthly.js]]` | 484 | `getMonthlyFinancialSummary`, `getAverageVsCurrentSpending`, `getCashflowComparison`; uses batch FX conversion and parallel queries |
| `banksRepository` | `[[apps/node-backend/src/repositories/infoRepositoryBanks.js]]` | 145 | `getBankBalances`; uses batch FX conversion and parallel queries |
| `netWorthRepository` | `[[apps/node-backend/src/repositories/infoRepositoryNetWorth.js]]` | 559 | `getNetWorthFromSnapshots` with snapshot-based valuation and spike sanitization |
| `plannedRepository` | `[[apps/node-backend/src/repositories/infoRepositoryPlanned.js]]` | 94 | `getPlannedExpensesNextMonth` |
| `recipientInsightsRepository` | `[[apps/node-backend/src/repositories/infoRepositoryRecipients.js]]` | 124 | `getRecipientInsights` |

### Barrel Module Exports

The main `infoRepository.js` file:
- Re-exports `clearMvCache` from helpers for cache invalidation
- Assembles all sub-repos into a single `infoRepository` object with all methods
- Supports both `export default infoRepository` and `export const infoRepository` for backward compatibility
- All 9 existing consumer files import unchanged from `infoRepository.js`; internal organization is transparent

### Original Exported Methods (Now Delegated)

| Method | Delegated To | Signature | Returns |
|--------|--------------|-----------|---------|
| `getStatistics` | statisticsRepository | `() => Promise<Statistics>` | General statistics |
| `getBanks` | statisticsRepository | `() => Promise<Bank[]>` | Supported bank list |
| `getTransactionSummary` | statisticsRepository | `(filters?) => Promise<TransactionSummary>` | Filtered transaction summary |
| `getMonthlyFinancialSummary` | monthlyRepository | `() => Promise<MonthlySummary[]>` | Monthly income/expense |
| `getCategoryBreakdown` | statisticsRepository | `() => Promise<CategoryBreakdown[]>` | Spending by category |
| `getBankBalances` | banksRepository | `(targetCurrency?) => Promise<BankBalance[]>` | Bank balances with FX conversion |
| `getNetWorthFromSnapshots` | netWorthRepository | `(currency?) => Promise<NetWorth>` | Net worth with daily breakdown |
| `getRecipientInsights` | recipientInsightsRepository | `(currency?) => Promise<RecipientInsight[]>` | Recipient analytics |
| `getAverageVsCurrentSpending` | monthlyRepository | `() => Promise<...>` | Average vs. current spending |
| `getCashflowComparison` | monthlyRepository | `() => Promise<...>` | Cashflow period comparison |
| `getPlannedExpensesNextMonth` | plannedRepository | `() => Promise<...>` | Planned expenses forecast |
| `clearMvCache` | helpers | `() => void` | Clear materialized view cache |

### Key Query Patterns (Unified)

- **Materialized Views:** All sub-repos read from `monthly_summaries_mv`, `category_totals_mv`, `daily_cashflow_mv`, `bank_balances_mv`
- **FX Conversion:** Multi-currency endpoints support `targetCurrency` parameter with date-aware historical rate fallback
- **Batch FX Optimization (Phase 3.1):** `batchConvertGroupsWithHistoricalRateFallback()` helper in `infoRepositoryHelpers.js` combines N row groups into 1 `convertRowsToEur` call, eliminating redundant `exchange_rates` queries per group
- **Parallel Query Execution:** `Promise.all` for independent queries (`getMonthlyFinancialSummary`, `getCashflowComparison`, `getBankBalances`, `getAverageVsCurrentSpending`)
- **Spike Sanitization:** `getNetWorthFromSnapshots` applies `sanitizeIsolatedDailyInvestmentSpikes()` from `lib/calculations/netWorthSanitizer.js`; the wrapper delegates needle detection and numeric smoothing to `lib/calculations/valueSpikeSanitizer.js`, then recomputes the corrected row's net worth with liabilities included
- **Complex Aggregations:** CTEs with window functions for recipient insights and category breakdowns
- **Shared Utilities:** `infoRepositoryHelpers.js` centralizes repository-specific MV caching, aggregation, category merging, row mapping, and currency conversion fallback. Generic date keys live in `lib/dateKeys.js`; date serialization in `lib/dateFormat.js`; numeric rounding in `lib/money.js`.

### Dependencies (All Sub-Modules)
- `connection.js`
- `currencyConversionService.js` (for FX conversions)
- `infoRepositoryHelpers.js` (repository aggregation helpers and MV cache)
- `lib/dateKeys.js`, `lib/dateFormat.js`, and `lib/money.js` (generic formatting and rounding)
- `lib/calculations/valueSpikeSanitizer.js` (shared numeric needle rule) and `lib/calculations/netWorthSanitizer.js` (net-worth recomputation wrapper)

---

## Repository Dependency Map

```
connection.js (PostgreSQL pool)
    │
    ├── transactionRepository
    ├── recipientRepository ──→ textNormalization
    ├── categoryRepository
    ├── plannedTransactionRepository
    ├── recipientBankAccountRepository ──→ iban
    ├── investmentRepository
    ├── portfolioTransactionRepository
    ├── watchlistRepository
    ├── splitRepository
    ├── settingsRepository
    ├── savedChartsRepository
    ├── rawTransactionRepository
    │
    └── infoRepository (barrel, Phase 3.1 refactor) ──→ currencyConversionService
            │
            ├─→ infoRepositoryHelpers (repository helpers: mvCache, aggregation/category/FX helpers,
            │                          batchConvertGroupsWithHistoricalRateFallback for batch FX optimization)
            ├─→ lib/dateKeys + lib/dateFormat + lib/money (generic date and rounding helpers)
            ├─→ lib/calculations/netWorthSanitizer ──→ valueSpikeSanitizer (shared needle rule)
            │
            ├─→ infoRepositoryStatistics (getStatistics, getCategoryBreakdown, getBanks, getTransactionCount, getTransactionSummary)
            │       └→ connection.js
            │
            ├─→ infoRepositoryMonthly (getMonthlyFinancialSummary, getAverageVsCurrentSpending, getCashflowComparison)
            │       ├→ connection.js
            │       └→ batchConvertGroupsWithHistoricalRateFallback (batch FX + parallel queries)
            │
            ├─→ infoRepositoryBanks (getBankBalances)
            │       ├→ connection.js
            │       └→ batchConvertGroupsWithHistoricalRateFallback (batch FX + parallel queries)
            │
            ├─→ infoRepositoryNetWorth (getNetWorthFromSnapshots)
            │       └→ connection.js
            │
            ├─→ infoRepositoryPlanned (getPlannedExpensesNextMonth)
            │       └→ connection.js
            │
            └─→ infoRepositoryRecipients (getRecipientInsights)
                    └→ connection.js
```

## Common Patterns

### Pagination Pattern

All list repositories support pagination via `LIMIT/OFFSET` with total count:

```javascript
// Pattern A: Separate count query
const total = await getCount(filters);
const rows = await getAll({ ...filters, limit, offset });

// Pattern B: Window function (single query)
const { rows, total } = await getAllWithCount({ filters, limit, offset });
```

### Optimistic Upsert Pattern

```sql
INSERT INTO table (columns)
VALUES ($1, $2, ...)
ON CONFLICT (unique_constraint) DO NOTHING
RETURNING id
```

### Soft Delete Pattern

Uses the `is_active` flag instead of `DELETE`:

```sql
UPDATE transactions SET is_active = false WHERE id = $1
```

## 14. tagRepository.js

**File:** [[apps/node-backend/src/repositories/tagRepository.js]]
**Purpose:** CRUD for the `tags` table (orthogonal labelling dimension, ADR-052). Soft-delete via `is_active=false`.

| Method | Returns |
|--------|---------|
| `getAll({ isActive? })` | tag list |
| `findOrCreateBySlug(name, color)` | upsert by normalised slug |
| `update(id, fields)` | updated tag |
| `softDelete(id)` | boolean |
| `attachToTransactions(tagIds, txIds)` / `detachFromTransactions(...)` | join-table maintenance |

---

## 15. attachmentRepository.js

**File:** [[apps/node-backend/src/repositories/attachmentRepository.js]]
**Purpose:** Persists receipt attachment metadata (stored path, mime type, size). The on-disk file lifecycle lives in [[apps/node-backend/src/services/attachmentService.js|attachmentService.js]].

| Method | Returns |
|--------|---------|
| `insert(metadata)` | created row |
| `getById(id)` / `listByTransaction(txId)` | rows |
| `delete(id)` | boolean |

---

## 16. importBatchRepository.js

**File:** [[apps/node-backend/src/repositories/importBatchRepository.js]]
**Purpose:** Persists `import_batches` + `import_rows` for the import pipeline (stage / validate / match / commit phases).

| Method | Returns |
|--------|---------|
| `createBatch(meta)` | batch id |
| `insertStaged(batchId, rows)` | inserted count |
| `markPhase(batchId, phase, payload)` | progress metadata |
| `listRecent(limit)` | history view |
| `getRowsForReview(batchId)` | ambiguous rows |
| `deleteBatch(batchId)` | rollback |

---

## 17. aiChatRepository.js

**File:** [[apps/node-backend/src/repositories/aiChatRepository.js]]
**Purpose:** Persists Ollama chat conversations and per-turn tool transcripts for the AI Chat feature (ADR-024).

| Method | Returns |
|--------|---------|
| `loadConversation(id)` | message history |
| `persistTurn(id, prompt, toolTranscript, answer)` | inserted row |
| `listConversations(limit)` | rows |
| `delete(id)` | boolean |

---

## 18. providerHealthRepository.js

**File:** [[apps/node-backend/src/repositories/providerHealthRepository.js]]
**Purpose:** Rolling-window health metrics per external provider (latency, success/error counts). Drives the admin observability hub (ADR-034).

| Method | Returns |
|--------|---------|
| `record({ provider, ok, latencyMs, statusCode, error? })` | void |
| `getSummary()` | rows grouped by provider |
| `getRecent({ provider, window })` | sample rows |

---

## 19. cashflowForecastMcRepository.js

**File:** [[apps/node-backend/src/repositories/cashflowForecastMcRepository.js]]
**Purpose:** Stores Monte-Carlo cashflow forecast snapshots (P25/P50/P75 paths) — the materialised cache for Phase 10 + Phase E forecast endpoints.

| Method | Returns |
|--------|---------|
| `upsertSnapshot(params, paths)` | stored snapshot |
| `getCached(params, ttl)` | cached snapshot or null |

---

## 20. cashflowForecastMcRollingRepository.js

**File:** [[apps/node-backend/src/repositories/cashflowForecastMcRollingRepository.js]]
**Purpose:** Same shape as `cashflowForecastMcRepository.js` but specialised for the Phase H rolling-window forecast (500 paths, P25/P75 defaults).

---

## 21. cashflowForecastAccuracyRepository.js

**File:** [[apps/node-backend/src/repositories/cashflowForecastAccuracyRepository.js]]
**Purpose:** Persists realised-vs-forecast accuracy metrics per snapshot. Powers the Phase D accuracy endpoint and dashboard widget.

| Method | Returns |
|--------|---------|
| `recordAccuracy(snapshotId, metrics)` | void |
| `getRolling({ window })` | accuracy time-series |

---

## portfolioTransactionRepository sub-modules

`portfolioTransactionRepository.js` is split into three files for clarity:

- [[apps/node-backend/src/repositories/portfolioTxRepo.common.js|portfolioTxRepo.common.js]] — portfolio normalization and validation helpers, mappers, and the public barrel.
- [[apps/node-backend/src/repositories/portfolioTxRepo.reads.js|portfolioTxRepo.reads.js]] — read paths (list, summary, by-investment). Exports `mapPortfolioTxRow` (the NUMERIC coercion mapper) so write paths can reuse it.
- [[apps/node-backend/src/repositories/portfolioTxRepo.writes.js|portfolioTxRepo.writes.js]] — mutations (create, update, FIFO/LIFO cost-basis recompute); imports `mapPortfolioTxRow` from the reads module.

`investmentRepository.js`, `portfolioTxRepo.common.js`, and `portfolioTxRepo.writes.js` use [[apps/node-backend/src/lib/repositoryErrors.js|repositoryErrors.js]] as the canonical owner of coded repository validation errors. This keeps the `VALIDATION_ERROR` contract independent of either repository family.

---

## Related Documentation

- [[docs/adr/006-three-layer-architecture|ADR-006: Three-Layer Architecture]]
- [[docs/reference/service-layer|Service Layer Reference]]
- [[docs/adr/004-postgresql-table-inheritance|ADR-004: PostgreSQL Table Inheritance]]
- [[docs/reference/data-model|Data Model Reference]]
- [[docs/diagrams/backend-repository-layer|Repository Layer Diagram]]
