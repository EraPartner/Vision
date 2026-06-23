---
title: ADR-088 Account Entity (replace the bank_account string)
type: adr
date: 2026-06-18
tags: [adr, accounts, account-entity, data-model, migration, expand-contract, running-balance, transfers, import, net-worth, portfolio]
description: Replace the implicit free-text bank_account column with a real accounts table via an expand/contract migration, giving accounts a stable identity that cash, holdings, liabilities, reconciliation, and owner/tax allocation can all hang off.
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
