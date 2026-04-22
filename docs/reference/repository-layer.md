---
title: Repository Layer Reference
type: reference
status: active
date: 2026-04-21
tags: [backend, repositories, reference, data-access, postgresql, phase-0, phase-1]
aliases: [repositories, repository layer, data access, DAL, database access]
description: Complete reference for all 13 backend repositories — exported methods, SQL patterns, and usage conventions
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

- **Dynamic WHERE Building:** Constructs filter clauses from `opts.filters` object (date range, category, recipient, amount, bank account, currency, hidden status)
- **Pagination:** `LIMIT/OFFSET` with `COUNT(*) OVER()` for total
- **Soft Delete:** Uses `hidden` boolean flag, not `DELETE`

### Dependencies
- `connection.js`

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
- `iban.js`

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

### Dependencies
- `connection.js`

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

### Dependencies
- `connection.js`

---

## 8. watchlistRepository.js

**File:** [[apps/node-backend/src/repositories/watchlistRepository.js]]  
**Purpose:** CRUD for `watchlist` table — track symbols without owning them.

### Exported Methods

| Method | Signature | Returns |
|--------|-----------|---------|
| `getAll` | `(opts: { limit?, offset? }) => Promise<Watchlist[]>` | Watchlist items |
| `getById` | `(id: number) => Promise<Watchlist \| null>` | Single item or null |
| `create` | `(data: WatchlistCreate) => Promise<Watchlist>` | Created item |
| `update` | `(id: number, fields: Partial<Watchlist>) => Promise<Watchlist>` | Updated item |
| `hardDelete` | `(id: number) => Promise<boolean>` | Deletion success |

### Dependencies
- `connection.js`

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

## 13. infoRepository.js

**File:** [[apps/node-backend/src/repositories/infoRepository.js]]  
**Purpose:** Read-only analytics and statistics queries — dashboard data, bank balances, net worth, recipient insights.

### Exported Methods

| Method | Signature | Returns |
|--------|-----------|---------|
| `getStatistics` | `() => Promise<Statistics>` | General statistics |
| `getBanks` | `() => Promise<Bank[]>` | Supported bank list |
| `getTransactionSummary` | `(filters?) => Promise<TransactionSummary>` | Filtered transaction summary |
| `getMonthlySummary` | `() => Promise<MonthlySummary[]>` | Monthly income/expense |
| `getCategoryBreakdown` | `() => Promise<CategoryBreakdown[]>` | Spending by category |
| `getBankBalances` | `(targetCurrency?) => Promise<BankBalance[]>` | Bank balances with FX conversion |
| `getNetWorth` | `(currency?) => Promise<NetWorth>` | Net worth with daily breakdown |
| `getRecipientInsights` | `(currency?) => Promise<RecipientInsight[]>` | Recipient analytics |
| `getExchangeRates` | `() => Promise<ExchangeRate[]>` | Current exchange rates |

### Key Query Patterns

- **Materialized Views:** Reads from `monthly_summaries_mv`, `category_totals_mv`, `daily_cashflow_mv`, `bank_balances_mv`
- **FX Conversion:** `getBankBalances` and `getNetWorth` support `targetCurrency` parameter for currency conversion
- **Spike Sanitization:** `getNetWorth` applies Kinesis spike sanitization on investment value data
- **Complex Aggregations:** CTEs with window functions for recipient insights and category breakdowns

### Dependencies
- `connection.js`
- `currencyConversionService.js`

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
    └── infoRepository ──→ currencyConversionService
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

Uses `hidden` boolean flag instead of `DELETE`:

```sql
UPDATE transactions SET hidden = true WHERE id = $1
```

## Related Documentation

- [[docs/adr/006-three-layer-architecture|ADR-006: Three-Layer Architecture]]
- [[docs/reference/service-layer|Service Layer Reference]]
- [[docs/adr/004-postgresql-table-inheritance|ADR-004: PostgreSQL Table Inheritance]]
- [[docs/reference/data-model|Data Model Reference]]
- [[docs/diagrams/backend-repository-layer|Repository Layer Diagram]]
