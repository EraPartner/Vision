---
title: Splits API
type: endpoint
status: active
date: 2026-03-31
tags: [api, splits, transactions, debt]
aliases: [splits-api, owes, debt-tracking, shared-expenses, settle-up, transaction-split]
description: API endpoints for transaction splitting and debt tracking between recipients
related_code: ["apps/node-backend/src/routes/splits.js", "apps/node-backend/src/repositories/splitRepository.js"]
---

# Splits API

Endpoints for transaction splitting and debt tracking. Allows splitting expenses between recipients and tracking who owes whom.

## Base URL

```
/api/splits
```

## Validation Rules

- Split amounts must be **positive numbers**.
- The cumulative split amount for a transaction (existing splits + new split(s)) cannot exceed the absolute transaction amount.
- If a transaction does not exist, split creation returns `404`.

## Endpoints

### GET /api/splits/owed

Get a summary of who owes what across all recipients.

Only unsettled splits with a positive remaining balance are included.

**Response:** `200 OK`

```json
{
  "items": [
    {
      "recipient_id": 1,
      "recipient_name": "John Doe",
      "total_owed": 150.00,
      "total_paid": 40.00,
      "remaining": 110.00,
      "split_count": 3
    }
  ]
}
```

---

### GET /api/splits/owed/:id

Get detailed splits owed by a specific recipient.

**Parameters:**

| Field | Type | Description |
|-------|------|-------------|
| `id` | number | Recipient ID (positive integer) |

**Response:** `200 OK`

```json
{
  "items": [
    {
      "id": 1,
      "transaction_id": 100,
      "recipient_id": 2,
      "amount": 50.00,
      "transaction_recipient_name": "CARD PAYMENT - CURRENT",
      "transaction_memo": "Dinner split",
      "transaction_currency": "EUR",
      "bank_account": "BE12 3456 7890 1234",
      "note": "Dinner split",
      "amount_paid": 10.00,
      "remaining": 40.00,
      "is_settled": false,
      "created_at": "2025-01-15T10:00:00Z"
    }
  ]
}
```

`transaction_recipient_name` and `transaction_memo` are returned so clients can present the split source using both fields (for example in the Owes detail list).

---

### GET /api/splits/owed/:id/export/csv

Export unsettled split transactions for a specific recipient as CSV, using the same transaction export columns.

Important behavior:

- Includes only splits for the recipient in `:id` that are **not settled** and still have a positive remaining amount.
- Returns **one CSV row per split transaction** for that recipient.
- `Amount` column is set to the split **remaining amount to settle** (`split.amount - paid`), not the original transaction amount.

**Parameters:**

| Field | Type | Description |
|-------|------|-------------|
| `id` | number | Recipient ID (positive integer) |

**Response:** `200 OK`

- Content type: `text/csv`
- Header: `Date,Bank Account,Recipient,Memo,Amount,Currency,Balance,Category,Comment`

**Error Responses:**

- `404 Not Found` when no unsettled owed transactions exist for that recipient.

---

### GET /api/splits/transaction/:id

Get all splits for a specific transaction.

**Parameters:**

| Field | Type | Description |
|-------|------|-------------|
| `id` | number | Transaction ID (positive integer) |

**Response:** `200 OK`

```json
{
  "items": [
    {
      "id": 1,
      "transaction_id": 100,
      "recipient_id": 2,
      "amount": 50.00,
      "note": "Lunch",
      "is_settled": false
    }
  ]
}
```

---

### POST /api/splits

Create a new split for a transaction.

**Request Body:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `transaction_id` | number | Yes | ID of the transaction to split |
| `recipient_id` | number | Yes | ID of the recipient who owes |
| `amount` | number | Yes | Amount owed |
| `note` | string | No | Optional note |

**Response:** `201 Created`

```json
{
  "id": 1,
  "transaction_id": 100,
  "recipient_id": 2,
  "amount": 50.00,
  "note": "Dinner split",
  "is_settled": false,
  "created_at": "2025-01-15T10:00:00Z"
}
```

**Error Response:** `400 Bad Request`

```json
{
  "detail": "Missing required fields: transaction_id, recipient_id, amount"
}
```

```json
{
  "detail": "Split amount exceeds transaction total"
}
```

---

### POST /api/splits/batch

Create multiple splits for a transaction at once.

**Request Body:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `transaction_id` | number | Yes | ID of the transaction to split |
| `splits` | array | Yes | Array of split objects |

**Split Object:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `recipient_id` | number | Yes | ID of the recipient |
| `amount` | number | Yes | Amount owed |
| `note` | string | No | Optional note |

**Response:** `201 Created`

```json
{
  "items": [
    { "id": 1, "transaction_id": 100, "recipient_id": 2, "amount": 25.00 },
    { "id": 2, "transaction_id": 100, "recipient_id": 3, "amount": 25.00 }
  ]
}
```

**Error Response:** `400 Bad Request`

```json
{
  "detail": "Split amount exceeds transaction total"
}
```

---

### POST /api/splits/:id/pay

Record a payment towards a split.

**Parameters:**

| Field | Type | Description |
|-------|------|-------------|
| `id` | number | Split ID (positive integer) |

**Request Body:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `amount` | number | Yes | Payment amount (positive number) |
| `note` | string | No | Optional note |
| `paid_at` | string | No | Payment date (ISO 8601) |

**Response:** `201 Created`

```json
{
  "id": 1,
  "split_id": 1,
  "amount": 25.00,
  "note": "Partial payment",
  "paid_at": "2025-01-20T00:00:00Z"
}
```

**Error Response:** `400 Bad Request`

```json
{
  "detail": "Amount must be a positive number"
}
```

---

### GET /api/splits/:id/payments

Get all payments for a specific split.

**Parameters:**

| Field | Type | Description |
|-------|------|-------------|
| `id` | number | Split ID (positive integer) |

**Response:** `200 OK`

```json
{
  "items": [
    {
      "id": 1,
      "split_id": 1,
      "amount": 25.00,
      "note": "Payment 1",
      "paid_at": "2025-01-20T00:00:00Z"
    }
  ]
}
```

---

### POST /api/splits/:id/settle

Mark a split as fully settled.

**Parameters:**

| Field | Type | Description |
|-------|------|-------------|
| `id` | number | Split ID (positive integer) |

**Response:** `200 OK`

```json
{
  "id": 1,
  "transaction_id": 100,
  "recipient_id": 2,
  "amount": 50.00,
  "is_settled": true
}
```

**Error Response:** `404 Not Found`

```json
{
  "detail": "Split not found"
}
```

---

### POST /api/splits/owed/:id/settle-all

Mark all **unsettled** splits for a specific recipient as settled.

This endpoint matches existing settlement behavior: it only sets `is_settled = true` and does **not** create payment records.

**Parameters:**

| Field | Type | Description |
|-------|------|-------------|
| `id` | number | Recipient ID (positive integer) |

**Response:** `200 OK`

```json
{
  "settled_count": 3
}
```

**Error Response:** `500 Internal Server Error`

```json
{
  "detail": "Error settling all splits for recipient"
}
```

---

### DELETE /api/splits/:id

Delete a split.

**Parameters:**

| Field | Type | Description |
|-------|------|-------------|
| `id` | number | Split ID (positive integer) |

**Response:** `200 OK`

```json
{
  "message": "Split deleted"
}
```

**Error Response:** `404 Not Found`

```json
{
  "detail": "Split not found"
}
```

## TypeScript Types

**File:** [[apps/frontend/src/types/splits.ts]]

```typescript
interface TransactionSplit {
  id: number;
  transaction_id: number;
  recipient_id: number;
  recipient_name?: string;
  amount: number;
  amount_paid: number;
  note?: string;
  is_settled: boolean;
  created_at: string;
  updated_at: string;
}

interface TransactionSplitDetail extends TransactionSplit {
  transaction_date: string;
  transaction_memo: string;
  transaction_amount: number;
  transaction_currency: string;
  transaction_recipient_name?: string;
  bank_account: string;
  remaining: number;
}

interface OwedSummary {
  recipient_id: number;
  recipient_name: string;
  total_owed: number;
  total_paid: number;
  remaining: number;
  split_count: number;
}

interface SplitPayment {
  id: number;
  split_id: number;
  amount: number;
  paid_at: string;
  note?: string;
  created_at: string;
}

interface SplitCreateInput {
  recipient_id: number;
  amount: number;
  note?: string;
}
```

## Use Cases

- **Shared expenses**: Split a restaurant bill or group purchase among friends
- **Roommate finances**: Track rent and utility splits
- **Business expenses**: Allocate shared business costs

## See Also

- [[docs/api/index]] - API Index
- [[docs/api/transactions]] - Transactions API
- [[docs/api/recipients]] - Recipients API
- [[docs/components/form-dialogs|SplitTransactionDialog]] - Frontend split dialog component

## Migrations

- `0009_transaction_splits.py` — Added `transaction_splits` and `split_payments` tables for expense splitting
