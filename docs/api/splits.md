---
title: Splits API
type: endpoint
status: active
date: 2026-04-23
updated: 2026-08-19
tags:
  - api
  - splits
  - transactions
  - debt
  - phase-9
  - decimal
  - money
  - phase-q-plus
  - recipient-alias-collapsing
aliases:
  - splits-api
  - owes
  - debt-tracking
  - shared-expenses
  - settle-up
  - transaction-split
description: API endpoints for transaction splitting and debt tracking between recipients. Phase Q+ adds automatic recipient-alias collapsing on owed-summary endpoints to consolidate linked recipients (via merge operations) for consistency with merge semantics.
related_code:
  - apps/node-backend/src/routes/splits.js
  - apps/node-backend/src/repositories/splitRepository.js
---

# Splits API

Endpoints for transaction splitting and debt tracking. Allows splitting expenses between recipients and tracking who owes whom.

## Base URL

```
/api/splits
```

## Monetary Precision (Phase 9)

All monetary values in split responses (amounts, outstanding, paid) use **Decimal.js** for precision to eliminate IEEE 754 floating-point drift. Values are serialized as JSON `number` type, safe to 2 decimal places (cents). See [[docs/adr/021-decimal-arithmetic-for-monetary-values|ADR-021]] and [[docs/features/splits|Splits Feature]] for details.

## Validation Rules

### Split Allocation

- Split amounts must be **positive numbers**.
- The cumulative split amount for a transaction (existing splits + new split(s)) cannot exceed the absolute transaction amount.
- Validation uses `validateSplitAllocation` (single) or `validateBatchSplitAllocation` (batch) from the pure calc module ([[apps/node-backend/src/lib/calculations/splits.js]]).
- Decimal.js enforcement compares allocation at the `NUMERIC(18,4)` storage scale.
- If a transaction does not exist, split creation returns `404`.

### Payment Validation

- Payment amounts must be **positive numbers**.
- Sum of payments on a split cannot exceed the split's amount.
- Validation uses `validatePaymentAmount` from the pure calc module.
- The route returns 400 early. `splitRepository.addPayment` then locks the split row with `SELECT ... FOR UPDATE`, recomputes the total, and repeats the exact four-decimal cap before insert. This locked repository transaction is authoritative and serializes concurrent payment requests.
- There is no canonical DB-level overpayment trigger. Migration 0088 removes the weaker pre-squash trigger from upgraded databases; direct SQL can bypass the cap. See [[docs/adr/112-retire-legacy-split-overpayment-trigger|ADR-112]].

### Audit Trail

All split lifecycle events are recorded in `split_audit` table via `splitRepository.writeAudit()`:
- **create**: triggered by POST `/api/splits` or POST `/api/splits/batch`
- **pay**: triggered by POST `/api/splits/:id/pay`
- **settle**: triggered by POST `/api/splits/:id/settle`
- **settle_all**: triggered by POST `/api/splits/owed/:id/settle-all` (only written if settled_count > 0)
- **delete**: triggered by DELETE `/api/splits/:id`, captures pre-delete snapshot

Actor is resolved via: `x-actor` header → `req.user?.id` → `null`.

## List Pagination (opt-in)

Every list endpoint below (`GET /owed`, `GET /owed/:id`, `GET /transaction/:id`,
`GET /:id/payments`) answers the canonical collection body `{ items, total }` and
accepts optional `?limit=` (capped at 1000) and `?offset=` (default 0).

Send neither and the response holds the **complete** collection, with `total` equal to
the number of items returned — the behaviour these endpoints have always had. Send
either and the body additionally carries `limit` and `offset`, with `total` remaining
the full match count behind the page. `GET /owed` is derived in JS after the SQL
aggregate, so it pages the computed summary rather than the query; the wire contract
is identical.

## Endpoints

### GET /api/splits/owed

Get a summary of who owes what across all recipients.

Only unsettled splits with a positive remaining balance are included.

**Recipient Alias Grouping (Phase Q+):**
Linked recipients (those sharing a `primary_recipient_id` via merge operations) are automatically collapsed into a single row. The `recipient_id` returned is the primary recipient's id (or the recipient's own id if not aliased). This ensures the owed view remains consistent with merge operations — two recipients linked via `primary_recipient_id` appear as one logical entity.

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

Implementation note:
- Groups by `COALESCE(r.primary_recipient_id, r.id)` and returns `COALESCE(pr.name, r.name)` to collapse aliases into their primary. The aggregation joins `agg_split_outstanding` (trigger-maintained materialized view) + `recipients` + the primary recipient's name, filtering to unsettled splits. ([[apps/node-backend/src/repositories/splitRepository.js]]).

---

### GET /api/splits/owed/:id

Get detailed splits owed by a specific recipient.

**Parameters:**

| Field | Type | Description |
|-------|------|-------------|
| `id` | number | Recipient ID (positive integer) — can be a primary or alias recipient |

**Recipient Alias Grouping (Phase Q+):**
If the provided `id` is an alias (has a `primary_recipient_id`), the endpoint expands the query to include all splits from the entire alias group: the alias itself, its primary, and all sibling aliases. If the provided `id` is a primary recipient, it returns splits from the primary and all aliases pointing at it.

This ensures that viewing splits for a recipient shows the complete history even when splits are stored on different recipient ids within the same merge group.

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

Implementation note:
- Uses a CTE (`recipient_group`) to expand the input `recipientId` to all recipients in the same merge group. The CTE resolves to the recipient itself, any aliases pointing at it (when input is a primary), the recipient's primary (when input is an alias), and any siblings sharing that primary. The main query then filters `WHERE ts.recipient_id IN (SELECT id FROM recipient_group)` to retrieve the full group's splits. ([[apps/node-backend/src/repositories/splitRepository.js]]).

---

### GET /api/splits/owed/:id/export/csv

Export unsettled split transactions for a specific recipient as CSV, using the same transaction export columns.

**Recipient Alias Grouping (Phase Q+):**
If the provided `id` is an alias (has a `primary_recipient_id`), the export includes splits from the entire alias group. This matches the behavior of `GET /api/splits/owed/:id`, ensuring consistency.

Important behavior:

- Includes only splits from the recipient and all linked aliases that are **not settled** and still have a positive remaining amount.
- Returns **one CSV row per split transaction** for the entire alias group.
- `Amount` column is set to the split **remaining amount to settle** (`split.amount - paid`), not the original transaction amount.

**Parameters:**

| Field | Type | Description |
|-------|------|-------------|
| `id` | number | Recipient ID (positive integer) — can be a primary or alias recipient |

**Response:** `200 OK`

- Content type: `text/csv`
- Header: `Date,Bank Account,Recipient,Memo,Amount,Currency,Balance,Category,Comment`

**Error Responses:**

- `404 Not Found` when no unsettled owed transactions exist for that recipient (or the recipient group).

Implementation notes:
- Uses the same `recipient_group` CTE as `GET /api/splits/owed/:id` to expand the input to all linked aliases. The export includes all splits from recipients in the group, filtering to unsettled splits with a positive remaining amount. ([[apps/node-backend/src/repositories/splitRepository.js]]).

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

The endpoint validates split allocation via `validateSplitAllocation` before write and records a `create` audit trail entry.

**Request Body:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `transaction_id` | number | Yes | ID of the transaction to split |
| `recipient_id` | number | Yes | ID of the recipient who owes |
| `amount` | number | Yes | Amount owed (positive number) |
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
{ "ok": false, "error": { "code": "APP_ERROR", "message": "Missing required fields: transaction_id, recipient_id, amount" } }
```

```json
{ "ok": false, "error": { "code": "APP_ERROR", "message": "Split amount exceeds transaction total" } }
```

**Error Response:** `404 Not Found`

```json
{ "ok": false, "error": { "code": "APP_ERROR", "message": "Transaction not found" } }
```

Implementation notes:
- Allocation validation via `validateSplitAllocation({ newSplitAmount, transactionTotal, currentSplitTotal })` ([[apps/node-backend/src/lib/calculations/splits.js]]).
- Audit trail written via `splitRepository.writeAudit()` with action='create' and request actor resolved from headers ([[apps/node-backend/src/routes/splits.js]]).

---

### POST /api/splits/batch

Create multiple splits for a transaction at once.

The endpoint validates total batch allocation via `validateBatchSplitAllocation` before writes and records a `create` audit trail entry per split (with `batch: true` in payload).

**Request Body:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `transaction_id` | number | Yes | ID of the transaction to split |
| `splits` | array | Yes | Array of split objects (non-empty) |

**Split Object:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `recipient_id` | number | Yes | ID of the recipient |
| `amount` | number | Yes | Amount owed (positive number) |
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
{ "ok": false, "error": { "code": "APP_ERROR", "message": "Missing required fields: transaction_id, splits[]" } }
```

```json
{ "ok": false, "error": { "code": "APP_ERROR", "message": "Split amount exceeds transaction total" } }
```

**Error Response:** `404 Not Found`

```json
{ "ok": false, "error": { "code": "APP_ERROR", "message": "Transaction not found" } }
```

Implementation notes:
- Batch allocation validation via `validateBatchSplitAllocation({ splits, transactionTotal, currentSplitTotal })` ([[apps/node-backend/src/lib/calculations/splits.js]]).
- Normalized inputs via `normalizeBatchSplitInputs(splits)` to filter and type-cast before validation ([[apps/node-backend/src/routes/splits.js]]).
- Persists all splits via bulk insert `createSplitsBatch()` after validation ([[apps/node-backend/src/repositories/splitRepository.js]]).
- Audit trail: one row per split with action='create' and `batch: true` in payload ([[apps/node-backend/src/routes/splits.js]]).

---

### POST /api/splits/:id/pay

Record a payment towards a split.

The endpoint validates payment amount via `validatePaymentAmount` before write. Split must exist; payment validates against split's remaining balance. The split is automatically settled if payment covers the full remaining amount.

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
  "paid_at": "2025-01-20"
}
```

**Error Response:** `404 Not Found`

```json
{ "ok": false, "error": { "code": "APP_ERROR", "message": "Split not found" } }
```

**Error Response:** `400 Bad Request`

```json
{ "ok": false, "error": { "code": "APP_ERROR", "message": "Payment would exceed split outstanding balance" } }
```

```json
{ "ok": false, "error": { "code": "APP_ERROR", "message": "Payment amount must be a positive number" } }
```

Implementation notes:
- Fetches split via `getSplitById(splitId)` and returns 404 if missing ([[apps/node-backend/src/routes/splits.js]]).
- Gets already-paid amount via `getAlreadyPaid(splitId)` ([[apps/node-backend/src/repositories/splitRepository.js]]).
- Validates payment amount via `validatePaymentAmount({ paymentAmount, splitAmount, alreadyPaid })` ([[apps/node-backend/src/lib/calculations/splits.js]]).
- `addPayment()` repeats the cap check under a split-row lock, then inserts the payment, conditionally auto-settles, and writes the audit row in one DB transaction ([[apps/node-backend/src/repositories/splitRepository.js]]).
- Actor is propagated to the audit trail via `resolveActor(req)` ([[apps/node-backend/src/routes/splits.js]]).

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

This is a manual settlement operation (not triggered by payment reaching the full amount). Records a `settle` audit trail entry with `manual: true`.

**Parameters:**

| Field | Type | Description |
|-------|------|-------------|
| `id` | number | Split ID (positive integer) |

**Response:** `200 OK` — the full `SplitItem` shape, with the real payment
aggregate (`amount_paid` is the sum of recorded payments, not a fabricated `0`)
and the recipient's name:

```json
{
  "id": 1,
  "transaction_id": 100,
  "recipient_id": 2,
  "recipient_name": "Alice",
  "amount": 50.00,
  "amount_paid": 30.00,
  "note": null,
  "is_settled": true,
  "created_at": "2026-03-01T10:00:00.000Z",
  "updated_at": "2026-03-05T10:00:00.000Z"
}
```

**Error Response:** `404 Not Found`

```json
{ "ok": false, "error": { "code": "APP_ERROR", "message": "Split not found" } }
```

Implementation notes:
- Settles split via `settleSplit(splitId)` and returns 404 if missing ([[apps/node-backend/src/repositories/splitRepository.js]]).
- `settleSplit` re-selects the updated row through `recipients` and a per-split `split_payments` aggregate (same CTE re-select idiom as `createSplitAtomic`), so `recipient_name`/`amount_paid` in the response are real values — the bare `RETURNING *` it used before fabricated `recipient_name: null` / `amount_paid: 0`.
- Records audit trail via `writeAudit()` with action='settle' and payload `{ manual: true }` ([[apps/node-backend/src/routes/splits.js]]).

---

### POST /api/splits/owed/:id/settle-all

Mark all **unsettled** splits for a specific recipient as settled.

**Recipient Alias Grouping (Phase Q+):**
If the provided `id` is an alias (has a `primary_recipient_id`), all unsettled splits from the entire alias group are settled. This ensures that settling a primary or alias recipient settles all owed amounts from the entire merge group.

This endpoint matches existing settlement behavior: it only sets `is_settled = true` and does **not** create payment records. Records a `settle_all` audit trail entry only if settled_count > 0.

**Parameters:**

| Field | Type | Description |
|-------|------|-------------|
| `id` | number | Recipient ID (positive integer) — can be a primary or alias recipient |

**Response:** `200 OK`

```json
{
  "settled_count": 3
}
```

**Error Response:** `500 Internal Server Error`

```json
{ "ok": false, "error": { "code": "APP_ERROR", "message": "Error settling all splits for recipient" } }
```

Implementation notes:
- Uses the same `recipient_group` CTE as `GET /api/splits/owed/:id` to expand the input to all linked aliases. The UPDATE statement sets `is_settled = true` for all unsettled splits from recipients in the group, returning the number of settled rows via `result.rowCount`. ([[apps/node-backend/src/repositories/splitRepository.js]]).
- Audit trail written only if `settled_count > 0`, with action='settle_all' and payload containing recipient_id and settled_count ([[apps/node-backend/src/routes/splits.js]]).

---

### DELETE /api/splits/:id

Hard-delete a split.

Splits are physically deleted (not soft-deleted). The deletion is permanent and irreversible. A `delete` audit trail entry is written with the pre-delete snapshot (split_id, transaction_id, recipient_id, amount), so the split can be reconstructed for auditing purposes but not recovered.

**Parameters:**

| Field | Type | Description |
|-------|------|-------------|
| `id` | number | Split ID (positive integer) |

**Response:** `204 No Content` — empty body, no envelope (see [[docs/reference/code-patterns#DELETE Response Pattern|DELETE Response Pattern]]).

**Error Response:** `404 Not Found`

```json
{ "ok": false, "error": { "code": "APP_ERROR", "message": "Split not found" } }
```

Implementation notes:
- Fetches split via `getSplitById(splitId)` for pre-delete snapshot; returns 404 if missing ([[apps/node-backend/src/routes/splits.js]]).
- Hard-deletes via `deleteSplit(splitId)`, which cascades to split_payments via ON DELETE CASCADE ([[apps/node-backend/src/repositories/splitRepository.js]]).
- Audit trail written via `writeAudit()` with action='delete', split_id=null (since split is deleted), and payload containing the snapshot ([[apps/node-backend/src/routes/splits.js]]).
- Split audit rows survive deletion via `ON DELETE SET NULL` on split_id FK, enabling forensic reconstruction ([[docs/adr/013-split-hard-delete-with-audit-trail]]).

## TypeScript Types

**File:** [[apps/frontend/src/lib/api/splits.ts]] — the single home for these shapes
(a second, drifted copy under `types/splits.ts` was folded in).

```typescript
interface SplitItem {
  id: number;
  transaction_id: number;
  recipient_id: number;
  recipient_name: string | null;
  amount: number;
  amount_paid: number;
  note: string | null;
  is_settled: boolean;
  created_at: string;
  updated_at: string;
}

interface OwedDetailItem extends SplitItem {
  transaction_date: string;
  transaction_memo?: string | null;
  transaction_amount: number;
  transaction_currency: string;
  bank_account?: string | null;
  transaction_recipient_name?: string | null;
  remaining: number;
}

interface OwedSummaryItem {
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
  note: string | null;
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
- [[docs/features/splits]] - Feature specification
- [[docs/adr/013-split-hard-delete-with-audit-trail]] - Audit trail design and hard-delete semantics
- [[apps/node-backend/src/lib/calculations/splits.js]] - Pure validation module
- [[docs/components/form-dialogs|SplitTransactionDialog]] - Frontend split dialog component

## Migrations

- `0019_transaction_splits_and_agg.py` — Added `transaction_splits`, `split_payments`, and the trigger-maintained outstanding aggregate
- `0021_split_audit.py` — Added the append-only `split_audit` table
- `0088_money_precision_alignment.py` — Widened split and payment amounts to `NUMERIC(18,4)` and retired the pre-squash overpayment trigger on upgraded databases
