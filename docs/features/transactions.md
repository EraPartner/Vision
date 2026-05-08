---
title: Transactions
type: feature
status: active
date: 2026-04-16
updated: 2026-05-08
tags: [feature, transactions, finance, phase-q, recipient-groups, bulk-actions]
aliases: [transactions-feature, income, expenses, financial-records, money-tracking]
description: Core transaction management - income, expenses, and tracking financial activities. Phase Q adds recipient-group filtering for linked-recipient transaction discovery. Bulk operations enable atomic multi-row delete, recategorize, reassign, activate/deactivate, export, and tag.
related_code: ["apps/node-backend/src/routes/transactions.js", "apps/node-backend/src/repositories/transactionRepository.js", "apps/node-backend/src/services/filterBuilder.js", "apps/node-backend/src/services/bulkSelection.js", "apps/frontend/src/features/transactions/", "apps/frontend/src/pages/TransactionsPage.tsx"]
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

### Tags

Transactions can be tagged with freeform labels (e.g., `rome-2020`, `home-renovation`) to enable cross-cutting groupings that span categories. Tags are a second, orthogonal classification dimension — a single transaction can have both a category and multiple tags simultaneously.

Key capabilities:
- Create tags on first use with auto-slug normalisation
- Attach tags to individual transactions via the info dialog
- Bulk-tag multiple transactions via checkbox selection + toolbar
- Filter the transaction list by one or more tags
- Soft-delete tags; historical tags are preserved

See [[docs/features/tags]] for the complete tagging feature spec.

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
- Recipient filter (direct + aliases via `recipient_id`)
- Recipient group filter (full primary group via `recipient_group_id`, Phase Q)
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
- `recipientGroupId` filter in `buildTransactionWhere` resolves the full primary-recipient group via scalar subqueries (Phase Q), enabling linked-recipient transaction history discovery ([[apps/node-backend/src/services/filterBuilder.js]]).

#### Table Search Sync Behavior

- Transaction table search input updates immediately in the UI and persists after execution.
- Server filtering is debounced at 200ms through `VirtualDataTable` for a more live feel while keeping request volume controlled.
- Search reacts correctly when loosening terms (character-by-character deletion) and when clearing entirely.
- Table rows are rendered from a deferred data value (`useDeferredValue`) so typing remains responsive while results refresh.
- Filter/sort/search pipelines preserve stable source-row identity through `sourceIndex` mapping, so row edits/actions always target the original source row even when table ordering changes.
- `TransactionsPage` handlers now consistently consume `sourceIndex` semantics from shared table components.

Code links: [[apps/frontend/src/components/shared/VirtualDataTable.tsx]], [[apps/frontend/src/components/shared/DataTable.tsx]], [[apps/frontend/src/components/shared/ColumnFilter.tsx]], [[apps/frontend/src/pages/TransactionsPage.tsx]], [[apps/frontend/src/pages/RecipientsPage.tsx]]

#### Frontend Page Decomposition (Phase 5)

TransactionsPage has been decomposed into feature-scoped modules under [[apps/frontend/src/features/transactions/]] to improve maintainability and code organization:

- `types.ts` — Shared types: `TableTransaction`, `RawApiTransaction`, `InfoEditableField`
- `hooks/useTransactionListData.ts` — React Query hook for infinite-scroll list data management; owns `allItems`, sort/search/filter state, `loadMore`, and editing guards
- `components/FilterBanner.tsx` — Displays active filter pills and clear-all action
- `components/TableActions.tsx` — Toolbar actions: CSV export button and "show inactive" toggle
- `components/TransactionsTable.tsx` — `VirtualDataTable` wrapper with column renderers (category/recipient comboboxes, inline date/amount edit, row toggle/delete, info/split dialogs)
- `components/TransactionInfoDialog.tsx` — Per-row info display and inline field editor
- `pages/TransactionsPage.tsx` — Slim composer (~280 LOC) that wires the hook to components and owns mutation handlers (`applyTransactionLocalPatch`, `applyInfoFieldLocally`) and `useConfirmDialog`

This structure keeps related code together, makes each module focused and testable, and makes the page composition logic clear at a glance.

---

### Extra Information Dialog Inline Editing

- In the transaction extra information dialog, existing detail rows can now be edited inline using a per-row pencil action.
- Transaction ID is displayed for reference and remains non-editable.
- Inline row editing provides save/cancel controls and persists through the existing transaction update flow (`PATCH /api/transactions/:id`).

Code link: [[apps/frontend/src/pages/TransactionsPage.tsx]]

---

### Export

Export transactions to CSV or JSON for external analysis:

```
GET /api/transactions/export/csv?start_date=2025-01-01&end_date=2025-03-18&include_balance=true
GET /api/transactions/export/json?start_date=2025-01-01&end_date=2025-03-18
```

**Streaming Response (Phase 5+):**
- Response uses chunked `res.write()` streaming instead of `res.send()` to support large exports without memory overhead.
- Pagination happens internally via `CSV_EXPORT_CHUNK_SIZE` (1000 rows per chunk).
- Running balance (CSV only) is computed in JavaScript across chunks using an accumulator so balance stays correct when sorted by date.
- Optional `include_balance=true` query param adds a "Running Balance" column; defaults to false for backward compatibility.
- 404 probe query runs before streaming starts, so error responses still return JSON.

Implementation note:
- CSV escaping, row construction, and filename generation use extracted helpers (`escapeCsvValue`, `buildTransactionCsvRow`, `buildTransactionExportFilename`) with unchanged output format.
- CSV export neutralizes spreadsheet-formula-leading values (`=`, `+`, `-`, `@`) before writing cells to reduce formula-injection risk in spreadsheet tools.
- Export and PATCH error responses avoid leaking internal exception details and return sanitized generic `detail` payloads.

#### Filtered Export (Phase 13)

The `FilterBanner` component exposes two export buttons (CSV, JSON) when a structural filter is active in the Transactions table. The export query string is built from:

- **Structural filters**: `bank_account`, `bank_accounts`, `category_id`, `category_ids`, `recipient_id`, `recipient_name`, `transaction_type`, `transaction_id`
- **Date filters**: `start_date`, `end_date`
- **Search**: `search` (memo/comment text) is included in the export when present

**Filename pattern**: `transactions_<slug-of-filterLabel-or-"filtered">_<YYYY-MM-DD>.{csv|ndjson}`

**Frontend implementation**: [[apps/frontend/src/features/transactions/components/FilterBanner.tsx]], [[apps/frontend/src/features/transactions/components/TransactionsExportButtons.tsx]]

This allows users to drill down from pivot-table summaries (e.g., "Show all transactions for Q1 2026 in the Groceries category") and export the resulting filtered view directly without manual parameter construction.

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

## Bulk Operations

Transactions support multi-row selection and bulk operations for efficiency:
- **Bulk delete** — Permanently delete many rows at once
- **Bulk recategorize** — Apply a new category to many rows
- **Bulk reassign recipient** — Change payee/payer for many rows
- **Bulk activate/deactivate** — Toggle `is_active` status across a selection
- **Bulk export** — Stream selected transactions as CSV or NDJSON
- **Bulk tag** — Apply or remove tags from many rows simultaneously

See [[docs/features/bulk-actions]] for full details on selection modes (IDs vs. filter), UI patterns, and atomic guarantees.

---

## Related Documentation

- [[docs/api/transactions]] - Transaction API Reference
- [[docs/features/bulk-actions]] - Bulk Transaction Operations
- [[docs/features/tags]] - Transaction Tags Feature
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
