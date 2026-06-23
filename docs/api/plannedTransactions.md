---
title: API - Planned Transactions
type: endpoint
method: GET, POST, PATCH, DELETE
path: /api/planned-transactions
description: Scheduled and recurring payment management
date: 2026-04-23
updated: 2026-06-17
tags: [api, planned, recurring, schedule, phase-3, idempotency, phase-9, decimal, money, auto-link, planned-match, june-2026]
status: active
aliases: [planned-transactions-api, planned-payments, scheduled-payments, recurring-payments, bills, subscriptions, loans]
related_code: [[apps/node-backend/src/routes/plannedTransactions.js]], [[apps/node-backend/src/repositories/plannedTransactionRepository.js]], [[apps/node-backend/src/services/plannedMatchService.js]], [[apps/node-backend/src/services/plannedExecutionService.js]]
---

# Planned Transactions API

## Overview

Planned Transactions manage scheduled and recurring payments. They can be simple one-time scheduled transactions or complex recurring payments with loan amortization schedules.

> [!info] Monetary Precision (Phase 9)
> All monetary values in responses (amounts, calculated payments) use **Decimal.js** for precision. Values are serialized as JSON `number` type, safe to 2 decimal places (cents). See [[docs/adr/021-decimal-arithmetic-for-monetary-values|ADR-021]] for details.

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

Mark a planned transaction as executed. **Atomic and idempotent as of Phase 3.**

**Request Body:**
```json
{
  "executed_transaction_id": 123,
  "execution_date": "2026-02-01"
}
```

**Behavior:**
- For recurring: Calculates next occurrence and resets `is_executed = false` to re-arm for next cycle
- For one-time: Sets `is_executed = true`
- Records execution in `planned_transaction_executions` table
- **Idempotency:** Database UNIQUE constraint on `(planned_transaction_id, executed_transaction_id)` prevents duplicate execution rows. A duplicate execution request (same planned ID + transaction ID) returns 200 OK with the current planned state + `Idempotent-Replay: true` header instead of creating a duplicate row or error.

**Response Headers (Phase 3):**
| Header | Value | Meaning |
|--------|-------|---------|
| `Idempotent-Replay` | `true` | This response is a replay of an already-executed execution (unique violation caught). Safe to ignore; row already exists. |

**Response Status Codes:**
| Code | Condition |
|------|-----------|
| 200 | Execution recorded or replayed (idempotent) |
| 400 | Missing `executed_transaction_id` |
| 404 | Planned transaction not found |
| 500 | Database or calculation error |

**Idempotency Guarantee:**
The endpoint is safe to retry without risk of creating duplicate rows. Multiple requests with the same `(planned_id, executed_transaction_id)` pair always return the same result.

Implementation note (Phase 3 — verified Phase 5):
- Repository method `executeAndAdvance(plannedTransactionId, executedTransactionId, executionDate, updateFields = {})` wraps the insert-execution + update-parent pair in a single `BEGIN/COMMIT` transaction.
- Signature supports optional `updateFields` for planned transaction updates (e.g., advancing recurring next-date) in the same atomic call.
- On unique violation (Postgres 23505), transaction rolls back and returns `{ duplicate: true }` to the route.
- Route checks for `duplicate` flag and sets the `Idempotent-Replay` header before responding.
- Internal route refactor also uses shared `getCurrentDateString()` fallback helper for `execution_date` defaulting; response/side-effect behavior remains unchanged ([[apps/node-backend/src/routes/plannedTransactions.js]]).
- Test suite ([[apps/node-backend/tests/routes/plannedTransactions.test.js]]) verifies atomic execution via mocked `getById` chained calls (pre-exec + post-exec for response envelope) and `is_executed` advancement assertions from `executeAndAdvance.mock.calls` inspection.

### DELETE /api/planned-transactions/:id

Permanently delete a planned transaction.

### GET /api/planned-transactions/match-suggestions

> [!info] Registered before `/:id` in the router to prevent route-parameter capture.

Returns active, unexecuted planned payments that have at least one recent unlinked transaction that meets the moderate-tolerance match criteria **but** cannot be auto-linked because the match is ambiguous (0 candidates, or ≥2 planned payments matching the same transaction, or ≥2 transactions matching the same planned payment in a batch).

This endpoint is read-only and never mutates any state. The caller (frontend `MatchSuggestionsBanner`) uses it to surface candidates that the user can then confirm via the existing `POST /:id/execute` flow (opened through `LinkTransactionDialog`).

**Query Parameters:** none

**Response:**
```json
{
  "suggestions": [
    {
      "planned": {
        "id": 42,
        "memo": "Rent",
        "amount": -950.00,
        "planned_date": "2026-06-01",
        "recipient_id": 7,
        "recipient_name": "Landlord BV"
      },
      "candidates": [
        {
          "transaction_id": 1234,
          "amount": -940.50,
          "date": "2026-06-03",
          "recipient_name": "Landlord BV"
        }
      ]
    }
  ]
}
```

**Behavior:**
- Only active, unexecuted planned payments are considered.
- Transaction lookback is 45 days (sourced from `transactionRepository.listRecentUnlinked({ sinceDate })`).
- Loan-type planned payments (`is_loan = true`) are excluded.
- Returns an empty `suggestions` array when `autoClearPlannedOnMatch` is `false`.
- Recipient cluster roots are resolved via `recipientRepository.getClusterRootMap` so clustered aliases are compared correctly.

**Response Status Codes:**
| Code | Condition |
|------|-----------|
| 200 | Success (may be empty array) |
| 500 | Database error |

See [[docs/features/plannedTransactions#auto-link--auto-clear-on-ingest-june-2026|Feature: Auto-Link on Ingest]] for the full matching spec and tolerance rules.

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

## Testing Coverage Note (2026-04-16 Phase 5)

Recent coverage in [[apps/node-backend/tests/routes/plannedTransactions.test.js]] verifies:
- execute endpoint atomic idempotent behavior via `executeAndAdvance()` with duplicate detection (UNIQUE constraint on `(planned_transaction_id, executed_transaction_id)`)
- loan term bounds validation
- patch `recipient_name`/`category_name` name-to-id resolution
- loan toggle-off behavior clearing schedule and loan-specific fields
- `Idempotent-Replay` header on duplicate execution replays
- response envelope construction from `getById` calls before and after execution

Golden-fixture test suites added in Phase 3:
- [[apps/node-backend/tests/services/loanSchedule.golden.test.js]] — Loan amortization schedule generation (amortizing, fixed_principal, interest_only types with edge cases)
- [[apps/node-backend/tests/services/recurrence.golden.test.js]] — Recurring payment date calculation (all built-in patterns + edge cases like Jan 31 clamping, Feb 29 leap-year rollover)
