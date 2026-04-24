---
title: API - Reconciliation
type: endpoint
status: active
date: 2026-04-24
tags: [api, reconciliation, statements, matching, phase-6, backend]
aliases: [reconciliation-api, bank-statements-api, statement-matching, auto-match]
related_code:
  - apps/node-backend/src/routes/reconciliation.js
  - apps/node-backend/src/repositories/reconciliationRepository.js
  - alembic/versions/0007_bank_reconciliation.py
description: REST endpoints for bank statement management and transaction reconciliation
---

# Reconciliation API

## Overview

The Reconciliation API provides full statement and entry management for matching bank statements to recorded transactions. Includes auto-match candidate search with scoring and manual override.

| Property | Value |
|----------|-------|
| **Base Path** | `/api/reconciliation` |
| **Methods** | GET, POST, PATCH, DELETE |
| **Authentication** | None |
| **Rate Limit** | None |

## Enums

### Match Status

Match status values for reconciliation entries:

```
'unmatched'  — No transaction linked
'auto'       — Auto-match candidate available (pending confirmation)
'confirmed'  — User confirmed the auto-match
'manual'     — User manually linked a transaction
'ignored'    — User marked entry as not needing a match
```

## Endpoints

---

### GET /api/reconciliation/statements

List all bank statements.

**Query Parameters:**

| Parameter | Type | Default | Max | Description |
|-----------|------|---------|-----|-------------|
| `bank_account` | string | null | — | Filter by account IBAN/identifier (uppercase) |
| `limit` | integer | 50 | 200 | Items per page |
| `offset` | integer | 0 | — | Pagination offset |

**Response:**

```json
{
  "data": [
    {
      "id": 1,
      "bank_account": "BE62 1111 2222 3333",
      "currency": "EUR",
      "period_start": "2026-04-01",
      "period_end": "2026-04-30",
      "opening_balance": 5000.00,
      "closing_balance": 4250.50,
      "notes": "Argenta April",
      "created_at": "2026-04-24T10:00:00Z",
      "updated_at": "2026-04-24T10:00:00Z"
    }
  ],
  "meta": {
    "total": 12
  }
}
```

---

### POST /api/reconciliation/statements

Create a new bank statement.

**Request Body:**

```json
{
  "bank_account": "BE62 1111 2222 3333",
  "currency": "EUR",
  "period_start": "2026-04-01",
  "period_end": "2026-04-30",
  "opening_balance": 5000.00,
  "closing_balance": 4250.50,
  "notes": "Argenta April statement"
}
```

**Field Validation:**

| Field | Required | Type | Constraints |
|-------|----------|------|-------------|
| `bank_account` | Yes | string | Non-empty, uppercased |
| `currency` | No | string | 3-letter ISO code (default: EUR) |
| `period_start` | Yes | string | YYYY-MM-DD format |
| `period_end` | Yes | string | YYYY-MM-DD format, >= period_start |
| `opening_balance` | No | number | Any precision |
| `closing_balance` | No | number | Any precision |
| `notes` | No | string | Free-form text |

**Response:** `201 Created`

```json
{
  "ok": true,
  "data": {
    "id": 1,
    "bank_account": "BE62 1111 2222 3333",
    "currency": "EUR",
    "period_start": "2026-04-01",
    "period_end": "2026-04-30",
    "opening_balance": 5000.00,
    "closing_balance": 4250.50,
    "notes": "Argenta April statement",
    "created_at": "2026-04-24T10:00:00Z",
    "updated_at": "2026-04-24T10:00:00Z"
  }
}
```

**Errors:**

- `400 Bad Request` — Missing required field, invalid date format, period_start > period_end, invalid currency code

---

### GET /api/reconciliation/statements/:id

Retrieve a single bank statement with entry summary.

**Response:**

```json
{
  "ok": true,
  "data": {
    "id": 1,
    "bank_account": "BE62 1111 2222 3333",
    "currency": "EUR",
    "period_start": "2026-04-01",
    "period_end": "2026-04-30",
    "opening_balance": 5000.00,
    "closing_balance": 4250.50,
    "notes": "Argenta April",
    "entry_summary": {
      "total_entries": 45,
      "unmatched": 2,
      "auto_matched": 5,
      "confirmed": 35,
      "manual": 3,
      "ignored": 0
    },
    "created_at": "2026-04-24T10:00:00Z",
    "updated_at": "2026-04-24T10:00:00Z"
  }
}
```

**Errors:**

- `404 Not Found` — Statement does not exist

---

### PATCH /api/reconciliation/statements/:id

Update statement header fields (all optional).

**Request Body:**

```json
{
  "currency": "USD",
  "period_start": "2026-04-01",
  "period_end": "2026-04-30",
  "opening_balance": 5500.00,
  "closing_balance": 4800.00,
  "notes": "Corrected balance"
}
```

**Response:** `200 OK`

```json
{
  "ok": true,
  "data": { /* updated statement */ }
}
```

**Errors:**

- `400 Bad Request` — Invalid date format or constraint violation
- `404 Not Found` — Statement does not exist

---

### DELETE /api/reconciliation/statements/:id

Delete a statement and all its entries (cascading).

**Response:** `200 OK`

```json
{
  "ok": true,
  "data": null
}
```

**Errors:**

- `404 Not Found` — Statement does not exist

---

### GET /api/reconciliation/statements/:id/entries

List entries for a statement.

**Query Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `limit` | integer | 50 | Items per page (max 500) |
| `offset` | integer | 0 | Pagination offset |
| `match_status` | string | null | Filter by status (unmatched, auto, confirmed, manual, ignored) |

**Response:**

```json
{
  "data": [
    {
      "id": 1,
      "bank_statement_id": 1,
      "entry_date": "2026-04-05",
      "description": "PAYMENT TO LANDLORD",
      "amount": -800.00,
      "currency": "EUR",
      "transaction_id": 42,
      "match_status": "confirmed",
      "match_score": 98.5,
      "created_at": "2026-04-24T10:00:00Z",
      "updated_at": "2026-04-24T10:00:00Z"
    }
  ],
  "meta": {
    "total": 45
  }
}
```

---

### POST /api/reconciliation/statements/:id/entries

Add one or more entries to a statement.

**Single Entry Request:**

```json
{
  "entry_date": "2026-04-05",
  "description": "PAYMENT TO LANDLORD",
  "amount": -800.00,
  "currency": "EUR"
}
```

**Bulk Entries Request:**

```json
{
  "entries": [
    {
      "entry_date": "2026-04-05",
      "description": "PAYMENT TO LANDLORD",
      "amount": -800.00,
      "currency": "EUR"
    },
    {
      "entry_date": "2026-04-10",
      "description": "SALARY DEPOSIT",
      "amount": 3500.00,
      "currency": "EUR"
    }
  ]
}
```

**Field Validation:**

| Field | Required | Type | Constraints |
|-------|----------|------|-------------|
| `entry_date` | Yes | string | YYYY-MM-DD format |
| `description` | No | string | Bank-provided description |
| `amount` | Yes | number | Any value (negative for debit, positive for credit) |
| `currency` | No | string | 3-letter ISO code (default: EUR) |

**Response:** `201 Created`

```json
{
  "ok": true,
  "data": [
    {
      "id": 1,
      "bank_statement_id": 1,
      "entry_date": "2026-04-05",
      "description": "PAYMENT TO LANDLORD",
      "amount": -800.00,
      "currency": "EUR",
      "transaction_id": null,
      "match_status": "unmatched",
      "match_score": null,
      "created_at": "2026-04-24T10:00:00Z",
      "updated_at": "2026-04-24T10:00:00Z"
    }
  ]
}
```

**Errors:**

- `400 Bad Request` — Invalid date format, missing required field, invalid currency
- `404 Not Found` — Statement does not exist

---

### DELETE /api/reconciliation/statements/:id/entries/:entryId

Delete a single reconciliation entry.

**Response:** `200 OK`

```json
{
  "ok": true,
  "data": null
}
```

**Errors:**

- `404 Not Found` — Statement or entry does not exist

---

### GET /api/reconciliation/statements/:id/entries/:entryId/candidates

Find auto-match candidates for an entry.

Returns ordered list of transactions that could match this entry, with score breakdown and details.

**Query Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `limit` | integer | 10 | Max candidates to return |

**Response:**

```json
{
  "ok": true,
  "data": [
    {
      "transaction_id": 42,
      "transaction_date": "2026-04-05",
      "recipient_name": "Landlord",
      "amount": -800.00,
      "currency": "EUR",
      "memo": "Rent payment",
      "category_name": "HOUSING:RENT",
      "match_score": 98.5,
      "score_breakdown": {
        "date_score": 100,
        "amount_score": 100,
        "description_bonus": -1.5
      }
    }
  ]
}
```

**Candidate Fields:**

| Field | Type | Meaning |
|-------|------|---------|
| `transaction_id` | integer | ID of candidate transaction |
| `transaction_date` | string | YYYY-MM-DD |
| `recipient_name` | string | Payee/payer name |
| `amount` | number | Transaction amount |
| `currency` | string | Transaction currency |
| `memo` | string | User memo/notes |
| `category_name` | string | Category (GENERAL:DETAIL) or null |
| `match_score` | number | Confidence score (0–100) |
| `score_breakdown` | object | Component scores (date, amount, description) |

**Errors:**

- `404 Not Found` — Statement or entry does not exist

---

### POST /api/reconciliation/statements/:id/entries/:entryId/match

Set or change a match for an entry.

**Request Body — Confirm Auto-Match:**

```json
{
  "transaction_id": 42,
  "match_status": "confirmed"
}
```

**Request Body — Manual Match:**

```json
{
  "transaction_id": 100,
  "match_status": "manual"
}
```

**Request Body — Ignore Entry:**

```json
{
  "match_status": "ignored"
}
```

**Field Validation:**

| Field | Required | Allowed Values |
|-------|----------|-----------------|
| `transaction_id` | Conditional | integer > 0 (required if match_status is "confirmed" or "manual") |
| `match_status` | Yes | confirmed, manual, ignored |

**Response:** `200 OK`

```json
{
  "ok": true,
  "data": {
    "id": 1,
    "bank_statement_id": 1,
    "entry_date": "2026-04-05",
    "description": "PAYMENT TO LANDLORD",
    "amount": -800.00,
    "currency": "EUR",
    "transaction_id": 42,
    "match_status": "confirmed",
    "match_score": 98.5,
    "created_at": "2026-04-24T10:00:00Z",
    "updated_at": "2026-04-24T10:00:00Z"
  }
}
```

**Errors:**

- `400 Bad Request` — Invalid match_status, missing transaction_id for non-ignored match, invalid transaction_id
- `404 Not Found` — Statement, entry, or transaction does not exist

---

### DELETE /api/reconciliation/statements/:id/entries/:entryId/match

Clear the match for an entry (revert to unmatched).

**Response:** `200 OK`

```json
{
  "ok": true,
  "data": {
    "id": 1,
    "bank_statement_id": 1,
    "entry_date": "2026-04-05",
    "description": "PAYMENT TO LANDLORD",
    "amount": -800.00,
    "currency": "EUR",
    "transaction_id": null,
    "match_status": "unmatched",
    "match_score": null,
    "created_at": "2026-04-24T10:00:00Z",
    "updated_at": "2026-04-24T10:00:00Z"
  }
}
```

**Errors:**

- `404 Not Found` — Statement or entry does not exist

---

## Error Response Format

All errors follow the standard envelope:

```json
{
  "ok": false,
  "error": "Statement 999 not found"
}
```

---

## Related

- [[docs/features/bank-reconciliation|Bank Reconciliation Feature]]
- [[docs/api/transactions|Transactions API]]
- [[docs/reference/api-endpoint-matrix|API Endpoint Matrix]]
