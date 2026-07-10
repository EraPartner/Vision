---
title: ADR-089 Account-Typed Model & Owner Dimension
type: adr
date: 2026-06-18
tags: [adr, accounts, account-type, liquidity, in-net-worth, tax-wrapper, owner, marital-quotient, adr-088]
description: Activate the orthogonal account flag columns (type, liquidity class, spendable, in-net-worth, tax wrapper, owner, multi-currency cash, cash sleeve) shipped in ADR-088 as meaningful attributes, and introduce the me/partner/joint owner dimension that feeds Belgian marital tax allocation.
aliases: [account types, account flags, owner dimension, liquidity class, in net worth]
---

# ADR-089: Account-Typed Model & Owner Dimension

## Status
Proposed

## Date
2026-06-18

## Context

ADR-088 created the `accounts` table with a set of flag columns but left their *semantics*
dormant (every backfilled account got safe defaults: `type='checking'`, `in_net_worth=true`,
`has_cash_sleeve=true`, `owner='me'`). Real accounts are not all the same: a brokerage account
holds cash *and* holdings; a pensioensparen account is locked, tax-deductible and illiquid; a
crypto wallet holds only holdings (no cash sleeve); a mortgage is a negative, illiquid liability.
A single boolean ("is it a bank account?") cannot express these — but a **small set of orthogonal
flags** can, without a subtype explosion.

The flags must also be *meaningful*, not decorative: net worth should be able to exclude a
"tracking-only" account; downstream features (FIRE coverage, cash-aware rebalancing) need to know
which balances are liquid and spendable; the cash sleeve (ADR-090) needs `has_cash_sleeve`; and
the Belgian marital quotient needs to know whether an account's income/gains belong to *me*, a
*partner*, or *jointly*.

## Decision

Treat the ADR-088 flag columns as **orthogonal attributes of one entity** (same table, different
flag combinations) and activate them:

- **`type`** (`checking`/`savings`/`brokerage`/`crypto_exchange`/`wallet`/`pension`/`liability`)
  — a descriptive label that drives default flag suggestions and icons; it does **not** branch
  the schema.
- **`liquidity_class`** (`liquid`/`semi_liquid`/`illiquid`) — feeds "available cash" and FIRE /
  rebalancing math (later milestones). Descriptive now.
- **`spendable`** — distinguishes spendable cash from earmarked balances.
- **`in_net_worth`** — when false, the account is excluded from net-worth roll-ups (a
  tracking-only or external account). **Activated now** at the net-worth bank-side aggregation;
  fully honored when net worth becomes Σ-accounts (ADR-093).
- **`tax_wrapper`** (`none`/`pension`/`tax_advantaged`) — marks tax-advantaged shells
  (pensioensparen); consumed by the tax surfaces (ADR-096 / unified tax view).
- **`owner`** (`me`/`partner`/`joint`) — the **owner dimension**. Income and realized gains on an
  account are attributed to its owner; a `joint` account splits **50/50**. This is the input the
  Belgian **marital quotient** needs. The attribution rule lives here; the actual tax-report
  consumption lands in the unified tax view (ADR-096 / M10). Default `me`, so single-filer users
  see no change.
- **`multi_currency_cash`** / **`has_cash_sleeve`** — cash-sleeve inputs consumed by ADR-090
  (a `wallet` sets `has_cash_sleeve=false`).

**UI:** the account editor exposes the flags with progressive disclosure — identity (name,
institution, currency, type) up front; the orthogonal flags in an "Advanced" group with sensible
defaults so the common case stays one-line. Selecting a `type` pre-suggests matching flags
(e.g. `liability` → `in_net_worth=true, spendable=false, has_cash_sleeve=false`; `wallet` →
`has_cash_sleeve=false`).

**Stress-test combinations that must all be expressible:**

| Account | type | liquidity | spendable | in_net_worth | tax_wrapper | has_cash_sleeve |
|---|---|---|---|---|---|---|
| Checking | checking | liquid | true | true | none | true |
| Brokerage | brokerage | semi_liquid | false | true | none | true |
| Pensioensparen | pension | illiquid | false | true | pension | false |
| Crypto wallet | wallet | semi_liquid | false | true | none | **false** |
| Mortgage | liability | illiquid | false | true | none | false |

No migration is required — the columns and enum types already exist (migration 0050). This ADR
activates behavior and UI only.

## Consequences

**Positive**
- One entity expresses every account shape via flag combinations; no subtype table explosion.
- `in_net_worth` immediately lets users keep tracking-only accounts out of net worth.
- The owner dimension is captured now, unblocking marital-quotient tax allocation later without
  another migration.

**Negative / cost**
- More controls in the account editor (mitigated by progressive disclosure + type-driven
  defaults).
- Flags are only as correct as the user sets them; type-driven suggestions reduce the burden.

**Risks / mitigations**
- Over-exposing rarely-changed flags → hide behind "Advanced"; default from `type`.
- Partial activation (some flags descriptive until later milestones) → documented per-flag above
  so consumers know what is live.

## Related
- [[docs/adr/index|All ADRs]]
- [[docs/adr/088-account-entity|ADR-088: Account Entity]] (ships the columns)
- [[docs/reference/data-model|Data Model Reference]] (Account entity)
- [[docs/adr/064-net-worth-current-value-live-overlay|ADR-064: Net Worth]] (in_net_worth consumer; superseded composition in ADR-093)

---

## Addendum (2026-07-10): `multi_currency_cash` becomes real — per-currency balances within one account

### Context

`multi_currency_cash` shipped in ADR-088 as a dormant flag with no consumer. Meanwhile every
balance path silently assumes one currency per account, and the assumption is already violated:
the Revolut adapter books EUR and USD rows into one `bank_account` (filed finding — "Revolut
collapses multi-currency accounts"), the anchor+delta computed balance and `mv_bank_balances`
sum across currencies, and trade cash legs post in the trade's native currency into a
currency-blind `SUM` (filed finding — FX-blind sleeve balances). The plan review offered two
exits: enforce one-currency-per-account as an invariant (split multi-currency banks into one
account per currency, the Wise pattern), or implement the flag. **Decision 2026-07-10:
implement it** (D2) — one real-world account stays one `accounts` row.

### Decision

An account's cash becomes a set of **per-currency balance series keyed `(account_id,
currency)`**:

- **Balance computation** — the anchor+delta lateral partitions by `currency`; each currency
  anchors and accumulates independently. Single-currency accounts degenerate to today's
  behavior unchanged.
- **Consumers** — `getBankBalances`, the accounts hub, net worth, and `mv_bank_balances` all
  move to `(account_id, currency)` grain (the MV re-grain also satisfies the ADR-088 contract
  runbook precondition). Display sums convert per currency to the app display currency at read
  time using the existing FX machinery (ADR-074/085 precedent).
- **Statement balance / drift** — the single `statement_balance` + `statement_balance_date`
  column pair cannot represent a multi-currency statement; they move to a side table
  `account_statement_balances (account_id, currency, balance, balance_date)` with a backfill
  from the existing columns. Drift is computed per currency, which also retires ADR-094's
  "same-currency diff only" limitation.
- **Trade cash legs** — keep posting in the trade's native currency; the per-currency
  partitioning plus read-time conversion fixes the filed FX-blind sleeve-sum bug without
  touching the write path.
- **Adapters** — Revolut keeps **one** account with `multi_currency_cash = true`; each row keeps
  its currency (this replaces the filed fix of minting `REVOLUT <CURRENCY>` accounts). Wise's
  existing one-account-per-currency split remains valid — both models are allowed; the invariant
  is that a row's currency is always honored, never collapsed into another currency's series.
- **`accounts.currency`** is reinterpreted as the account's *primary/reporting* currency (the
  default for rows that don't specify one, and the only currency for single-currency accounts) —
  no longer an assumed invariant on the rows.

### Consequences

**Positive**
- One real-world account = one `accounts` row, matching how Revolut/Wise present themselves.
- The two filed currency bugs (Revolut collapse, FX-blind sleeve sums) are fixed structurally
  rather than patched.
- Per-currency drift makes reconciliation meaningful for multi-currency users.

**Negative / cost**
- This touches every balance consumer — it is deliberately sequenced inside the accounts
  rewrite's balance-engine phase (Phase C in TODO.md), **not** shippable piecemeal.
- A new side table + backfill migration (rollback: copy the primary-currency row back into the
  scalar columns and drop the table).
- Frontend surfaces that show "the" account balance need a per-currency presentation for
  multi-currency accounts (stacked rows or a primary-currency headline with a breakdown).

**Superseded within this ADR:** the main body's note that `multi_currency_cash` is merely a
"cash-sleeve input" — it is now an activated, behavior-bearing flag.
