---
title: ADR-094 Balance Reconciliation & Drift Detection
type: adr
date: 2026-06-18
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
- *Stale statement balance reads as drift* → show `statement_balance_date` alongside so the user
  knows how fresh it is; drift only shown when a statement balance exists.
- *Cross-currency accounts* → drift compares same-currency figures (the account's currency); no FX
  in the diff.

## Related
- [[docs/adr/index|All ADRs]]
- [[docs/adr/088-account-entity|ADR-088: Account Entity]]
- [[docs/adr/010-phase1-aggregation-strategy|ADR-010]] (computed balance source)

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

| Layer | Change |
|-------|--------|
| `middleware/validation.js` | `'balance'` removed from `ALLOWED_COLUMNS.transactions`; `PATCH /api/transactions/:id` now rejects any body that contains `balance` |
| `routes/transactions.js` (create) | Create route no longer forwards `balance` to the repository |
| `repositories/transactionRepository.js` | `create()` no longer accepts or inserts `balance`; manually-created rows leave it `NULL` |
| `features/transactions/types.ts` | `'balance'` removed from `InfoEditableField` union; the type system enforces the read-only surface at compile time |
| `features/transactions/components/TransactionInfoDialog.tsx` | Balance field rendered as read-only display; the pencil/edit affordance for this field is removed |
| `pages/TransactionsPage.tsx` | All callers of the info dialog updated to reflect the removed editable field |

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
