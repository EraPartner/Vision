---
title: Feature - Splits & Owes
type: feature
status: active
date: 2026-10-08
updated: 2026-10-08
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
    "apps/node-backend/src/routes/splits.ts",
    "apps/node-backend/src/services/splitService.js",
    "apps/node-backend/src/repositories/splitRepository.ts",
    "apps/node-backend/src/lib/calculations/splits.ts",
    "apps/node-backend/src/lib/money.ts",
    "apps/frontend/src/pages/OwesPage.tsx",
    "apps/frontend/src/features/splits/SplitTransactionDialog.tsx",
    "apps/frontend/src/features/splits/splitShares.ts",
    "apps/frontend/src/features/transactions/components/bulk/BulkSplitDialog.tsx",
    "apps/frontend/src/features/splits/owes/RecipientOwesDetail.tsx",
    "apps/frontend/src/features/splits/owes/RecentRecipientTransactionsTable.tsx",
    "apps/frontend/src/features/splits/owes/useRecentRecipientTransactions.ts",
    "apps/frontend/src/hooks/useSplits.ts",
  ]
---

# Feature: Splits & Owes

> [!tip] Shared expenses and repayments
> [Open the journey](../flow-visualizer.html#split-shared-expense). See [[docs/guides/visual-learning|Understand Vision Visually]] for the reading paths and conceptual diagrams.

## Overview

The Splits & Owes system allows users to track shared expenses and debts between people. It supports splitting a single transaction among multiple recipients and tracking partial payments toward settlement.

---

## Core Concepts

### Transaction Split

A **split** divides a transaction amount among multiple recipients. For example, a $100 dinner bill split among 3 people creates 3 split records. In the UI the **Split** action sits in the footer of the transaction inspector ([[docs/features/transactions#Inspector]]); `SplitTransactionDialog` takes a `trigger` element for it. The dialog's preset choice is a `SegmentedControl` with three options:

| Preset             | Each other person owes                                                                              | Reads as |
| ------------------ | --------------------------------------------------------------------------------------------------- | -------- |
| _Equal split_      | the amount divided by everyone including you                                                        | 50/50    |
| _Others pay all_   | the whole amount divided among the others only, cent-exact (`allocateEvenly` in `features/splits/splitShares.ts`): one person owes exactly the transaction, three owe shares that add up to it | 0/100    |
| _Custom amounts_   | what you type per person                                                                            | —        |

_Others pay all_ on a transaction that already has a split trips the existing over-allocation gate (the shares plus the existing splits exceed the total), so the dialog explains and disables **Split**.

Many transactions at once: the transactions page's multi-select toolbar has a bulk **Split…** action (`BulkSplitDialog`) that gives one payee the _Equal split_ or _Others pay all_ share of every selected row through `POST /api/splits/bulk` ([[docs/api/splits#POST /api/splits/bulk]], [[docs/features/bulk-actions]]). Already-split rows are left unchanged and reported in the toast.

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

Pure calculation functions in [[apps/node-backend/src/lib/calculations/splits.ts]] enforce three key invariants:

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
| POST   | `/api/splits/bulk`            | Bulk split: one payee, `equal` (50/50) or `full` (0/100) share of many transactions; already-split, zero-amount and missing rows skipped and counted; audit row per split with `bulk: true` |
| DELETE | `/api/splits/:id`             | Hard-delete split; writes audit row with action='delete' + pre-delete snapshot                                        |

### Payment & Settlement

| Method | Path                              | Description                                                                                                 |
| ------ | --------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| POST   | `/api/splits/:id/pay`             | Record a payment; validates under a row lock; writes audit row with action='payment'                        |
| GET    | `/api/splits/:id/payments`        | Get payment history                                                                                         |
| POST   | `/api/splits/:id/settle`          | Mark split as settled; writes audit row with action='settle'                                                |
| POST   | `/api/splits/owed/:id/settle-all` | Settle all unsettled splits for recipient; writes single audit row with action='settle_all' + settled_count |

Implementation notes:

- All routes resolve actor from the caller-supplied `x-actor` header, falling back to `null`, using `resolveActor(req)` ([[apps/node-backend/src/routes/splits.ts]]). This is audit context, not an authenticated user identity.
- Route-level ID parsing is standardized through `parseRouteId(req)` and reused across `:id` handlers ([[apps/node-backend/src/routes/splits.ts]]).
- Owed CSV export uses shared helpers (`OWED_EXPORT_HEADER`, `escapeCsvValue`, `buildOwedExportCsvRow`, `buildOwedExportCsv`, `buildOwedExportFilename`) for centralized CSV formatting with full escape support ([[apps/node-backend/src/routes/splits.ts]]).
- `splitService` validates allocation through the pure calculation module, persists single or batch rows through repository primitives, and writes each create audit row in the same transaction.
- POST `/api/splits/:id/pay` delegates to `splitService.addPayment`, which repeats the exact cap check under `SELECT ... FOR UPDATE` and runs insert, conditional auto-settlement, and audit in one transaction ([[apps/node-backend/src/services/splitService.js]]).
- Settlement and hard deletion also delegate to service transactions, so the mutation and its audit record commit or roll back together. DELETE returns 404 when the service reports no row.

---

## Frontend: Owes Page (`/owes`)

### Features

- **Owed Summary View**: Shows who owes whom with totals; linked recipients (aliases sharing a `primary_recipient_id`) are automatically collapsed into a single row
- **Per-Person Detail View**: Detailed breakdown per recipient; expands aliased recipients to show all splits from the full alias group
- **Split Source Context**: Shows original transaction recipient and memo
- **Payment controls**: A worded _Record payment_ button (with the payment icon) and a row ••• menu (Mark as settled, Delete split, confirmed) identify the source transaction and date. The detail header puts _Settle all_ first and _Export CSV_ in its ••• menu ([[docs/adr/187-completeness-sweep|ADR-187]]); the summary lists people as `ListRow`s and the page title reads _Who owes you_. The payment amount has an associated label and remaining-balance description.
- **Recent Recipient Transactions**: VirtualDataTable with infinite scroll showing recent transactions for the selected recipient using `recipient_group_id` filter (Phase Q) — includes all transactions for the recipient and all linked recipients in the same primary group, surfacing the full transaction history even when linked recipients are involved
- **Bulk Settle**: Settle all outstanding splits for a person with confirmation; settling a primary recipient or alias settles all unsettled splits from the entire alias group
- **Jump to Source**: Double-click any split row to open Transactions filtered to the source `transaction_id`

`OwesPage` is the summary composition root. The selected-recipient surface lives in
`features/splits/owes/RecipientOwesDetail.tsx`; its recent transaction table and guarded offset
pagination live beside it in `RecentRecipientTransactionsTable.tsx` and
`useRecentRecipientTransactions.ts`. The feature-local hook preserves the 10-row page size,
recipient-group query key, duplicate-ID suppression, and response-body total semantics.

### Recipient Alias Grouping (Owed View Consistency)

**Problem (pre-fix):** Two recipients linked via `primary_recipient_id` appeared as separate rows in the "Who owes you" (`GET /api/splits/owed`) summary, even though other reporting surfaces (categories, recipient insights) already collapsed aliased recipients into their primary. This created a view inconsistency — the owed page did not reflect the merge operation's intent to consolidate linked recipients.

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
- [[apps/node-backend/src/lib/calculations/splits.ts]] — Pure calc module for validation


## Clarity and recovery feedback

Debt-summary and recipient-detail query failures show a retry action rather than No outstanding debts or All settled. Cached details remain available with failure feedback when a refresh fails.
