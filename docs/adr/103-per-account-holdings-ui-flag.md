---
title: ADR-103 Gate per-account holdings UI behind a flag (default off)
type: adr
status: accepted
date: 2026-06-20
tags: [adr, accounts, portfolio, holdings, feature-flag, ux, adr-088, adr-090, adr-091, adr-095, adr-100, adr-030]
description: Hide the per-account portfolio HOLDINGS surface (trade account pickers, move/close-holdings, per-account net-worth breakdown, brokerage import routing) behind a default-off frontend flag, keeping the budgeting/cash account features fully on. A reversible scope-down of the UI scope of ADR-091/100, not a data-model change.
aliases: [per-account holdings flag, holdings ui off, accounts scope down]
---

# ADR-103: Gate per-account holdings UI behind a flag (default off)

## Status
Accepted — 2026-06-20.

## Context

The account entity (ADR-088) deliberately spans two concerns: **budgeting cash** (the
transactions ledger, per-account balances, `bank_account` dual-write, liabilities,
reconciliation) and **portfolio holdings**. The holdings layer — ADR-090 (cash sleeve & trade
cash legs), ADR-091 (`account_id` on lots / per-account cost basis), ADR-095 (brokerage import
routing), ADR-100 (account-native net-worth holdings + by-account chart) — adds substantial UX
and cost-basis complexity: account pickers on every trade dialog, in-specie move and
close-account flows, a per-account net-worth breakdown, and per-row brokerage import routing.

For this deployment that complexity has **no consumer**: there is no per-account rebalancing,
per-custodian tax-lot selling, or liquidity planning that needs a per-account holdings split.
Meanwhile the surface adds clutter and carries known rough edges (e.g. sell-units validation is
investment-wide, not account-scoped — harmless only while lots stay global). The **budgeting**
side is valuable and stays. Portfolio lots are already global (`account_id = NULL`, ADR-091's
no-backfill default), so net worth is already correct as cash-per-account + a single holdings
aggregate.

## Decision

Introduce a frontend feature flag `VITE_ENABLE_PER_ACCOUNT_HOLDINGS` via the ADR-030 env-schema
(`apps/frontend/src/lib/env.ts`), **default `false`**, exported as `isPerAccountHoldingsEnabled`.
When off, hide the per-account **holdings** UI:

- account pickers on `AddPortfolioTxnDialog` / `EditPortfolioTxnDialog` (new trades stay global,
  no `account_id` / `cash_account_id` → no cash leg);
- the "Move Holdings" button + `MoveHoldingDialog`, and the per-investment per-account breakdown
  card in `InvestmentDetailDialog`;
- the per-account **holdings** breakdown grid + `NetWorthByAccountChart` on the net-worth page;
- the brokerage toggle + sleeve-account picker on the portfolio import pages.

The close-account flow keeps its **cash-account archive** path; only its holdings-transfer block
is gated. Budgeting/cash account features are untouched: `AccountsPage` CRUD, the bank-balances
widget (per-account cash), the `bank_account` field on transaction forms, liabilities, and
statement-balance reconciliation.

Net worth stays correct: per-account cash + holdings as one global aggregate. **The backend is
unchanged** — `byAccount` in `getPortfolioSummary`, `/api/investments/:id/move`, the by-account
net-worth endpoint, and `createTradeCashLeg` remain but go dormant (trades created without
`account_id` already skip cash-leg creation).

This is a **reversible scope-down of the UI scope** of ADR-091/ADR-100, not a removal of their
data model. Flip the flag default to `true` (or set the env var) to restore the surface.

## Consequences

**Positive**
- Simpler portfolio UX; the complex/rough holdings-per-account surface is gone by default.
- Net worth + total portfolio remain correct with zero schema/migration risk.
- One-line, fully reversible — the data model and backend capability are retained intact.

**Negative / cost**
- Per-account holdings breakdowns, in-specie moves, and brokerage-import routing are unavailable
  while off.
- Dormant backend code is retained but unused (minor `byAccount` compute overhead in
  `getPortfolioSummary`); a later milestone could short-circuit it if desired.

**Neutral**
- No migration. Any pre-existing account-tagged lots simply roll up into the single aggregate.
- The investment-wide sell-validation gap is moot while lots stay global; revisit before
  re-enabling.

## Related
- [[docs/adr/index|All ADRs]]
- [[docs/adr/088-account-entity|ADR-088: Account Entity]]
- [[docs/adr/091-per-account-positioning|ADR-091: Per-account positioning]] (UI scope narrowed here)
- [[docs/adr/100-net-worth-account-native-holdings|ADR-100]] (by-account holdings UI gated here)
- [[docs/adr/090-cash-sleeve-trades-as-transfers|ADR-090]] · [[docs/adr/095-brokerage-account-import|ADR-095]]
- [[docs/adr/030-frontend-env-schema|ADR-030: Frontend env schema]] (flag mechanism)

---

## Addendum (2026-07-10): Go decision — enable per-account holdings as the final phase of the accounts rewrite

### Context

This ADR parked the holdings half of the accounts epic (ADR-090/091/095/100 surfaces) behind a
default-off flag because it had no consumer and known rough edges. The 2026-07-09 accounts plan
review put the question back on the table as decision D3; **decision 2026-07-10: commit to
enabling it** — the flag was always a reversible scope-down, and the accounts rewrite is the
window in which the prerequisites get fixed anyway.

### Decision

`VITE_ENABLE_PER_ACCOUNT_HOLDINGS` flips to **default `true`** as the **final phase (Phase E)**
of the accounts rewrite (TODO.md → Feature work → "Accounts rewrite"), strictly after the
identity phase (B) and balance-engine phase (C) have landed. The flag is retained temporarily as
a kill-switch and removed after a soak.

**Prerequisites — all must be green before the flip** (each already filed as a finding):

1. Sell-units validation becomes per `(investment, account)` — the main body's known gap; it
   gates every import commit and manual create/update once lots carry accounts.
2. `moveHoldingService` fixes: `split`/`return_of_capital` events applied in `netUnits`, and the
   FIFO partial-move walk netting out units consumed by intervening sells.
3. `CloseAccountDialog` NaN landmine (`today: ''` → `todayYmd()`, plus the triple-cast cleanup).
4. Snapshot `value_by_account`: rescale per-account weights on splits.
5. `sanitizeSnapshotSpikes` must preserve the `Σ value_by_account == value` invariant.
6. Portfolio-import dedup includes `account_id` (cross-account trades / legitimate repeat fills).
7. A representable path for account-level instrument-less rows (sleeve interest, custody fees) —
   path decided 2026-07-10: signed cash row, see the
   [[docs/adr/095-brokerage-account-import|ADR-095 addendum]].
8. Per-account snapshot persistence from Phase C, so `getNetWorthByAccount` reads a table
   instead of replaying the full multi-year history per request.

**Also in scope once enabled:**
- The ADR-090 follow-on **funding-account picker** for sleeve-less wallets (`has_cash_sleeve =
  false`) — this also revives the currently-dead `funding_account_id` UI surface.
- **Lot assignment UX** for legacy `account_id = NULL` lots: a bulk "assign to account" action
  (user-driven, auditable), not a backfill migration — ADR-091's no-backfill stance stands.

### Consequences

**Positive**
- The built-and-tested half of the epic (cash sleeves, per-account positions, brokerage import
  routing, by-account net worth) becomes live product instead of dormant maintenance surface.
- Audits stop carrying "dormant — verify before enabling" caveats for these paths.

**Negative / cost**
- The rewrite's blast radius grows deliberately; sequencing last (after identity + balance
  engine are stable) is the mitigation.
- The prerequisite list is a hard gate — enabling with any item open reintroduces the
  correctness risks this ADR was written to avoid.

**Supersedes** the main body's default-off posture once Phase E completes; until then the flag
and this ADR's gating behavior remain exactly as described above.
