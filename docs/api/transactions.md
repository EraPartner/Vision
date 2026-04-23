---
title: API - Transactions
type: endpoint
method: GET, POST, PATCH, DELETE
path: /api/transactions
description: CRUD operations for financial transactions
date: 2026-04-23
tags: [api, transactions, finance, phase-9, decimal, money]
status: active
aliases: [transactions-api, transaction-crud, financial-records, income, expenses]
related_code: [[apps/node-backend/src/routes/transactions.js]], [[apps/node-backend/src/repositories/transactionRepository.js]], [[apps/node-backend/src/services/currencyConversionService.js]]
---

# Transactions API

## Overview

The Transactions API provides CRUD operations for managing financial transactions. Each transaction represents an income or expense with associated recipient, category, and amount.

> [!info] Monetary Precision (Phase 9)
> All monetary values in responses (amounts, balances, totals) use **Decimal.js** for precision. Values are serialized as JSON `number` type, safe to 2 decimal places (cents). See [[docs/adr/021-decimal-arithmetic-for-monetary-values|ADR-021]] for details.

## Endpoints

### GET /api/transactions

Retrieve a list of transactions with filtering and pagination.

**Query Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| limit | integer | 50 | Max items to return (max 5000) |
| offset | integer | 0 | Number of items to skip |
| transaction_id | integer | null | Filter by exact transaction ID |
| start_date | string | null | Filter by start date (YYYY-MM-DD) |
| end_date | string | null | Filter by end date (YYYY-MM-DD) |
| bank_account | string | null | Filter by bank account |
| category_id | integer | null | Filter by category ID |
| recipient_id | integer | null | Filter by recipient ID |
| recipient_name | string | null | Filter by recipient name |
| uncategorised | boolean | false | Show only uncategorized |
| active | boolean | true | Show active/inactive |
| search | string | null | Search in memo/comment |
| normalize_to_eur | boolean | false | Convert amounts to EUR |
| target_currency | string | null | Target currency used when normalize_to_eur=true (defaults to EUR) |
| include_balance | boolean | false | Compute running balance via SQL window function |
| sort_by | string | null | Sort field |
| sort_dir | string | null | Sort direction (asc/desc) |

Notes:
- `target_currency` is only applied when `normalize_to_eur=true`.
- If `target_currency` is invalid or unsupported, conversion falls back to EUR behavior.
- `include_balance=true` computes a `balance` field via SQL window function `SUM(amount) OVER (ORDER BY date ASC)` instead of JavaScript post-processing ([[apps/node-backend/src/routes/transactions.js]]).
- Route query parsing was refactored into a shared helper (`parseTransactionListQuery`) to reduce duplication while preserving default values, clamping rules, and sort-direction constraints ([[apps/node-backend/src/routes/transactions.js]]).
- Non-`uncategorised` list requests now use repository one-query pagination (`getAllWithCount`) instead of separate list/count round-trips; filters, totals, and response shape remain unchanged ([[apps/node-backend/src/routes/transactions.js]], [[apps/node-backend/src/repositories/transactionRepository.js]]).
- `uncategorised=true` list requests now use a dedicated single-round-trip repository path (`getUncategorisedWithCount`) instead of route-level dual queries; uncategorised row filtering and historical total-count semantics are preserved ([[apps/node-backend/src/routes/transactions.js]], [[apps/node-backend/src/repositories/transactionRepository.js]]).

**Response:**
```json
{
  "items": [
    {
      "id": 123,
      "transaction_date": "2026-01-15",
      "date": "2026-01-15",
      "bank_account": "BE12 3456...",
      "recipient_id": 1,
      "recipient_name": "Supermarket",
      "memo": "Weekly shopping",
      "amount": -75.50,
      "amount_eur": -75.50,
      "currency": "EUR",
      "balance": 1500.00,
      "category_id": 5,
      "category_name": "FOOD:GROCERIES",
      "comment": null,
      "is_active": true,
      "created_at": "2026-01-15T10:00:00Z",
      "updated_at": "2026-01-15T10:00:00Z",
      "links": []
    }
  ],
  "total": 150,
  "limit": 50,
  "offset": 0,
  "links": []
}
```

### GET /api/transactions/export/csv

Export transactions to CSV format using chunked streaming.

**Query Parameters:**
- `start_date`, `end_date`, `bank_account`, `category_id`: Filter exported rows
- `include_balance` (boolean, default false): Add a "Running Balance" column computed via JavaScript accumulator across chunks

**Response:** CSV file download with headers (default):
```
Date,Bank Account,Recipient,Memo,Amount,Currency,Balance,Category,Comment
```

With `include_balance=true`:
```
Date,Bank Account,Recipient,Memo,Amount,Currency,Balance,Category,Comment,Running Balance
```

**Streaming Behavior (Phase 5):**
- CSV is streamed in chunks of 1000 rows via `res.write()` to support large exports without memory overhead.
- Stable `ORDER BY (date ASC, id ASC)` ensures no gaps/duplicates across chunk boundaries.
- Running balance accumulates in JavaScript so it remains consistent with the sort order when `include_balance=true`.
- 404 probe query runs before streaming starts; error responses return JSON if no rows match filters.

**Rate Limited:** 30 requests per minute

Implementation note:
- CSV export row escaping/assembly and filename creation are handled by dedicated helpers (`escapeCsvValue`, `buildTransactionCsvRow`, `buildTransactionExportFilename`) with unchanged CSV header/content semantics and error responses ([[apps/node-backend/src/routes/transactions.js]]).
- CSV export neutralizes formula-like cell prefixes (`=`, `+`, `-`, `@`) before writing values to reduce spreadsheet formula-injection risk when opening exports in Excel/Sheets ([[apps/node-backend/src/routes/transactions.js]]).
- Export route errors are sanitized to generic error details (no internal exception leakage) while preserving status semantics; if headers have already been sent, connection is closed cleanly ([[apps/node-backend/src/routes/transactions.js]]).

### GET /api/transactions/:id

Retrieve a single transaction by ID.

**Response:**
```json
{
  "id": 123,
  "transaction_date": "2026-01-15",
  "bank_account": "BE12 3456...",
  "recipient_id": 1,
  "recipient_name": "Supermarket",
  "memo": "Weekly shopping",
  "amount": -75.50,
  "amount_eur": -75.50,
  "currency": "EUR",
  "balance": 1500.00,
  "category_id": 5,
  "category_name": "FOOD:GROCERIES",
  "comment": null,
  "is_active": true,
  "created_at": "2026-01-15T10:00:00Z",
  "updated_at": "2026-01-15T10:00:00Z",
  "links": []
}
```

### POST /api/transactions

Create a new transaction.

**Request Body:**
```json
{
  "date": "2026-01-15",
  "bank_account": "BE12 3456...",
  "recipient_id": 1,
  "amount": -75.50,
  "memo": "Weekly shopping",
  "currency": "EUR",
  "balance": 1500.00,
  "category_id": 5,
  "comment": "Optional comment"
}
```

**Required Fields:** date, bank_account, recipient_id, amount

**Duplicate Detection:** Automatically checks for duplicate transactions based on date, amount, recipient, and bank account. Returns 409 if duplicate found.

**Response:** Created transaction with 201 status.

### PATCH /api/transactions/:id

Update an existing transaction.

**Request Body:**
```json
{
  "category_id": 6,
  "comment": "Updated comment",
  "category_name": "FOOD:BEVERAGES"
}
```

**Special Handling:**
- `recipient_name`: Resolves to recipient_id automatically
- `category_name`: Resolves to category_id using "GENERAL:DETAIL" format

Implementation notes:
- Internal PATCH flow now delegates to extracted helpers for payload normalization and name→id resolution (`normalizeTransactionPatchFields`, `resolveRecipientNameToId`, `resolveCategoryNameToId`, `parseRouteId`) while preserving status codes and response messages.
- Recipient/category name-resolution and CSV export DB access now use module-scoped imports (`dbQuery`, `normalizeForMatching`) instead of per-request dynamic imports; endpoint behavior, payloads, and validation messages remain unchanged ([[apps/node-backend/src/routes/transactions.js]]).
- Recipient/category name-resolution checks in PATCH now run concurrently and preserve existing recipient-first then category error precedence in responses, reducing avoidable sequential lookup latency without changing validation outcomes ([[apps/node-backend/src/routes/transactions.js]]).
- Repository update path now returns the enriched updated row in a single CTE query (`WITH updated ... SELECT ...`) instead of `UPDATE` + follow-up `getById` round-trip; response shape and not-found semantics are unchanged ([[apps/node-backend/src/repositories/transactionRepository.js]]).
- PATCH route internal errors now return sanitized generic details instead of leaking backend exception strings ([[apps/node-backend/src/routes/transactions.js]]).

**Rate Limited:** 30 requests per minute

### DELETE /api/transactions/:id

Permanently delete a transaction (hard delete).

**Response:**
```json
{
  "message": "Transaction deleted permanently",
  "details": { "method": "hard delete" },
  "links": []
}
```

## Examples

### List Transactions

**curl:**
```bash
curl "http://localhost:3002/api/transactions?limit=10&active=true"
```

**apiClient:**
```ts
const { data } = await apiClient.getTransactions({ limit: 10, active: true });
```

### Create Transaction

**curl:**
```bash
curl -X POST http://localhost:3002/api/transactions \
  -H "Content-Type: application/json" \
  -d '{
    "date": "2026-01-15",
    "bank_account": "BE12 3456 7890 1234",
    "recipient_id": 1,
    "amount": -75.50,
    "memo": "Weekly shopping",
    "currency": "EUR"
  }'
```

**apiClient:**
```ts
const txn = await apiClient.createTransaction({
  date: '2026-01-15',
  bank_account: 'BE12 3456 7890 1234',
  recipient_id: 1,
  amount: -75.50,
  memo: 'Weekly shopping',
  currency: 'EUR',
});
```

### Update Transaction

**curl:**
```bash
curl -X PATCH http://localhost:3002/api/transactions/123 \
  -H "Content-Type: application/json" \
  -d '{
    "category_id": 6,
    "comment": "Updated comment"
  }'
```

**apiClient:**
```ts
const updated = await apiClient.updateTransaction(123, {
  category_id: 6,
  comment: 'Updated comment',
});
```

### Delete Transaction

**curl:**
```bash
curl -X DELETE http://localhost:3002/api/transactions/123
```

**apiClient:**
```ts
await apiClient.deleteTransaction(123);
```

## Transaction Amounts

- **Negative amounts**: Expenses (money leaving)
- **Positive amounts**: Income (money entering)

## Related

- [[docs/api/categories|Categories API]]
- [[docs/api/recipients|Recipients API]]
- [[docs/api/imports|Imports API]]

## Testing Coverage Note (2026-04-16 Phase 5)

Recent coverage in [[apps/node-backend/tests/routes/transactions.test.js]] verifies:
- CSV streaming chunked export via `res.write()` calls and accumulated running balance
- Formula-neutralization of dangerous prefixes (`=`, `+`, `-`, `@`)
- 404 probe behavior before streaming starts
- `include_balance` query param control of running-balance column
- `normalize_to_eur` conversion path behavior
- duplicate detection returning `409`
- unresolved `recipient_name`/`category_name` validation branches in patch flow

Related services: 
- [[apps/node-backend/src/services/currencyConversionService.js]]
- [[apps/node-backend/src/services/filterBuilder.js]] (shared filter construction)
