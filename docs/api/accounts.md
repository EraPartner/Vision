---
title: API - Accounts
type: endpoint
method: GET, POST, PATCH, DELETE
path: /api/accounts
description: Account entity management (ADR-088) — the user's own accounts spanning budgeting cash, portfolio holdings, and liabilities
date: 2026-06-21
updated: 2026-07-22
tags: [api, accounts, account-entity, adr-088, net-worth, cash-sleeve, rename-propagation, lifecycle, normalized-identity]
status: active
aliases: [accounts-api, account-management, account-entity]
related_code: [[apps/node-backend/src/routes/accounts.js]], [[apps/node-backend/src/services/accountService.js]], [[apps/node-backend/src/repositories/accountRepository.js]]
---

# Accounts API

## Overview

Accounts (ADR-088) replace the implicit free-text `bank_account` string with a real entity that
is the spine across all three workspaces — budgeting cash (the transactions ledger), portfolio
holdings, and liabilities. An account is the user's *own* account; this is distinct from
`recipient_bank_accounts` (counterparty IBANs).

During the dual-write phase a database trigger (migration 0051) keeps `transactions.account_id`
and `planned_transactions.account_id` in sync with the `bank_account` string; writers therefore
don't have to set `account_id` directly yet. The orthogonal flag columns
(`type` / `liquidity_class` / `spendable` / `in_net_worth` / `tax_wrapper` / `owner` /
`multi_currency_cash` / `has_cash_sleeve`) exist from migration 0050; their behaviour is
activated in ADR-089.

## Endpoints

### GET /api/accounts

List accounts.

**Query Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| active | `true` \| `false` \| `all` | `true` | Filter by active status |
| limit | integer | — (unbounded) | Page size, capped at 1000 |
| offset | integer | `0` | Rows to skip |

Returns `{ items: Account[], total, links }`. Pagination is **opt-in**: send neither
`limit` nor `offset` and the response holds every matching account (`total` = that
count, no `limit`/`offset` keys). Send either and the body adds `limit` + `offset`
while `total` stays the full match count.

### GET /api/accounts/:id

Fetch a single account (404 if not found).

### POST /api/accounts

Create an account. Body: `AccountCreate` (`name` required; all flags optional, falling back to
DB defaults — `type='checking'`, `owner='me'`, `in_net_worth=true`, `has_cash_sleeve=true`).
`currency` is validated as ISO-4217 and uppercased. Returns `201` with the created account, or
`409` if an account with that name already exists. Identity is case/whitespace-insensitive
(`lower(btrim(name))`, migration 0066 — [[docs/adr/088-account-entity|ADR-088 addendum]], D1):
"Checking" collides with "CHECKING"; the stored name keeps the creator's casing for display.
`statement_balance` requires `statement_balance_date` (400 without it; backstopped by the
migration-0065 CHECK).

### PATCH /api/accounts/:id

Partial update (`AccountUpdate`). `404` if not found, `409` on (normalized) name collision.

Explicit `null` **clears** a nullable field (`display_name`, `institution`,
`funding_account_id`, `statement_balance`, `statement_balance_date`); an omitted key leaves the
field untouched. The statement-balance/date pairing is validated on the merged state: setting a
balance while the stored date is `NULL`, or clearing only the date, both return 400.

Lifecycle ([[docs/adr/088-account-entity|ADR-088 addendum]], D5): `{ is_active: false }` stamps
`closed_at` server-side (kept on redundant re-archives); `{ is_active: true }` clears it.
`closed_at` is never accepted from the request body.

**Aggregate semantics on close (WP-A3, §1 F3):** closing an account (`is_active: false` on an
active account) also sets `in_net_worth = false` server-side, so the account drops out of net
worth, the by-account table, and the dashboard bank-balances widget the moment it is closed. The
rule: **`in_net_worth` governs aggregates, `is_active` governs UI listing**. An explicit
`in_net_worth` in the same PATCH wins (a closed but still-counted tracking account remains
possible by sending `{ is_active: false, in_net_worth: true }`). Reactivating does **not**
auto-restore `in_net_worth` — whether a reopened account should count again is an explicit user
decision (`PATCH { in_net_worth: true }`).

> [!info] Account rename propagates to transactions (2026-06-25)
> When the `name` field is included in the update body, `accountRepository.update()` atomically
> propagates the new name to the denormalized `bank_account` string on all owned rows:
> ```sql
> UPDATE transactions SET bank_account = $newName WHERE account_id = $accountId;
> UPDATE planned_transactions SET bank_account = $newName WHERE account_id = $accountId;
> ```
> This keeps the display label in the bank-balances widget, transaction filters, and the
> dual-write trigger lookup consistent with `accounts.name`. The propagation is part of the same
> database transaction as the accounts row update. See [[docs/adr/088-account-entity|ADR-088 addendum]].

### DELETE /api/accounts/:id

Returns `204 No Content` with an empty body on success. Delete is only possible with zero referencing rows (the `account_id` FKs are
`ON DELETE RESTRICT`): an account that still has transactions, planned transactions, or portfolio
lots returns `409` with a message routing the caller to **close** the account instead (lifecycle
D5: active → closed → only-if-empty deleted). The UI opens `CloseAccountDialog` on that 409.
`404` if not found.

> [!tip] Close-account workflow
> Use `CloseAccountDialog` (wired into `AccountsPage`) to transfer all portfolio lots in-specie to
> another account via `POST /api/investments/:id/move`, then archive with `PATCH /api/accounts/:id`
> `{ is_active: false }`. This is the recommended path for a brokerage account you are closing.

### POST /api/accounts/:id/merge

Merge one or more **source** accounts into this **survivor** (`:id`). Body
`{ source_ids: number[] }`. In one transaction (`accountMergeService`), every reference to a
source is repointed to the survivor — `transactions.account_id` + `bank_account` (set to the
survivor's name so the dual-write trigger keeps it merged), `planned_transactions`, portfolio lots
(`portfolio_transactions_base.account_id`, cascading to child tables, or the flat table), and any
`accounts.funding_account_id` — then the sources are deleted. Returns
`{ into, merged, reassigned: { transactions, planned, portfolio, funding }, stampsInterleaved }`.
`404` if the survivor or any source is missing. Irreversible (the source rows are gone; identity
lives on `account_id`). Used to unify e.g. an old literal `'KBC'` account into its IBAN account
after the ADR-088 adapter change.

**Overlapping-stamp guard (WP-A3, §1 F2):** per-row `balance` stamps are per-source-bank running
balances, so merging two accounts that were both being stamped over the same period interleaves
their stamp histories — the anchor+delta computed balance would then anchor on whichever source's
latest stamp is most recent, silently dropping the other bank's balance. The merge detects
overlapping stamped-date ranges across the original accounts (`stampsInterleaved: true` in the
response) and clears the survivor's now-invalidated `statement_balance` /
`statement_balance_date` anchor (reversible — re-reconcile with a fresh statement). Historical
per-row stamps are never rewritten. Sequential merges (the old account's stamps end before the
new one's begin — the label-dedup use case) are unaffected.

### GET /api/accounts/:id/merge-preview

Read-only dry-run of merging **this** account (`:id`, the source) **into**
`?into=<targetId>` (the survivor). No mutation, no locks. Returns:

```json
{
  "into": 2,
  "source": 1,
  "reassigned": { "transactions": 120, "planned": 2, "portfolio": 0, "funding": 1 },
  "projectedBalance": 1234.5,
  "projectedBalanceCurrency": "EUR",
  "stampsInterleaved": true
}
```

- `reassigned.*` — row counts that WOULD move (the same categories `POST /merge` repoints).
- `projectedBalance` — the post-merge **computed** balance: the anchor+delta definition
  ([[docs/adr/094-balance-reconciliation-drift|ADR-094]]) evaluated **per currency**
  (`computedBalanceByCurrencyAggLateral`, the same builder the accounts hub uses) over the
  **union** of survivor + source active rows as if they were already one account, each currency
  partition then converted at its own current rate into the survivor's native currency
  (`projectedBalanceCurrency`). It therefore equals the `computed_balance` the hub reports for
  the survivor once the merge lands.
- `stampsInterleaved` — the same detection the merge guard uses: would the merge interleave
  stamped balance histories (and therefore clear the survivor's statement anchor)?

`400` if `into` is missing/not a positive integer or equals `:id`; `404` if either account does
not exist. Intended for the merge dialog (WP-B5) to show a confirmation summary and warn before
an interleaving merge.

## UI Behaviors (AccountsPage)

### Account cards — balance display

Each account card in `AccountsPage` (`apps/frontend/src/pages/AccountsPage.tsx`) now shows
`computed_balance` (the account's ledger balance) formatted in the account's native currency when
the field is present in the API response. The balance label carries a `title` tooltip
(i18n key `accounts.balanceTooltip`).

### Drift badge — signed, currency-formatted, dated, age-aware

When `statement_balance` is set and `drift` is non-zero, the drift badge on the account card
displays a signed, currency-formatted amount with the statement's as-of date -- for example
"Drift +€15,50 · statement 03/06/2026". A reading **older than 45 days** renders the badge in
warning (amber) tone rather than destructive, with its own tooltip (i18n key
`accounts.driftStaleTooltip`); a fresh reading keeps the destructive tone and the
`accounts.driftTooltip` tooltip. The label/tone logic is shared (`useDriftBadge`,
`apps/frontend/src/features/accounts/driftBadge.ts`) across the hub cards, the account detail
header, and the dashboard `BankBalancesWidget` chips. See
[[docs/adr/094-balance-reconciliation-drift|ADR-094]] for the drift semantics.

### AddAccountDialog — name-required guard

The Create/Save button in `AddAccountDialog`
(`apps/frontend/src/features/accounts/AddAccountDialog.tsx`) is now `disabled` while the Name
field is blank. Previously submitting with a blank name was a silent no-op; the guard makes the
required-field constraint visible at the button level.

### MergeAccountDialog — type-mismatch note

When the user selects a merge target whose `type` differs from the source account's `type`, an
amber non-blocking note appears in `MergeAccountDialog`
(`apps/frontend/src/features/accounts/MergeAccountDialog.tsx`) using i18n key
`accounts.mergeTypeMismatch` (params: `{sourceType}`, `{targetType}`). The merge is still
allowed -- the note is informational only.

### i18n keys (2026-06-21)

| Key | Purpose |
|-----|---------|
| `accounts.balanceTooltip` | Tooltip on the balance figure in the account card |
| `accounts.driftTooltip` | Tooltip on a fresh drift badge |
| `accounts.mergeTypeMismatch` | Amber note in MergeAccountDialog when target type differs from source |

Later additions (drift badge rework, WP-B1 completion): `accounts.driftBadge` ("Drift {amount}"),
`accounts.driftBadgeStatement` ("statement {date}"), `accounts.driftStaleTooltip` (stale-reading
tooltip); the bare `accounts.drift` key was removed with its last consumer. The Reconcile dialog's
strings live under `accounts.reconcile.*` (fresh-reading input, live preview, backdated warning,
"show transactions since" exit).

## Data model

See [[docs/reference/data-model#Account|Account]] and [[docs/adr/088-account-entity|ADR-088]].
