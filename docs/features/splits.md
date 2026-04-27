---
title: Feature - Splits & Owes
type: feature
status: active
date: 2026-04-22
updated: 2026-04-27
tags: [feature, splits, owes, debts, shared-expenses, phase-4, phase-9, decimal, money, i18n, notifications]
description: Transaction splitting and debt tracking between recipients, with overpayment guards and audit trail; uses Decimal.js for precise monetary calculations. Includes settlement notifications via toast messages with i18n keys.
aliases: [splits-feature, owes-feature, debts, shared expenses, roommate expenses]
related_code: ["apps/node-backend/src/routes/splits.js", "apps/node-backend/src/repositories/splitRepository.js", "apps/node-backend/src/services/calculations/splits.js", "apps/node-backend/src/lib/money.js", "apps/frontend/src/pages/OwesPage.tsx", "apps/frontend/src/components/splits/SplitTransactionDialog.tsx", "apps/frontend/src/hooks/useSplits.ts"]
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

### Split Audit Trail

Phase 4 introduces a **split_audit** table (migration 0028) that records all lifecycle events: split creation, payment, settlement, and deletion. Each audit row captures:
- `action`: one of `create`, `pay`, `settle`, `settle_all`, or `delete`
- `actor`: resolved from `x-actor` header → `req.user?.id` → `null`
- `payload`: context-specific data (e.g., split snapshot on delete, payment amount on pay)

Splits are **hard-deleted** (not soft-deleted), but audit rows survive via `ON DELETE SET NULL` on the `split_id` FK.

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
| actor | VARCHAR(64) | Who recorded the payment |
| created_at | TIMESTAMPTZ | Creation timestamp |

**Migration:** `0009_transaction_splits.py`

### split_audit

| Column | Type | Description |
|--------|------|-------------|
| id | BIGSERIAL | Primary key |
| split_id | INTEGER | FK to transaction_splits (ON DELETE SET NULL) |
| action | VARCHAR(32) CHECK IN ('create', 'settle', 'settle_all', 'delete') | Event type |
| actor | VARCHAR(64) | Who performed the action |
| payload | JSONB | Context-specific data (e.g., amount, recipient_id, payment info) |
| created_at | TIMESTAMPTZ | Event timestamp |

**Indices:**
- `idx_split_audit_split_created` on (split_id, created_at DESC)
- `idx_split_audit_action_created` on (action, created_at DESC)

**Migration:** `0028_split_audit_overpayment_guard.py` — Also adds `fn_split_payment_overpayment_guard()` trigger on split_payments to enforce sum(payments) ≤ split.amount + 0.005 CENT at the database level (SQLSTATE 23514).

---

## Validation & Overpayment Guards

Phase 4 introduces pure calculation functions in [[apps/node-backend/src/services/calculations/splits.js]] that enforce three key invariants:

1. **Split allocation** — The sum of splits on a transaction cannot exceed the transaction's absolute amount.
2. **Payment amount** — The sum of payments on a split cannot exceed the split's amount.
3. **Decimal precision** — All monetary calculations use [[docs/adr/021-decimal-arithmetic-for-monetary-values|Decimal.js]] (Phase 9) to eliminate floating-point drift. Legacy tolerance checks `CENT_TOLERANCE = 0.005` are now redundant but kept for backward compatibility with pre-Phase-9 imports.

### Key Functions

| Function | Purpose |
|----------|---------|
| `validateSplitAllocation({ newSplitAmount, transactionTotal, currentSplitTotal })` | Validate a single split creation or batch sum |
| `validateBatchSplitAllocation({ splits, transactionTotal, currentSplitTotal })` | Validate a batch of splits at once |
| `validatePaymentAmount({ paymentAmount, splitAmount, alreadyPaid })` | Validate a payment against a split |
| `computeSplitRemaining(split)` | Compute remaining balance on a split |
| `computeOwedSummary(rows)` | Transform aggregation rows into owed summary |
| `roundToCents(value)` | Round to 2 decimal places |

### Defense in Depth

Overpayment protection operates at three layers:
1. **Route level** — `validatePaymentAmount` returns 400 before DB write
2. **Database level** — `fn_split_payment_overpayment_guard()` trigger raises SQLSTATE 23514 if invariant violated
3. **Audit level** — Every accepted write is recorded in `split_audit` for forensic reconstruction

> [!info] Locked contracts (Phase 8)
> The split allocation and payment-cap invariants are pinned by property tests in [[apps/node-backend/tests/property/splits.property.test.js]] — bounded random split sets must always satisfy `sum(splits) ≤ transactionTotal + CENT_TOLERANCE` and `sum(payments) ≤ split.amount + CENT_TOLERANCE`. Any change to the calc surface must keep these invariants green. See [[docs/testing/testing#property-test-pattern-phase-8|Property Test Pattern]] and [[apps/node-backend/tests/golden/INVENTORY|Calculation Inventory]].

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
| POST | `/api/splits` | Create a single split; validates allocation against transaction total; writes audit row with action='create' |
| POST | `/api/splits/batch` | Create multiple splits; batch validation via `validateBatchSplitAllocation`; audit row per split with action='create' |
| DELETE | `/api/splits/:id` | Hard-delete split; writes audit row with action='delete' + pre-delete snapshot |

### Payment & Settlement

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/splits/:id/pay` | Record a payment; validates via `validatePaymentAmount`; writes audit row with action='pay' |
| GET | `/api/splits/:id/payments` | Get payment history |
| POST | `/api/splits/:id/settle` | Mark split as settled; writes audit row with action='settle' |
| POST | `/api/splits/owed/:id/settle-all` | Settle all unsettled splits for recipient; writes single audit row with action='settle_all' + settled_count |

Implementation notes:
- All routes resolve actor via `x-actor` header → `req.user?.id` → `null` using `resolveActor(req)` ([[apps/node-backend/src/routes/splits.js]]).
- Route-level ID parsing is standardized through `parseRouteId(req)` and reused across `:id` handlers ([[apps/node-backend/src/routes/splits.js]]).
- Owed CSV export uses shared helpers (`OWED_EXPORT_HEADER`, `escapeCsvValue`, `buildOwedExportCsvRow`, `buildOwedExportCsv`, `buildOwedExportFilename`) for centralized CSV formatting with full escape support ([[apps/node-backend/src/routes/splits.js]]).
- Split creation routes validate allocation against transaction total using `validateSplitAllocation` (single) or `validateBatchSplitAllocation` (batch) from the pure calc module ([[apps/node-backend/src/services/calculations/splits.js]]).
- Batch split creation persists rows through repository bulk insert (`createSplitsBatch`) after validation, reducing per-split round-trips ([[apps/node-backend/src/repositories/splitRepository.js]]).
- POST `/api/splits/:id/pay` validates payment amount via `validatePaymentAmount` before DB write, then proceeds through `addPayment` which runs insert + conditional auto-settlement in a single transaction ([[apps/node-backend/src/repositories/splitRepository.js]]).
- DELETE returns 404 if split not found; hard-deletes the row and audits the full pre-delete snapshot ([[apps/node-backend/src/routes/splits.js]]).

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

### User Feedback & Notifications

Settlement operations provide real-time user feedback via toast notifications (managed by the `useSplits` hooks):

| Operation | Success Toast | Error Toast |
|-----------|---|---|
| Settle individual split | `splits.settled` — "Splits settled" | `splits.settledFailed` — "Failed to settle splits" |
| Settle all splits (bulk) | `splits.allSettled` — "n splits settled" | `splits.allSettledFailed` — Error with description |

i18n keys are defined in `i18n/source/en.json` and `i18n/source/nl.json` and accessed via `useLanguage()` hook in [[apps/frontend/src/hooks/useSplits.ts]].

---

## Use Cases

1. **Roommate expenses** — Split rent, utilities, groceries
2. **Group dinners** — Divide restaurant bills
3. **Shared vacations** — Track who paid for what
4. **Family lending** — Track informal loans

---

## Related

- [[docs/api/splits]] — API documentation
- [[docs/adr/013-split-hard-delete-with-audit-trail]] — Audit trail design and hard-delete semantics
- [[docs/features/views#owes]] — Owes page in views
- [[docs/adr/002-database-schema#transaction-splits-tables]] — Schema details
- [[apps/node-backend/src/services/calculations/splits.js]] — Pure calc module for validation
