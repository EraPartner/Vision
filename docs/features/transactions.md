---
title: Transactions
type: feature
status: active
date: 2026-03-23
tags: [feature, transactions, finance]
description: Core transaction management - income, expenses, and tracking financial activities
related_code: ["apps/node-backend/src/routes/transactions.js", "apps/node-backend/src/repositories/transactionRepository.js", "apps/frontend/src/components/shared/VirtualDataTable.tsx", "apps/frontend/src/pages/TransactionsPage.tsx"]
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

#### Table Search Sync Behavior

- Transaction table search input updates immediately in the UI and persists after execution.
- Server filtering is debounced at 200ms through `VirtualDataTable` for a more live feel while keeping request volume controlled.
- Search reacts correctly when loosening terms (character-by-character deletion) and when clearing entirely.
- Table rows are rendered from a deferred data value (`useDeferredValue`) so typing remains responsive while results refresh.

Code links: [[apps/frontend/src/components/shared/VirtualDataTable.tsx]], [[apps/frontend/src/pages/TransactionsPage.tsx]]

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
