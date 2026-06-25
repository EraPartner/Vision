---
title: ADR-088 Account Entity (replace the bank_account string)
type: adr
date: 2026-06-18
tags: [adr, accounts, account-entity, data-model, migration, expand-contract, running-balance, transfers, import, net-worth, portfolio, trigger-lookup-only, phantom-account, split-guard, rename-propagation, migration-0062]
description: Replace the implicit free-text bank_account column with a real accounts table via an expand/contract migration, giving accounts a stable identity that cash, holdings, liabilities, reconciliation, and owner/tax allocation can all hang off. 2026-06-25 addendum: migration 0062 hardens the dual-write trigger (lookup-only on UPDATE), adds a split-total guard trigger, and wires account rename propagation.
aliases: [account entity, accounts table, account_id, bank_account replacement]
---

# ADR-088: Account Entity (replace the `bank_account` string)

## Status
Proposed

## Date
2026-06-18

## Context

Vision has **no account entity**. An account is an ad-hoc free-text string: `bank_account TEXT`
on both `transactions` and `planned_transactions`. That string is load-bearing in ways a string
should not be:

- The **running-balance ledger** is a window function `SUM(amount) OVER (PARTITION BY
  bank_account …)` in `transactionRepository.js` — the partition key *is* the account.
- **Bank balances + 12-month history** (`infoRepositoryBanks.getBankBalances`) group by the
  string with `DISTINCT ON (bank_account)` and a per-account LATERAL probe.
- **Transfer detection** (ADR-083) requires two legs on `bank_account IS DISTINCT FROM` each
  other.
- **Import** copies the adapter's parsed `bankAccount` onto each row verbatim, with no
  normalization — so "KBC", "KBC ", and a re-typed IBAN are three different "accounts".
- **Statistics, filters, and materialized views** group/filter on the same string.

Because the identifier is a string, there is no place to attach anything an account *is*: a type
(checking vs brokerage vs mortgage), a balance you can reconcile against, holdings, an owner, or
a liability sign. Three workspaces (Budgeting · Portfolio · Research) each grew their own notion
of "where money lives" — bank balances on the budgeting side, a single global portfolio on the
other — with nothing tying them together. Investments and `portfolio_transactions` have **no
account FK at all** (holdings are global).

This ADR introduces the missing entity. It is the **foundation** for a cross-workspace epic
(see the M-series ADRs 089–096): a typed account model + owner dimension (089), a cash sleeve
and trades-as-transfers (090), per-account positions/lots (091), liabilities as negative
accounts (092), net worth as a sum over accounts (093), balance reconciliation (094), brokerage
import (095), and portfolio income statistics (096). None of those are possible while an account
is just a string.

This is distinct from `recipient_bank_accounts` (counterparty IBANs, ADR-015 / ADR-087): those
describe *who you paid*, not *where your money is*. The new `accounts` entity is the user's own
accounts.

## Decision

Create a first-class `accounts` table and migrate the `bank_account` string onto a real
`account_id` foreign key using a safe **expand → dual-write → flip-reads → contract** sequence.

### Data model

Create `accounts` with its identity columns **plus the orthogonal flag columns** up front (their
*semantics* are activated in ADR-089, but shipping the columns now avoids a second table
rewrite):

- Identity: `id`, `name`, `display_name`, `institution`, `currency`, `is_active`,
  `created_at`, `updated_at`.
- Flags (defaults in parentheses): `type` (`'checking'`), `liquidity_class`, `spendable`
  (`true`), `in_net_worth` (`true`), `tax_wrapper`, `owner` (`'me'`), `multi_currency_cash`
  (`false`), `has_cash_sleeve` (`true`), `funding_account_id` (nullable self-FK, `ON DELETE
  SET NULL`).
- `currency` follows the ADR-086 convention: `NOT NULL DEFAULT 'EUR'` + ISO `^[A-Z]{3}$` CHECK.

Add a nullable `account_id` to `transactions` and `planned_transactions`, **`ON DELETE
RESTRICT`** — an account that still owns transactions cannot be deleted (consistent with the
history-protecting FK policy in ADR-087; account removal is the "close/archive" workflow in
ADR-091, not a hard delete).

### Migration — expand/contract

1. **Expand:** create `accounts`; add the nullable `account_id` FKs. (Migration `0050`, chained
   off the sibling `0049_validate_currency_checks` to keep a single linear head.)
2. **Backfill:** one `accounts` row per distinct non-null `bank_account` string (trimmed), and
   set `account_id` on existing rows by matching the string.
3. **Dual-write:** writers (import commit, transaction/planned create+update) populate **both**
   the string and the FK, resolving-or-creating the account by name.
4. **Flip reads:** repoint every read site from the string to `account_id`:
   `transactionRepository` running-balance partition, `infoRepositoryBanks.getBankBalances`,
   `transferReconciliationService` candidate matching (`account_id IS DISTINCT FROM`),
   `filterBuilder` (filter by id), `materializedViewService` + `infoRepositoryStatistics`
   groupings.
5. **Contract:** after a dual-write **soak** confirms parity, drop the `bank_account` string in a
   later migration. Each step ships a rollback.

### API & UI

- New CRUD surface `GET/POST/PATCH/DELETE /api/accounts` (added to `openapi.yaml` and the
  CI-enforced `docs/reference/api-endpoint-matrix.md`).
- A **workspace-agnostic top-level "Accounts" hub** (sibling to AI Chat, above the workspace
  switcher) is the one canonical place to manage accounts and see each account's cash + holdings
  + debt + reconciliation. Per-account detail and CRUD mirror the existing
  Categories/Recipients patterns. The free-text bank field in the transaction editor and the
  import column mapper become an **account combobox with "create new."**

## Consequences

**Positive**
- Accounts gain a stable identity, so everything downstream in the epic (type/owner, cash
  sleeve, per-account lots, liabilities, net worth, reconciliation, brokerage import) has
  something real to attach to. The three workspaces share one spine.
- Normalization at write time ends the "KBC" vs "KBC " duplicate-account problem.
- `ON DELETE RESTRICT` protects history; the deliberate "close account" flow replaces accidental
  data loss.

**Negative / cost**
- **High blast radius.** The string is read in the running-balance ledger, bank balances,
  transfers, import, statistics, filters, and the MVs — every site must flip together or pages
  will disagree.
- A multi-phase migration with a dual-write soak before the irreversible drop-string step.
- A new API surface + a new top-level UI area + i18n strings (en/nl).

**Risks / mitigations**
- *Drop-string is irreversible* → gate it behind a dual-write soak and parity checks
  (running-balance and `getBankBalances` must be byte-identical pre/post flip on a seeded DB)
  before contracting.
- *Backfill mis-grouping* (whitespace/case) → trim+normalize when creating the backfilled rows;
  the user can merge accounts afterward via the hub.
- *Migrations are not auto-run* → ship the revision + rollback and let the user apply
  (per project convention).

## Related
- [[docs/adr/index|All ADRs]]
- [[docs/reference/data-model|Data Model Reference]]
- [[docs/adr/010-phase1-aggregation-strategy|ADR-010: Aggregation Strategy]] (MV/agg sites move to `account_id`)
- [[docs/adr/083-internal-transfer-detection|ADR-083: Internal Transfer Detection]] (legs must be different accounts)
- [[docs/adr/086-currency-integrity|ADR-086: Currency Integrity]] (currency NOT NULL + ISO CHECK)
- [[docs/adr/087-db-constraint-hardening|ADR-087: DB Constraint Hardening]] (history-protecting FKs stay RESTRICT)
- [[docs/reference/api-endpoint-matrix|API Endpoint Matrix]]

---

## Addendum (2026-06-25): Migration 0062 — trigger hardening, split guard, rename propagation

### Context

Three latent bugs discovered during a data-integrity audit of the ADR-088 dual-write phase:

1. **Phantom accounts on UPDATE.** The dual-write trigger `sync_account_id_from_bank_account()`
   ran `INSERT INTO accounts … ON CONFLICT DO NOTHING` on both INSERT and UPDATE. Editing a row's
   `bank_account` to a stale, typo, or renamed label via the DB editor, the transaction info
   dialog's bank field, or any other writer therefore silently created a brand-new account row.
   This is how historical institution-name labels (`'KBC'`, `'BELFIUS'`) could resurrect as
   stray accounts on the next edit, poisoning the accounts hub and net worth totals.

2. **Split total could exceed parent amount.** `splitRepository.createSplitAtomic` validates that
   a new split's amount does not exceed `ABS(transaction.amount)` at creation time. But editing
   the parent transaction's `amount` downward (via `PATCH /api/transactions/:id` or the DB data
   editor introduced by ADR-101) was not guarded — the splits could silently exceed the parent
   amount, with no constraint to catch it.

3. **Account rename did not propagate to the denormalized string.** `accountRepository.update()`
   patched `accounts.name` but left `transactions.bank_account` and
   `planned_transactions.bank_account` pointing to the old name. Because the dual-write trigger
   reads the `bank_account` string to resolve `account_id` (on INSERT) and the bank-balances
   widget uses the string for display labels, the mismatch caused the renamed account to appear
   as if it had reverted to the old name.

### Decision

#### Migration 0062 — `0062_trigger_lookup_only_on_update.py` (authored 2026-06-25)

**a) `sync_account_id_from_bank_account()` is now LOOKUP-ONLY on UPDATE**

The function is replaced in place with `CREATE OR REPLACE`:

| `TG_OP` | Behaviour |
|---------|-----------|
| `INSERT` | Unchanged: `INSERT INTO accounts ON CONFLICT DO NOTHING`, then resolve `account_id`. Import pipeline relies on this for first-seen accounts. |
| `UPDATE` | Lookup-only: `SELECT id FROM accounts WHERE name = acct_name`. If a match exists, set `NEW.account_id`; if not, leave `account_id` unchanged. **Never creates.** |

The two trigger bindings on `transactions` and `planned_transactions` require no change — the
trigger function replacement takes effect immediately via `CREATE OR REPLACE`.

> [!info] Down-revision is `0061_investments_show_in_ticker`
> Migration 0062 chains directly after 0061. Downgrade restores the prior resolve-or-create-on-update
> function verbatim and drops the split-guard trigger and function.

**b) New `trg_enforce_split_within_amount` BEFORE UPDATE trigger on `transactions`**

```sql
CREATE TRIGGER trg_enforce_split_within_amount
    BEFORE UPDATE ON transactions
    FOR EACH ROW EXECUTE FUNCTION enforce_split_within_amount();
```

`enforce_split_within_amount()` fires only when `NEW.amount IS DISTINCT FROM OLD.amount`. It
sums `transaction_splits.amount` for the parent row and raises a `check_violation` if the sum
exceeds `ABS(NEW.amount) + 0.005` (0.5 cent tolerance for rounding). This makes the constraint
database-level — it covers `PATCH /api/transactions/:id`, the DB data editor (ADR-101), and any
direct SQL.

**c) `accountRepository.update()` propagates account renames**

When `name` appears in the update body, `accountRepository.update()` now atomically updates the
denormalized string on all owned rows in a single transaction:

```sql
UPDATE transactions SET bank_account = $newName WHERE account_id = $accountId;
UPDATE planned_transactions SET bank_account = $newName WHERE account_id = $accountId;
```

This keeps `accounts.name`, `transactions.bank_account`, and `planned_transactions.bank_account`
in sync so that the dual-write trigger (which uses the string for INSERT resolution) and any
string-based display code always see the current label.

**Related code:** [[alembic/versions/0062_trigger_lookup_only_on_update.py]],
[[apps/node-backend/src/repositories/accountRepository.js]]

### Consequences

**Positive**
- Stale or mistyped `bank_account` edits can no longer spawn phantom accounts.
- Splitting a transaction and then shrinking its `amount` below the split total is now caught at
  the DB level, not silently accepted.
- Renaming an account propagates atomically to all owned transaction strings — the accounts hub,
  bank-balances widget, and any string-based filter show the new name immediately.

**Negative / cost**
- Existing phantom accounts already created by the pre-0062 trigger are not auto-cleaned; users
  may need to merge them via `POST /api/accounts/:id/merge` (see [[docs/api/accounts|Accounts API]]).
- The rename propagation updates every `bank_account` string on all owned transactions in one
  query — on large accounts this is a brief write-amplification on the `PATCH /api/accounts/:id`
  path. Still atomic and bounded.
