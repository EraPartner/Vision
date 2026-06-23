---
title: ADR-090 Cash Sleeve & Trades = Transfers
type: adr
date: 2026-06-18
tags: [adr, accounts, cash-sleeve, trades, transfers, portfolio, double-counting, adr-083, adr-088, adr-091]
description: Model a brokerage/exchange account's cash as its transactions-ledger balance (single source of truth), and model buy/sell/dividend/fee as auto-created, transfer-excluded cash legs linked to the trade — reusing the ADR-083 exclusion without colliding with its reconciler.
aliases: [cash sleeve, trades as transfers, trade cash leg, single source of truth cash]
---

# ADR-090: Cash Sleeve & Trades = Transfers

## Status
Proposed

## Date
2026-06-18

## Context

A brokerage / crypto-exchange account holds spendable or idle **cash** alongside holdings. Today
there is no honest way to represent that: users either ignore the cash, or double-count it (once
as a bank-ish balance and again as a "savings" investment), so net worth and "liquid" are wrong.
When holdings change (a buy), the cash should fall by the same amount — nothing enforces that.

ADR-088 gave accounts identity and a `has_cash_sleeve` flag; ADR-091 gave trades an `account_id`.
This ADR makes the cash side real and keeps it in lockstep with trades.

## Decision

**Single source of truth per sleeve:** an account's cash is its **transactions-ledger balance**
(the running balance of its `account_id` rows). It is never also modelled as an investment. A
`has_cash_sleeve=false` account (e.g. a self-custody wallet) holds no cash and has no sleeve.

**Trades create a paired cash leg.** Recording a portfolio transaction auto-creates a matching
`transactions` row — the **cash leg** — when a cash account is designated:

| Trade type | Cash leg | Sign |
|---|---|---|
| buy | cash → holding | `−(amount + fees + taxes)` (out of sleeve, excluded from spending) |
| sell | holding → cash | `+(amount − fees − taxes)` (into sleeve, excluded from income) |
| dividend / interest / rent_income | income into sleeve | `+amount` |
| fee / tax | spending out of sleeve | `−amount` |

- **Which account the cash leg lands on:** for a sleeve account, the cash leg defaults to that
  account's own sleeve (`cash_account_id = trade.account_id`). For a **sleeve-less** account
  (wallet), the cash genuinely left somewhere else, so the user **designates a funding account at
  entry time** (prompt each time — no stored default) and the leg posts there. A holdings-only
  tracker that doesn't model cash can omit the cash account → no leg.

**Schema:**
- `transactions.portfolio_transaction_id` → FK to `portfolio_transactions(id)` `ON DELETE
  CASCADE` (deleting a trade removes its cash leg).
- Extend `ck_transactions_transfer_source` to allow a **new `transfer_source = 'trade'`**.

**Reuse ADR-083's exclusion without colliding with its reconciler.** The cash leg is marked
`is_transfer = true` so the cross-cutting `AND NOT is_transfer` predicate keeps it out of
income/spending aggregates *for free*. It is marked `transfer_source = 'trade'` (not `'auto'`) and
linked via `portfolio_transaction_id` (not `transfer_peer_id`). The ADR-083 reconciler only ever
touches rows where `transfer_source IS NULL` (candidate matching) or `transfer_source = 'auto'`
(orphan/invalid release), so it **never** releases, re-pairs, or mis-handles a `'trade'` leg —
which matters because a trade cash leg is **single-sided** (a buy has no equal-and-opposite cash
inflow) and would otherwise be wrongly released as an orphan. No reconciler code change is needed;
the distinct `transfer_source` value isolates it.

**Net worth counts each value once:** the sleeve cash from the ledger (bank side) + the holdings
at market (portfolio side). A buy moves value cash→holding with no net change; net worth doesn't
double-count.

## Consequences

**Positive**
- Brokerage cash is honest and self-correcting: a buy debits the sleeve by exactly the cost.
- Reuses the ADR-083 exclusion predicate; no new "exclude trade legs" rule to thread everywhere.
- Required for the brokerage importer (ADR-095) to balance cash vs trades.

**Negative / cost**
- A new write side-effect (create the linked cash leg) on portfolio-transaction create/delete; a
  data-integrity-critical path that must be transactional and idempotent.
- Sleeve-less trades need a funding-account choice (extra entry step, by design).

**Risks / mitigations**
- *Double-counting* (the flagged danger): the cash leg is `is_transfer=true` → excluded from
  income/spending; net worth counts cash and holdings on separate sides. Verify with a balance
  test (record a buy → sleeve cash falls by cost, holdings rise by cost, net worth unchanged).
- *Reconciler collision*: isolated by `transfer_source='trade'` (see above); add a regression test
  that a single-sided `'trade'` leg survives `reconcileTransfers`.
- *Orphaned legs*: `ON DELETE CASCADE` removes the cash leg when the trade is deleted.

## Related
- [[docs/adr/index|All ADRs]]
- [[docs/adr/083-internal-transfer-detection|ADR-083: Internal Transfers]] (exclusion predicate + reconciler isolation)
- [[docs/adr/088-account-entity|ADR-088: Account Entity]] (has_cash_sleeve)
- [[docs/adr/091-per-account-positioning|ADR-091: Per-Account Positioning]] (trade account_id)
- [[docs/adr/095-brokerage-account-import|ADR-095: Brokerage Import]] (depends on this)
