---
title: Transactions
type: feature
status: active
date: 2026-04-10
tags: [feature, transactions, finance]
aliases: [transactions-feature, income, expenses, financial-records, money-tracking]
description: Core transaction management - income, expenses, and tracking financial activities
related_code: ["apps/node-backend/src/routes/transactions.js", "apps/node-backend/src/repositories/transactionRepository.js", "apps/frontend/src/components/shared/VirtualDataTable.tsx", "apps/frontend/src/components/shared/DataTable.tsx", "apps/frontend/src/components/shared/ColumnFilter.tsx", "apps/frontend/src/pages/TransactionsPage.tsx"]
---

# Transactions

The core of Vision - managing financial transactions including income, expenses, and transfers.

## Overview

Transactions represent any financial movement - from grocery shopping to salary deposits. Each transaction is linked to a recipient and can be categorized for organization and analysis.

## Transaction Model

### Core Fields

| Field | Type | Description |
|-------|------|-------------|
| `date` | date | Transaction date (YYYY-MM-DD) |
| `bank_account` | string | Source/destination bank account |
| `recipient_id` | number | Linked recipient |
| `amount` | number | Transaction amount |
| `memo` | string | Transaction description |
| `currency` | string | Currency code (ISO 4217) |
| `balance` | number | Running balance after transaction |
| `category_id` | number | Assigned category |
| `comment` | user_note | User-added comment |

### Amount Convention

- **Negative values** = Expenses (money leaving)
- **Positive values** = Income (money entering)

```javascript
// Expense
{ amount: -45.50 }

// Income  
{ amount: 2500.00 }
```

---

## Features

### Categorization

Transactions can be assigned categories using the `GENERAL:DETAIL` format:

- `FOOD:GROCERIES` - Grocery shopping
- `FOOD:DINING` - Restaurants
- `TRANSPORT:CAR` - Car expenses
- `TRANSPORT:PUBLIC` - Public transit

Categories can be inherited from recipients if not explicitly set.

---

### Recipient Association

Every transaction is linked to a recipient (payee/payer). Recipients can have:
- Default category preferences
- Associated bank accounts
- Notes and metadata

---

### CSV Import

Transactions can be imported from bank CSV exports. The import process includes:
1. Text normalization (cleaning descriptions)
2. Deduplication (preventing duplicates)
3. Recurring detection (identifying subscription payments)
4. Auto-categorization

See [[docs/features/import]] for details.

---

### Search & Filtering

Transactions support rich filtering:

- Date range (start/end)
- Exact transaction ID
- Category filter
- Recipient filter
- Amount range (min/max)
- Bank account
- Currency

Implementation note:
- Backend route parsing/normalization for list filters is centralized in `parseTransactionListQuery`, preserving existing defaults and coercion behavior while reducing duplicate parsing logic ([[apps/node-backend/src/routes/transactions.js]]).
- Backend non-`uncategorised` list path now uses repository one-query pagination (`getAllWithCount`) instead of separate list and count queries, reducing DB round-trips while preserving filters/totals/response shape ([[apps/node-backend/src/routes/transactions.js]], [[apps/node-backend/src/repositories/transactionRepository.js]]).
- Backend `uncategorised=true` list path now uses dedicated repository one-query pagination (`getUncategorisedWithCount`) instead of route-level dual queries, preserving uncategorised row filtering and historical total semantics while reducing route round-trips ([[apps/node-backend/src/routes/transactions.js]], [[apps/node-backend/src/repositories/transactionRepository.js]]).
- PATCH name-resolution and CSV export DB-access helpers now use module-scoped imports (`dbQuery`, `normalizeForMatching`) instead of per-request dynamic imports, preserving route behavior while removing avoidable import overhead on hot paths ([[apps/node-backend/src/routes/transactions.js]]).
- PATCH recipient/category name-resolution now runs concurrently and keeps existing recipient-first/category-second validation error precedence, reducing avoidable sequential lookup latency when both fields are provided ([[apps/node-backend/src/routes/transactions.js]]).
- Repository transaction update now returns the enriched row via one CTE query (update + joins) instead of update followed by `getById`, preserving response shape and not-found behavior while reducing one DB round-trip per update ([[apps/node-backend/src/repositories/transactionRepository.js]]).

#### Table Search Sync Behavior

- Transaction table search input updates immediately in the UI and persists after execution.
- Server filtering is debounced at 200ms through `VirtualDataTable` for a more live feel while keeping request volume controlled.
- Search reacts correctly when loosening terms (character-by-character deletion) and when clearing entirely.
- Table rows are rendered from a deferred data value (`useDeferredValue`) so typing remains responsive while results refresh.
- Filter/sort/search pipelines preserve stable source-row identity through `sourceIndex` mapping, so row edits/actions always target the original source row even when table ordering changes.
- `TransactionsPage` handlers now consistently consume `sourceIndex` semantics from shared table components.

Code links: [[apps/frontend/src/components/shared/VirtualDataTable.tsx]], [[apps/frontend/src/components/shared/DataTable.tsx]], [[apps/frontend/src/components/shared/ColumnFilter.tsx]], [[apps/frontend/src/pages/TransactionsPage.tsx]], [[apps/frontend/src/pages/RecipientsPage.tsx]]

---

### Extra Information Dialog Inline Editing

- In the transaction extra information dialog, existing detail rows can now be edited inline using a per-row pencil action.
- Transaction ID is displayed for reference and remains non-editable.
- Inline row editing provides save/cancel controls and persists through the existing transaction update flow (`PATCH /api/transactions/:id`).

Code link: [[apps/frontend/src/pages/TransactionsPage.tsx]]

---

### Export

Export transactions to CSV for external analysis:

```
GET /api/transactions/export/csv?start_date=2025-01-01&end_date=2025-03-18
```

Implementation note:
- CSV escaping, row construction, and filename generation now use extracted helpers (`escapeCsvValue`, `buildTransactionCsvRow`, `buildTransactionExportFilename`) with unchanged output format.
- CSV export now neutralizes spreadsheet-formula-leading values (`=`, `+`, `-`, `@`) before writing cells to reduce formula-injection risk in spreadsheet tools.
- Export and PATCH error responses now avoid leaking internal exception details and return sanitized generic `detail` payloads.

---

## Planned Transactions

Vision supports scheduled/recurring transactions through planned transactions:

- **One-time** - Single future payment
- **Recurring** - Regular payments (weekly, monthly, yearly)
- **Loans** - Special handling for loan repayments

See [[docs/api/plannedTransactions]] for the API.

---

## Analytics Integration

Transactions feed into various analytics views:

- **Monthly summary** - Income vs. expenses by month
- **Category breakdown** - Spending by category
- **Cashflow** - Daily/weekly/monthly trends
- **Trends** - Year-over-year comparison

---

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/transactions` | List transactions (paginated) |
| POST | `/api/transactions` | Create transaction |
| GET | `/api/transactions/:id` | Get single transaction |
| PATCH | `/api/transactions/:id` | Update transaction |
| DELETE | `/api/transactions/:id` | Delete transaction |
| GET | `/api/transactions/export/csv` | Export to CSV |
| PATCH | `/api/transactions/batch` | Batch update |

---

## Rate Limiting

Heavy operations (export, batch updates) are rate-limited to protect database performance.

---

## Best Practices

1. **Import regularly** - Set up recurring CSV imports from your bank
2. **Review categories** - Check categorization accuracy monthly
3. **Use consistent naming** - Establish clear recipient names
4. **Track cash** - Create "CASH" bank account for cash transactions

---

## Related Documentation

- [[docs/api/transactions]] - Transaction API Reference
- [[docs/api/categories]] - Categories API
- [[docs/api/recipients]] - Recipients API
- [[docs/features/import]] - CSV Import Feature
- [[docs/features/portfolio]] - Portfolio & Investments

## Migrations

- `0001_initial_database_schema.py` — Initial schema with `transactions`, `categories`, `recipients` tables
- `0003_make_recipient_nullable.py` — Made `recipient_id` nullable on transactions
- `0005_manual_raw_transactions.py` — Added `manual_raw_transactions` table for manual entry deduplication
- `0007_recipient_merge.py` — Added `primary_recipient_id` for recipient merge support
- `0008_drop_custom_raw_transactions.py` — Dropped `custom_raw_transactions` table (custom imports now use generic path)
- `0012_add_indexes.py` — Performance indexes on transactions and related tables
