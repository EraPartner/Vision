---
title: ADR-094 Balance Reconciliation & Drift Detection
type: adr
date: 2026-09-04
tags: [adr, accounts, reconciliation, drift, statement-balance, adr-088, balance-write-protection, import-pipeline-only]
description: Store an authoritative statement balance per account and diff it against the computed ledger balance to surface drift ("drifted €12.40 — missing a transaction"), now that accounts have identity. 2026-06-25 addendum: transactions.balance is now write-protected — only the import pipeline may stamp it.
aliases: [reconciliation, drift detection, statement balance]
---

# ADR-094: Balance Reconciliation & Drift Detection

## Status

Proposed

## Date

2026-06-18

## Context

Imports miss rows, manual entries get fat-fingered, and there was no way to tell: the running
balance was just whatever the transactions summed to. Now that an account has identity
(ADR-088), it can also carry an **authoritative statement balance** the user reads off their
bank, and Vision can flag when its computed balance disagrees.

## Decision

Add to `accounts`:

- `statement_balance NUMERIC(15,2)` — what the bank says.
- `statement_balance_date DATE` — as of when.

**Drift** per account = `statement_balance − computed_balance`, where `computed_balance` is the
`balance` of the account's most recent active transaction (the same figure the bank-balances
widget reports, ADR-010/ADR-088). A non-zero drift means the ledger and the bank disagree — most
often a missing or duplicated transaction since the last import.

- The accounts list/detail expose `computed_balance` and `drift` (computed, not stored); the UI
  shows a drift badge ("drifted €12.40") when `statement_balance` is set and drift ≠ 0.
- `statement_balance` / `statement_balance_date` are editable via the account PATCH (validated:
  numeric balance, ISO date).
- This is descriptive only — it never auto-creates a balancing transaction; it points the user at
  the discrepancy.

## Consequences

**Positive**

- Catches missing/duplicate transactions early, per account, with a concrete euro figure.
- Reuses the existing computed-balance figure (no new balance engine).

**Negative / cost**

- One small migration (two nullable columns); the drift figure is only as useful as the user
  keeping the statement balance current.

**Risks / mitigations**

- _Stale statement balance reads as drift_ → show `statement_balance_date` alongside so the user
  knows how fresh it is; drift only shown when a statement balance exists.
- _Cross-currency accounts_ → drift compares same-currency figures (the account's currency); no FX
  in the diff.

## Related

- [[docs/adr/index|All ADRs]]
- [[docs/adr/088-account-entity|ADR-088: Account Entity]]
- [[docs/adr/010-phase1-aggregation-strategy|ADR-010]] (computed balance source)

---

## Addendum (2026-08-31): declared-currency reconciliation base

The original single-currency definition above is retained as historical context. Accounts now
compute one native balance partition per currency. The single `statement_balance` remains
denominated in `accounts.currency`, so reconciliation resolves a native `reconcilable_balance`
instead of the FX-converted reporting `computed_balance`.

Resolution is deterministic:

1. When a partition in `accounts.currency` exists, it wins even when its balance is exactly zero.
   A zero declared-currency balance can mean the account was spent down; it must not silently turn
   a statement into a claim about another currency.
2. Only when the declared-currency partition is absent are zero and sub-cent fallback partitions
   removed. One remaining funded foreign partition is accepted as the compatibility case for a
   mislabelled single-currency account.
3. Otherwise the base is zero in `accounts.currency`.

An adjustment transaction is stamped in the selected base currency. Other currency partitions are
left untouched. This preserves the invariant that the displayed drift is the exact amount the
reconcile endpoint resolves.

---

## Addendum (2026-06-25): `transactions.balance` is now write-protected

### Context

A data-integrity audit identified that hand-typed `balance` values on manual transaction rows
were silently poisoning per-account totals. The computed balance for an account is the `balance`
of that account's **most-recent active transaction** (the same figure the bank-balances widget
reports). If a user could PATCH or manually-create a row with an arbitrary `balance` stamp, that
value became the authoritative anchor for the entire account — the real cause of a "€18 instead
of €0" discrepancy that triggered the audit.

### Decision

`transactions.balance` is now **written exclusively by the CSV import pipeline**
(`services/importPipeline/commit.js`). All other write paths leave it `NULL` or ignore it.

Specific enforcement:

| Layer                                                        | Change                                                                                                                              |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| `middleware/validation.js`                                   | `'balance'` removed from `ALLOWED_COLUMNS.transactions`; `PATCH /api/transactions/:id` now rejects any body that contains `balance` |
| `routes/transactions.js` (create)                            | Create route no longer forwards `balance` to the repository                                                                         |
| `repositories/transactionRepository.js`                      | `create()` no longer accepts or inserts `balance`; manually-created rows leave it `NULL`                                            |
| `features/transactions/types.ts`                             | `'balance'` removed from `InfoEditableField` union; the type system enforces the read-only surface at compile time                  |
| `features/transactions/components/TransactionInfoDialog.tsx` | Balance field rendered as read-only display; the pencil/edit affordance for this field is removed                                   |
| `pages/TransactionsPage.tsx`                                 | All callers of the info dialog updated to reflect the removed editable field                                                        |

### Consequences

**Positive**

- The account computed-balance anchor is now tamper-proof from the UI and the API.
- The source of truth for `balance` is unambiguous: it is the running balance stamped by the
  import pipeline; `NULL` on manual rows is intentional and correct.
- The `statement_balance` / drift workflow (ADR-094 main body) now reliably surfaces real
  discrepancies rather than user-introduced noise.

**Negative / cost**

- Power users who previously relied on PATCH to set `balance` (e.g., for seeding an opening
  balance) can no longer do so via the API. The correct workflow is to import a statement that
  carries the balance column, or to rely on the drift badge to quantify the discrepancy.

> [!warning] Existing rows with non-NULL balance
> Rows already imported from bank CSVs keep their `balance` values — they are unaffected.
> The change only prevents new manual writes. The `include_balance=true` export flag and the
> running-balance accumulator in the CSV export remain unchanged.

**Related code:** [[apps/node-backend/src/middleware/validation.js]],
[[apps/node-backend/src/routes/transactions.js]],
[[apps/node-backend/src/repositories/transactionRepository.js]],
[[apps/frontend/src/features/transactions/components/TransactionInfoDialog.tsx]],
[[apps/frontend/src/features/transactions/types.ts]]

---

## Addendum (2026-07-10): Guarded opening-balance anchor for manual accounts

### Context

The 2026-06-25 addendum made `transactions.balance` import-pipeline-only, and its stated cost
was real: there is now **no path to seed an opening balance**. A manual/cash-only account (a
wallet, an account whose bank has no CSV export) can never anchor — its computed balance is
Σ(amounts) from an implicit zero forever, and the drift badge compares the statement figure
against that unanchored sum. The 2026-07-09 plan review filed this as a gap; **decision
2026-07-10 (D4): a guarded, server-side anchor action** — not a relaxation of the write
protection, and not an ordinary "opening deposit" transaction (which would pollute income
statistics and still not stamp an anchor).

### Decision

A dedicated action, e.g. `POST /api/accounts/:id/opening-balance` with
`{ balance, date, currency? }`, creates **one system anchor row** in `transactions`,
server-side:

| Field                             | Value                                                                                                                                                                                                      |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `amount`                          | `0` — the row moves no money                                                                                                                                                                               |
| `balance`                         | the stated opening balance (stamped by the server, the one non-import writer)                                                                                                                              |
| `date`                            | user-chosen; expected to precede the account's activity (warn when it doesn't — by anchor+delta semantics a _later_ stamped row always wins, so a mid-history anchor is inert against newer import stamps) |
| `is_transfer` / `transfer_source` | `true` / `'opening'` — a new CHECK value following ADR-090's `'trade'` precedent, so the row is excluded from spending aggregations and from transfer reconciliation                                       |
| `memo`                            | `'OPENING BALANCE'` — a fixed English server-side constant (`OPENING_MEMO`), stamped by the service, not i18n'd                                                                                            |
| `recipient_id`                    | the inactive reserved `SYSTEM` recipient, resolved server-side; public recipient creation cannot create, adopt, or reactivate this identity                                                                |

One anchor per `(account, currency)`; invoking the action again **updates** the existing row
rather than adding a second. The generic `POST /api/transactions` / `PATCH` surface remains
balance-free — the 2026-06-25 write protection is untouched; this endpoint is the single,
auditable exception, and the UI exposes it as "Set opening balance" in the account
detail/reconcile flow (rewrite Phase C/D).

### Consequences

**Positive**

- Manual accounts finally anchor; their computed balance and drift become meaningful.
- The tamper-protection stays intact — users still never free-type `balance` on a row.
- Replaces the awkward documented workaround ("import a statement that carries a balance
  column") for accounts that will never have one.

**Negative / cost**

- A new `transfer_source` CHECK value (small revision; rollback removes the value after deleting
  any `'opening'` rows).
- The planned zero-amount-transaction rejection (filed elsewhere in TODO.md) must exempt
  `transfer_source = 'opening'` rows — they are legitimately zero-amount.
- Deleting the anchor row must be guarded the same way (only via the action / with a clear
  warning), or the account silently de-anchors.

The opening-balance and reconcile services lock the account before resolving the `SYSTEM`
recipient. Recipient-owned flows do not acquire an account lock after a recipient lock. This
account-to-recipient order is the only permitted cross-table lock edge for these system rows.
