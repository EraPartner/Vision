---
title: ADR-108 Portfolio accounts v2 — whole-lot broker tagging with partitioned P&L
type: adr
status: accepted
date: 2026-07-10
tags:
  [
    adr,
    accounts,
    portfolio,
    broker-tags,
    cost-basis,
    per-account,
    adr-090,
    adr-091,
    adr-095,
    adr-100,
    adr-103,
  ]
description: Replace the flag-hidden ADR-091/100 per-account holdings machinery with whole-lot broker tagging — every lot belongs to exactly one broker account, sells consume same-broker lots, transfers are re-tags that carry basis — giving per-broker positions AND per-broker P&L as partitions of the global engine, while deleting trade cash legs, FIFO move surgery, and the snapshot value_by_account walk. Supersedes the UI scope of ADR-090/091/095/100 and retires ADR-103's flag.
aliases: [portfolio accounts v2, broker tags, whole-lot tagging, per-broker P&L]
---

# ADR-108: Portfolio accounts v2 — whole-lot broker tagging with partitioned P&L

## Status

Accepted — 2026-07-10. Supersedes the **UI scope** of [[docs/adr/090-cash-sleeve-trades-as-transfers|ADR-090]],
[[docs/adr/091-per-account-positioning|ADR-091]], [[docs/adr/095-brokerage-account-import|ADR-095]]
and [[docs/adr/100-net-worth-account-native-holdings|ADR-100]]; retires the
[[docs/adr/103-per-account-holdings-ui-flag|ADR-103]] flag (surfaces are deleted or re-shipped
redesigned, not un-hidden).

## Date

2026-07-10

## Context

ADR-103 hid the per-account holdings UI because its complexity (account pickers on every trade,
in-specie move flows with FIFO lot surgery, per-row import routing) had no consumer and the
machinery carried a cluster of verified bugs (moveHoldingService unit/cost-basis corruption,
non-atomic trade+leg writes, FX-blind legs, snapshot `value_by_account` never rescaled on
splits, …). On 2026-07-10 the user re-opened the portfolio branch-out and made these decisions
(recorded verbatim in `TODO.md` § _Accounts research_ → _5️⃣_):

- **Q1** Broker cash is reconcile-anchored ledger cash — **no synthesized trade cash legs**.
- **Q2** Per-broker **P&L will be built** — but not by fixing the ADR-091 machinery.
- **Q3** The historical per-broker chart: buggy snapshot walk **deleted now, rebuilt properly
  later** on a persisted side table (scheduled, last).
- **Q4** Existing global lots are **bulk-assigned** to brokers via a one-time nudge.
- **Q5** Brokerage **cash-statement imports stay** (user imports them) — that path is fixed,
  not deleted.
- **Q6** Wallets/exchanges are **visually distinguished** (holdings-only cards, no cash line).

## Decision

**Model: whole-lot broker tagging.** Every lot (buy) belongs to exactly **one** broker account
(`portfolio_transactions.account_id`, migration 0052 — no new columns). Sells consume lots at
the **same account**. Corporate actions apply investment-wide across partitions. An in-specie
transfer or account close is a **re-tag** (`UPDATE … SET account_id` on whole lots) — basis and
acquisition dates travel with the lot, no cost-basis surgery ever.

**Math: partitions of the one global engine.** Per-broker positions _and_ P&L
(invested/realized/unrealized) are computed by running the existing lot engine per
(investment, account) partition with the user's configured method; **Σ partitions ≡ global
totals by construction** (parity-tested). Tax stays global (TOB per transaction, Reynders/CGT
per year — per-custodian basis is never a tax input). Sell validation becomes account-scoped
(you can't sell what isn't at that broker); while an instrument still has unassigned lots, its
per-broker surfaces fall back to global display with an "assign lots" nudge instead of showing
wrong partitions.

### 2026-09-04 completion addendum

The partition rule now applies consistently to live summaries, frontend fallback summaries, and
historical snapshot replay. Snapshot unit state and foreign-exchange-neutral basis are tracked per
broker partition; one broker's sell cannot consume another broker's units or basis.

Legacy data may already contain a partition oversell. Such a position remains readable and is
marked `oversold` in both the investment and account summary contracts so the portfolio table,
overview, and detail dialog can direct the user to reassign the affected transactions. Writes
compare the complete before/after unit history: they reject a newly introduced or worsened
partition deficit, including one caused by reassigning or redating an earlier buy, but allow an
unchanged or improved legacy-invalid history so it can be repaired incrementally. The validation
loads the investment's unit-event history once; it derives assignment state, sell availability,
and projected partition deficits from that same ordered result.

The `byAccount` response uses `assignment: "account" | "unassigned"` as a stable machine-readable
identity. `account_id: null` remains the storage representation, while clients localize the
Unassigned label instead of treating a missing account name as identity.

**Cash: real rows only.** The broker cash sleeve is an ordinary budgeting ledger — fed by real
transfers and by imported brokerage cash statements (Q5), anchored by the ADR-107 reconcile
flow with its provenance line. `tradeCashLegService` and all ADR-090 leg synthesis are deleted
(imported statements already contain the true cash movements; synthetic legs would double-count).

**Deleted, not fixed:** trade cash-leg posting (and its 5 filed bugs) · `moveHoldingService` +
`/api/investments/:id/move` + `MoveHoldingDialog` (replaced by bulk re-tag) · snapshot
`splitByAccount`/`value_by_account` walk + `GET /api/info/net-worth/by-account` + the current
`NetWorthByAccountChart` (per-broker history returns later via a persisted side table written
forward-only by the snapshot builder) · `VITE_ENABLE_PER_ACCOUNT_HOLDINGS` and every branch on
it.

**Kept and fixed:** brokerage cash-row import path (sign handling, rollback, instrument-less
rows, ledger routing) · portfolio-import dedup gains `account_id` + currency · file-level
import routing (ADR-095's batch grain — never per-row UI).

**UX surfaces (the deliberate few):** trade dialogs show a muted default "→ {broker} · change"
(last-used per instrument), never a mandatory picker · broker account cards in the ADR-107
grouped hub (holdings value + cash + provenance lines; wallets holdings-only) · broker detail =
the ADR-107 `/accounts/:id` route with a holdings section above the cash ledger · net-worth
"By Account" current-point table from live partitions · portfolio-overview broker filter with
per-broker subtotal and P&L.

## Consequences

- Positive: per-broker questions ("what do I have at Degiro, and how is it doing") get honest
  answers from one engine; ~9 filed bugs become moot by deletion; transfers/closes become
  trivially correct; no double bookkeeping between synthetic legs and imported statements.
- Negative: per-account sell validation and partitioned P&L are new, carefully-tested work (the
  parity invariant is the safety net); per-broker P&L is only meaningful after the Q4 backfill;
  the historical per-broker chart disappears until its rebuild phase.
- Neutral: `has_cash_sleeve`/`multi_currency_cash`/`route`/`is_brokerage` columns stay dormant
  until a later contraction migration; ADR-103 remains historically accurate but its flag is
  gone.

Implementation plan with work packages: `TODO.md` § _Accounts feature research 2026-07-10_ →
_5️⃣ Implementation plan_.

## Related

- [[docs/adr/107-accounts-budgeting-ux-remake|ADR-107]] (budgeting side; the detail route this design lands in)
- [[docs/adr/090-cash-sleeve-trades-as-transfers|ADR-090]] · [[docs/adr/091-per-account-positioning|ADR-091]] · [[docs/adr/095-brokerage-account-import|ADR-095]] · [[docs/adr/100-net-worth-account-native-holdings|ADR-100]] · [[docs/adr/103-per-account-holdings-ui-flag|ADR-103]]
- [[docs/features/portfolio-tax|Portfolio tax]] (why basis stays global)
- [[docs/adr/index|All ADRs]]
