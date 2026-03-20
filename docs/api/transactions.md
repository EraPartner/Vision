---
title: API - Transactions
type: endpoint
method: GET, POST, PATCH, DELETE
path: /api/transactions
description: CRUD operations for financial transactions
date: 2026-03-18
tags: [api, transactions, finance]
related_code: [[apps/node-backend/src/routes/transactions.js]]
---

# Transactions API

## Overview

The Transactions API provides CRUD operations for managing financial transactions. Each transaction represents an income or expense with associated recipient, category, and amount.

## Endpoints

### GET /api/transactions

Retrieve a list of transactions with filtering and pagination.

**Query Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| limit | integer | 50 | Max items to return (max 5000) |
| offset | integer | 0 | Number of items to skip |
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
| sort_by | string | null | Sort field |
| sort_dir | string | null | Sort direction (asc/desc) |

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

Export transactions to CSV format.

**Query Parameters:** Same as GET /api/transactions

**Response:** CSV file download with headers:
```
Date,Bank Account,Recipient,Memo,Amount,Currency,Balance,Category,Comment
```

**Rate Limited:** 30 requests per minute

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

## Transaction Amounts

- **Negative amounts**: Expenses (money leaving)
- **Positive amounts**: Income (money entering)

## Related

- [[docs/api/categories|Categories API]]
- [[docs/api/recipients|Recipients API]]
- [[docs/api/imports|Imports API]]
