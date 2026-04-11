---
title: API - Planned Transactions
type: endpoint
method: GET, POST, PATCH, DELETE
path: /api/planned-transactions
description: Scheduled and recurring payment management
date: 2026-04-11
tags: [api, planned, recurring, schedule]
status: active
aliases: [planned-transactions-api, planned-payments, scheduled-payments, recurring-payments, bills, subscriptions, loans]
related_code: [[apps/node-backend/src/routes/plannedTransactions.js]], [[apps/node-backend/src/repositories/plannedTransactionRepository.js]]
---

# Planned Transactions API

## Overview

Planned Transactions manage scheduled and recurring payments. They can be simple one-time scheduled transactions or complex recurring payments with loan amortization schedules.

## Endpoints

### GET /api/planned-transactions

Retrieve planned transactions.

**Query Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| limit | integer | 50 | Max items (max 5000) |
| offset | integer | 0 | Items to skip |
| start_date | string | null | Filter start date |
| end_date | string | null | Filter end date |
| bank_account | string | null | Filter by bank account |
| category_id | integer | null | Filter by category |
| recipient_id | integer | null | Filter by recipient |
| is_recurring | boolean | null | Filter recurring |
| is_executed | boolean | null | Filter executed |
| active | boolean | true | Filter active |
| search | string | null | Search in memo |

**Response:**
```json
{
  "items": [
    {
      "id": 1,
      "planned_date": "2026-02-01",
      "bank_account": "BE12 3456...",
      "recipient_id": 1,
      "recipient_name": "Electric Company",
      "memo": "Monthly electricity",
      "amount": -85.00,
      "currency": "EUR",
      "category_id": 10,
      "category_name": "UTILITIES:ELECTRICITY",
      "comment": null,
      "url": "https://pay.electriccompany.be",
      "is_recurring": true,
      "recurrence_pattern": "monthly",
      "is_executed": false,
      "last_executed_date": null,
      "is_loan": false,
      "loan_type": null,
      "loan_principal": null,
      "loan_annual_interest_rate": null,
      "loan_term_months": null,
      "loan_start_date": null,
      "loan_payment_day": null,
      "loan_regular_payment_amount": null,
      "loan_first_payment_date": null,
      "loan_schedule": [],
      "executed_transaction_id": null,
      "execution_count": 0,
      "executions": [],
      "is_active": true,
      "created_at": "2026-01-01T00:00:00Z",
      "updated_at": "2026-01-01T00:00:00Z",
      "links": []
    }
  ],
  "total": 25,
  "limit": 50,
  "offset": 0,
  "links": []
}
```

### POST /api/planned-transactions

Create a planned transaction.

**Simple Transaction Request:**
```json
{
  "planned_date": "2026-02-01",
  "bank_account": "BE12 3456...",
  "recipient_id": 1,
  "amount": -85.00,
  "memo": "Monthly electricity",
  "currency": "EUR",
  "category_id": 10,
  "is_recurring": true,
  "recurrence_pattern": "monthly",
  "url": "https://pay.electriccompany.be"
}
```

**Loan Transaction Request:**
```json
{
  "bank_account": "BE12 3456...",
  "recipient_id": 2,
  "memo": "Car loan",
  "is_loan": true,
  "loan_type": "fixed_rate",
  "loan_principal": 25000.00,
  "loan_annual_interest_rate": 4.5,
  "loan_term_months": 60,
  "loan_start_date": "2026-02-01",
  "loan_payment_day": 1
}
```

**Required Fields:**
- bank_account
- planned_date (non-loan)
- amount (non-loan)

**Loan Fields:**
- `is_loan`: true
- `loan_type`: fixed_rate, variable_rate
- `loan_principal`: Principal amount
- `loan_annual_interest_rate`: Annual interest rate
- `loan_term_months`: Term in months (1-600)
- `loan_start_date`: Start date
- `loan_payment_day`: Day of month for payment

**Recurrence Patterns:** daily, weekly, bi-weekly, monthly, quarterly, yearly

### GET /api/planned-transactions/:id

Get a single planned transaction.

### PATCH /api/planned-transactions/:id

Update a planned transaction.

**Supports name resolution:**
- `recipient_name`: Resolves to recipient_id
- `category_name`: Resolves to category_id (format: "GENERAL:DETAIL")

**Loan Updates:** Changing loan fields regenerates amortization schedule.

**Rate Limited:** 30 requests per minute

Implementation notes:
- Internal route refactor extracted shared helpers for PATCH flow (`parseRouteId`, `removePatchOnlyReadOnlyFields`, `resolveRecipientIdFromName`, `resolveCategoryIdFromName`, `applyLoanPatchDefaults`).
- Refactor preserves existing behavior: unresolved `recipient_name` / `category_name` does not introduce new validation errors, and loan schedule regeneration/clearing semantics remain unchanged ([[apps/node-backend/src/routes/plannedTransactions.js]]).
- Follow-up refactor extracted shared write-path error handling (`handlePlannedTransactionWriteError`) for POST/PATCH and isolated PATCH loan schedule persistence branching in `updateLoanScheduleForPatch`; response shapes and status-code behavior remain unchanged ([[apps/node-backend/src/routes/plannedTransactions.js]]).
- List-path optimization now computes `total` from the main paginated query via `COUNT(*) OVER()` and only runs a fallback count query when the returned page is empty; list response semantics are preserved while reducing round-trips for non-empty pages. The list also removes a redundant `exec_counts` join and derives `execution_count` from the already batched executions fetch ([[apps/node-backend/src/repositories/plannedTransactionRepository.js]]).
- Update-path optimization now returns the enriched updated row via single CTE query (`WITH updated ... SELECT ...`) before attaching executions/loan schedule, removing update+base-refetch overhead while preserving response fields and null/not-found behavior ([[apps/node-backend/src/repositories/plannedTransactionRepository.js]]).
- Name-resolution helpers and recurring execute-date calculation now use module-scoped imports (`dbQuery`, `calculateNextDate`) rather than per-request dynamic imports; endpoint behavior is unchanged ([[apps/node-backend/src/routes/plannedTransactions.js]]).
- PATCH name-resolution lookups for `recipient_name` and `category_name` now run concurrently via `Promise.all`, preserving current unresolved-name behavior while reducing avoidable sequential latency when both are provided ([[apps/node-backend/src/routes/plannedTransactions.js]]).

### POST /api/planned-transactions/:id/execute

Mark a planned transaction as executed.

**Request Body:**
```json
{
  "executed_transaction_id": 123,
  "execution_date": "2026-02-01"
}
```

**Behavior:**
- For recurring: Calculates next occurrence and resets is_executed
- For one-time: Sets is_executed = true
- Records execution in planned_transaction_executions table

Implementation note:
- Internal route refactor now uses shared `getCurrentDateString()` fallback helper for `execution_date` defaulting; response/side-effect behavior remains unchanged ([[apps/node-backend/src/routes/plannedTransactions.js]]).

### DELETE /api/planned-transactions/:id

Permanently delete a planned transaction.

## Loan Schedule

When creating/updating a loan, the system generates an amortization schedule:

```json
{
  "loan_schedule": [
    {
      "installment_number": 1,
      "due_date": "2026-02-01",
      "payment_amount": 466.50,
      "principal_amount": 373.25,
      "interest_amount": 93.25,
      "remaining_principal": 24626.75
    }
  ]
}
```

## Related

- [[docs/api/transactions|Transactions API]]
- [[docs/api/recipients|Recipients API]]

## Testing Coverage Note (2026-04-11)

Recent coverage in [[apps/node-backend/tests/routes/plannedTransactions.test.js]] verifies:
- loan term bounds validation,
- patch `recipient_name`/`category_name` name-to-id resolution,
- loan toggle-off behavior clearing schedule and loan-specific fields.
