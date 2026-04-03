---
title: Feature - Splits & Owes
type: feature
status: active
date: 2026-04-02
tags: [feature, splits, owes, debts, shared-expenses]
description: Transaction splitting and debt tracking between recipients
aliases: [splits-feature, owes-feature, debts, shared expenses, roommate expenses]
related_code: ["apps/node-backend/src/routes/splits.js", "apps/node-backend/src/repositories/splitRepository.js", "apps/node-backend/src/services/loanRepaymentService.js", "apps/frontend/src/pages/OwesPage.tsx", "apps/frontend/src/components/splits/SplitTransactionDialog.tsx", "apps/frontend/src/hooks/useSplits.ts"]
---

# Feature: Splits & Owes

## Overview

The Splits & Owes system allows users to track shared expenses and debts between people. It supports splitting a single transaction among multiple recipients and tracking partial payments toward settlement.

---

## Core Concepts

### Transaction Split

A **split** divides a transaction amount among multiple recipients. For example, a $100 dinner bill split among 3 people creates 3 split records.

### Split Payment

A **payment** records a partial settlement of a split. Multiple payments can be made toward a single split until it is fully settled.

### Owed Summary

The **owed summary** aggregates all unsettled splits to show who owes whom and how much.

---

## Database Schema

### transaction_splits

| Column | Type | Description |
|--------|------|-------------|
| id | SERIAL | Primary key |
| transaction_id | INTEGER | Parent transaction |
| recipient_id | INTEGER | Recipient who owes |
| amount | NUMERIC(15,2) | Split amount |
| currency | VARCHAR(10) | Currency code |
| is_settled | BOOLEAN | Settlement status |
| settled_at | TIMESTAMPTZ | When settled |
| created_at | TIMESTAMPTZ | Creation timestamp |
| updated_at | TIMESTAMPTZ | Last update |

### split_payments

| Column | Type | Description |
|--------|------|-------------|
| id | SERIAL | Primary key |
| split_id | INTEGER | Reference to split |
| amount | NUMERIC(15,2) | Payment amount |
| paid_at | DATE | Payment date |
| note | TEXT | Payment note |
| created_at | TIMESTAMPTZ | Creation timestamp |

**Migration:** `0009_transaction_splits.py`

---

## API Endpoints

### Owed Summary

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/splits/owed` | Overall owed summary |
| GET | `/api/splits/owed/:id` | Owed summary for specific recipient |
| GET | `/api/splits/owed/:id/export/csv` | Export owed data as CSV |

### Split Management

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/splits/transaction/:id` | Get splits for a transaction |
| POST | `/api/splits` | Create a single split |
| POST | `/api/splits/batch` | Create multiple splits |
| DELETE | `/api/splits/:id` | Delete a split |

### Payment & Settlement

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/splits/:id/pay` | Record a payment |
| GET | `/api/splits/:id/payments` | Get payment history |
| POST | `/api/splits/:id/settle` | Mark split as settled |
| POST | `/api/splits/owed/:id/settle-all` | Settle all splits for a recipient |

---

## Frontend: Owes Page (`/owes`)

### Features

- **Owed Summary View**: Shows who owes whom with totals
- **Per-Person Detail View**: Detailed breakdown per recipient
- **Split Source Context**: Shows original transaction recipient and memo
- **Recent Recipient Transactions**: VirtualDataTable with infinite scroll showing recent transactions for the selected recipient
- **Bulk Settle**: Settle all outstanding splits for a person with confirmation
- **Jump to Source**: Double-click any split row to open Transactions filtered to the source `transaction_id`

### Response Shape

The owed summary returns:
```json
{
  "total_owed": 150.00,
  "total_paid": 50.00,
  "remaining": 100.00,
  "split_count": 5,
  "transaction_currency": "EUR",
  "recipients": [
    {
      "id": 1,
      "name": "John",
      "total_owed": 75.00,
      "total_paid": 25.00,
      "remaining": 50.00,
      "bank_account": "BE12 3456 7890 1234",
      "splits": [...]
    }
  ]
}
```

---

## Use Cases

1. **Roommate expenses** — Split rent, utilities, groceries
2. **Group dinners** — Divide restaurant bills
3. **Shared vacations** — Track who paid for what
4. **Family lending** — Track informal loans

---

## Related

- [[docs/api/splits]] — API documentation
- [[docs/features/views#owes]] — Owes page in views
- [[docs/adr/002-database-schema#transaction-splits-tables]] — Schema details
