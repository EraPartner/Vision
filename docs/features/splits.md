---
title: Feature - Splits & Owes
type: feature
status: active
date: 2026-04-22
updated: 2026-09-04
tags:
  [
    feature,
    splits,
    owes,
    debts,
    shared-expenses,
    phase-4,
    phase-9,
    phase-q,
    decimal,
    money,
    i18n,
    notifications,
    recipient-groups,
    recipient-alias-collapsing,
  ]
description: Transaction splitting and debt tracking between recipients, with overpayment guards and audit trail; uses Decimal.js for precise monetary calculations. Includes settlement notifications via toast messages with i18n keys. Phase Q adds recipient-group filtering for complete transaction history in OwesPage. Phase Q+ adds recipient-alias collapsing on owed-summary endpoints to consolidate linked recipients (via merge operations) into single rows for consistency with other reporting surfaces.
aliases:
  [splits-feature, owes-feature, debts, shared expenses, roommate expenses]
related_code:
  [
    "apps/node-backend/src/routes/splits.js",
    "apps/node-backend/src/services/splitService.js",
    "apps/node-backend/src/repositories/splitRepository.js",
    "apps/node-backend/src/lib/calculations/splits.js",
    "apps/node-backend/src/lib/money.js",
    "apps/frontend/src/pages/OwesPage.tsx",
    "apps/frontend/src/features/splits/SplitTransactionDialog.tsx",
    "apps/frontend/src/features/splits/owes/RecipientOwesDetail.tsx",
    "apps/frontend/src/features/splits/owes/RecentRecipientTransactionsTable.tsx",
    "apps/frontend/src/features/splits/owes/useRecentRecipientTransactions.ts",
    "apps/frontend/src/hooks/useSplits.ts",
  ]
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

The **split_audit** table (migration 0021) records all lifecycle events: split creation, payment, settlement, and deletion. Each audit row captures:

- `action`: one of `create`, `payment`, `settle`, `settle_all`, or `delete`
- `actor`: caller-supplied `x-actor` header, or `null` when absent
- `payload`: context-specific data (e.g., split snapshot on delete, payment amount on payment)

Splits are **hard-deleted** (not soft-deleted), but audit rows survive via `ON DELETE SET NULL` on the `split_id` FK.

---

## Database Schema

### transaction_splits

| Column         | Type          | Description                   |
| -------------- | ------------- | ----------------------------- |
| id             | SERIAL        | Primary key                   |
| transaction_id | INTEGER       | Parent transaction            |
| recipient_id   | INTEGER       | Recipient who owes            |
| amount         | NUMERIC(18,4) | Split amount (migration 0088) |
| is_settled     | BOOLEAN       | Settlement status             |
| created_at     | TIMESTAMPTZ   | Creation timestamp            |
| updated_at     | TIMESTAMPTZ   | Last update                   |

### split_payments

| Column     | Type          | Description                     |
| ---------- | ------------- | ------------------------------- |
| id         | SERIAL        | Primary key                     |
| split_id   | INTEGER       | Reference to split              |
| amount     | NUMERIC(18,4) | Payment amount (migration 0088) |
| paid_at    | DATE          | Payment date                    |
| note       | TEXT          | Payment note                    |
| created_at | TIMESTAMPTZ   | Creation timestamp              |

**Migration:** `0019_transaction_splits_and_agg.py`

### split_audit

| Column     | Type        | Description                                                           |
| ---------- | ----------- | --------------------------------------------------------------------- |
| id         | BIGSERIAL   | Primary key                                                           |
| split_id   | INTEGER     | FK to transaction_splits (ON DELETE SET NULL)                         |
| action     | VARCHAR(50) | Event type (`create`, `payment`, `settle`, `settle_all`, or `delete`) |
| actor      | TEXT        | Who performed the action                                              |
| payload    | JSONB       | Context-specific data (e.g., amount, recipient_id, payment info)      |
| created_at | TIMESTAMPTZ | Event timestamp                                                       |

**Index:** `idx_split_audit_split_id` on (`split_id`)

**Migration:** `0021_split_audit.py`

---

## Validation & Overpayment Guards

Pure calculation functions in [[apps/node-backend/src/lib/calculations/splits.js]] enforce three key invariants:

1. **Split allocation** — The sum of splits on a transaction cannot exceed the transaction's absolute amount.
2. **Payment amount** — The sum of payments on a split cannot exceed the split's amount.
3. **Decimal precision** — Split and payment caps are normalized and compared at the `NUMERIC(18,4)` storage scale. Display totals may still round to cents.

### Key Functions

| Function                                                                           | Purpose                                             |
| ---------------------------------------------------------------------------------- | --------------------------------------------------- |
| `validateSplitAllocation({ newSplitAmount, transactionTotal, currentSplitTotal })` | Validate a single split creation or batch sum       |
| `validateBatchSplitAllocation({ splits, transactionTotal, currentSplitTotal })`    | Validate a batch of splits at once                  |
| `validatePaymentAmount({ paymentAmount, splitAmount, alreadyPaid })`               | Validate a payment against a split                  |
| `roundToMoneyPrecision(value)`                                                     | Normalize a value to the four-decimal storage scale |
| `computeSplitRemaining(split)`                                                     | Compute remaining balance on a split                |
| `computeOwedSummary(rows)`                                                         | Transform aggregation rows into owed summary        |
| `roundToCents(value)`                                                              | Round to 2 decimal places                           |

### Defense in Depth

Overpayment protection operates at three layers:

1. **Route level** — `validatePaymentAmount` returns 400 before the repository call.
2. **Locked service transaction** — `splitService.addPayment` locks the split row through a repository primitive, recomputes the paid total, and rejects an exact four-decimal overpayment before inserting. The lock serializes concurrent payment requests.
3. **Audit level** — Every accepted write is recorded in `split_audit` in the same transaction.

> [!warning] No canonical overpayment trigger
> Fresh databases never created the pre-squash `fn_split_payment_overpayment_guard()` trigger.
> Migration 0088 removes it from older databases because its cent-scale rule and `UPDATE OF`
> dependency block the precision alignment. Direct SQL can bypass the cap; use the API or
> service path. See [[docs/adr/112-retire-legacy-split-overpayment-trigger|ADR-112]].

> [!info] Locked contracts (Phase 8)
> The split allocation and payment-cap invariants are pinned by property tests in [[apps/node-backend/tests/property/splits.property.test.js]]. The migration 0088 database suite adds sub-cent cases at the exact four-decimal storage boundary. Any change to the calculation surface must keep both suites green. See [[docs/testing/testing#property-test-pattern-phase-8|Property Test Pattern]] and [[apps/node-backend/tests/moneyPrecisionAlignment.db.test.js|Money precision migration tests]].

---

## API Endpoints

### Owed Summary

| Method | Path                              | Description                         |
| ------ | --------------------------------- | ----------------------------------- |
| GET    | `/api/splits/owed`                | Overall owed summary                |
| GET    | `/api/splits/owed/:id`            | Owed summary for specific recipient |
| GET    | `/api/splits/owed/:id/export/csv` | Export owed data as CSV             |

### Split Management

| Method | Path                          | Description                                                                                                           |
| ------ | ----------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| GET    | `/api/splits/transaction/:id` | Get splits for a transaction                                                                                          |
| POST   | `/api/splits`                 | Create a single split; validates allocation against transaction total; writes audit row with action='create'          |
| POST   | `/api/splits/batch`           | Create multiple splits; batch validation via `validateBatchSplitAllocation`; audit row per split with action='create' |
| DELETE | `/api/splits/:id`             | Hard-delete split; writes audit row with action='delete' + pre-delete snapshot                                        |

### Payment & Settlement

| Method | Path                              | Description                                                                                                 |
| ------ | --------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| POST   | `/api/splits/:id/pay`             | Record a payment; validates under a row lock; writes audit row with action='payment'                        |
| GET    | `/api/splits/:id/payments`        | Get payment history                                                                                         |
| POST   | `/api/splits/:id/settle`          | Mark split as settled; writes audit row with action='settle'                                                |
| POST   | `/api/splits/owed/:id/settle-all` | Settle all unsettled splits for recipient; writes single audit row with action='settle_all' + settled_count |

Implementation notes:

- All routes resolve actor from the caller-supplied `x-actor` header, falling back to `null`, using `resolveActor(req)` ([[apps/node-backend/src/routes/splits.js]]). This is audit context, not an authenticated user identity.
- Route-level ID parsing is standardized through `parseRouteId(req)` and reused across `:id` handlers ([[apps/node-backend/src/routes/splits.js]]).
- Owed CSV export uses shared helpers (`OWED_EXPORT_HEADER`, `escapeCsvValue`, `buildOwedExportCsvRow`, `buildOwedExportCsv`, `buildOwedExportFilename`) for centralized CSV formatting with full escape support ([[apps/node-backend/src/routes/splits.js]]).
- `splitService` validates allocation through the pure calculation module, persists single or batch rows through repository primitives, and writes each create audit row in the same transaction.
- POST `/api/splits/:id/pay` delegates to `splitService.addPayment`, which repeats the exact cap check under `SELECT ... FOR UPDATE` and runs insert, conditional auto-settlement, and audit in one transaction ([[apps/node-backend/src/services/splitService.js]]).
- Settlement and hard deletion also delegate to service transactions, so the mutation and its audit record commit or roll back together. DELETE returns 404 when the service reports no row.

---

## Frontend: Owes Page (`/owes`)

### Features

- **Owed Summary View**: Shows who owes whom with totals; linked recipients (aliases sharing a `primary_recipient_id`) are automatically collapsed into a single row
- **Per-Person Detail View**: Detailed breakdown per recipient; expands aliased recipients to show all splits from the full alias group
- **Split Source Context**: Shows original transaction recipient and memo
- **Recent Recipient Transactions**: VirtualDataTable with infinite scroll showing recent transactions for the selected recipient using `recipient_group_id` filter (Phase Q) — includes all transactions for the recipient and all linked recipients in the same primary group, surfacing the full transaction history even when linked recipients are involved
- **Bulk Settle**: Settle all outstanding splits for a person with confirmation; settling a primary recipient or alias settles all unsettled splits from the entire alias group
- **Jump to Source**: Double-click any split row to open Transactions filtered to the source `transaction_id`

`OwesPage` is the summary composition root. The selected-recipient surface lives in
`features/splits/owes/RecipientOwesDetail.tsx`; its recent transaction table and guarded offset
pagination live beside it in `RecentRecipientTransactionsTable.tsx` and
`useRecentRecipientTransactions.ts`. The feature-local hook preserves the 10-row page size,
recipient-group query key, duplicate-ID suppression, and response-body total semantics.

### Recipient Alias Grouping (Owed View Consistency)

**Problem (pre-fix):** Two recipients linked via `primary_recipient_id` appeared as separate rows in the "Who Owes You" (`GET /api/splits/owed`) summary, even though other reporting surfaces (categories, recipient insights) already collapsed aliased recipients into their primary. This created a view inconsistency — the owed page did not reflect the merge operation's intent to consolidate linked recipients.

**Root Cause:** The legacy merge endpoint (ADR-014) only stamped `primary_recipient_id` on aliases without reassigning split FKs. Splits created before the merge remained stored against the alias recipient_id. The owed summary did not collapse these together.

**Solution (Phase Q+):** All three owed-summary endpoints now collapse linked recipients:

1. **`getOwedSummary()`** — Groups by `COALESCE(r.primary_recipient_id, r.id)` and returns the primary's `name` (or alias name if not linked). The returned `recipient_id` is the primary's id (or self when not aliased). Aliases now appear as a single row on the summary.

2. **`getOwedByRecipient(recipientId)`** — Accepts either a primary or alias recipient id. A CTE (`recipient_group`) expands the input to the full alias group:
   - If input is a primary, returns all splits from that primary + all aliases
   - If input is an alias, returns all splits from that alias + the primary + sibling aliases
   - Supplies the full transaction history even when splits are stored on alias recipient_ids

3. **`getOwedExportRowsByRecipient(recipientId)`** — Same group expansion; exported CSV includes all splits from the entire alias group.

4. **`settleAllByRecipient(recipientId)`** — Same group expansion; settling a primary settles all unsettled splits from that primary and all aliases in the group.

**CTE Definition:**

```sql
WITH recipient_group AS (
  SELECT id FROM recipients
  WHERE id = $1
     OR primary_recipient_id = $1
     OR id = (SELECT primary_recipient_id FROM recipients WHERE id = $1 AND primary_recipient_id IS NOT NULL)
     OR primary_recipient_id = (SELECT primary_recipient_id FROM recipients WHERE id = $1 AND primary_recipient_id IS NOT NULL)
)
```

**Result:** The owed page now shows one row per "logical recipient" (primary + all aliases treated as a unit), matching the behavior of the recipients merge and other reporting surfaces.

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

| Operation                | Success Toast                            | Error Toast                                        |
| ------------------------ | ---------------------------------------- | -------------------------------------------------- |
| Settle individual split  | `splits.settled` — "Splits settled"      | `splits.settledFailed` — "Failed to settle splits" |
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
- [[apps/node-backend/src/lib/calculations/splits.js]] — Pure calc module for validation
