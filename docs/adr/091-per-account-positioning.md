---
title: ADR-091 Per-Account Positioning (account_id on lots)
type: adr
date: 2026-06-18
tags: [adr, accounts, portfolio, cost-basis, lots, positions, adr-088, adr-073, adr-044]
description: Give portfolio_transactions (the lots) an account_id FK so a position is derived per (investment, account), enabling per-account cost basis and a real close-account workflow, without duplicating the security definition.
aliases: [per-account positions, account_id on lots, per-account cost basis]
---

# ADR-091: Per-Account Positioning (account_id on lots)

## Status
Accepted — 2026-06-18 (follow-ons realized in the same epic, see below)

## Date
2026-06-18

## Context

Holdings are global today: `investments` is the security + position, `portfolio_transactions`
are its lots, and neither carries an account. So "100 AAPL at IBKR vs 50 at Degiro" cannot be
expressed, there is no per-account cost basis, and there is no clean "close this account"
workflow. The account entity (ADR-088) now exists; portfolio positions should hang off it too.

Two shapes were considered (and decided with the user): one `investments` row **per account**
(duplicating the security) vs. **`account_id` on the lots** (`portfolio_transactions`), positions
derived per `(security, account)`. The user chose **account_id on the lots** — no security
duplication; the security definition and price config stay single.

## Decision

Add a nullable `account_id` FK (`ON DELETE RESTRICT`, per ADR-087's history-protecting policy) to
`portfolio_transactions`. A **position = `(investment_id, account_id)`**; `investments` stays the
single security/price definition.

- **Cost basis becomes a grouping change, not a math change.** The pure calculators in
  `@vision/shared-utils/portfolio` (ADR-073) operate over a transaction array. The per-account
  view groups lots by `(investment_id, account_id)` and runs the same
  `calculateCostBasisByMethod` per group; the whole-investment view runs over *all* the
  investment's lots. The math is untouched, so its golden fixtures stay valid.
- **Single summary stays single (ADR-044).** `getPortfolioSummary` keeps returning per-investment
  totals (the existing contract, golden-locked); it is *extended* to also expose a per-account
  breakdown. The per-investment total equals the union over its accounts, so existing outputs do
  not change.
- **Legacy lots:** existing `portfolio_transactions` keep `account_id = NULL` ("unassigned" /
  global) — no backfill, no forced migration of history. New trades record the account; users can
  assign legacy lots later.
- **Close-account workflow:** with positions attributable to an account, closing = liquidate or
  transfer the account's positions, then archive (`is_active=false`). The `ON DELETE RESTRICT` FK
  guarantees an account with lots can't be hard-deleted.

This is the prerequisite for ADR-090 (trades = transfers): the auto-created cash leg lands on the
trade's account sleeve, which requires the trade to *have* an account — i.e. this column.

## Consequences

**Positive**
- Per-account cost basis and a real close-account flow, with no security/price duplication.
- The cost-basis math and its golden tests are unchanged (grouping happens above them).
- Unblocks ADR-090's per-account cash legs.

**Negative / cost**
- `getPortfolioSummary` and the frontend `usePortfolio` must learn to group by account for the
  per-account view (the per-investment contract is preserved).
- Holdings UI grows a per-account breakdown (e.g. "AAPL 150 → IBKR 100 · Degiro 50").
- A nullable `account_id` means "unassigned" lots exist until the user assigns them.

**Risks / mitigations**
- Divergence between per-investment totals and the sum of per-account groups → guarantee by
  construction (group then union); cover with a golden test that the per-account split re-sums to
  the per-investment total.
- Migrations not auto-run → ship the revision + rollback; user applies.

## Follow-on implementation (realized 2026-06-18)

All four follow-ons from this ADR shipped in the account-entity epic:

- **Per-account holdings breakdown in `getPortfolioSummary`** — service now returns a top-level `byAccount: [{account_id, currentValue, totalInvested, gainLoss}]` array. Lots grouped by `account_id` run through the same cost-basis math; `account_id: null` = unassigned. Σ byAccount == per-investment totals (parity locked by test). See [[docs/adr/100-net-worth-account-native-holdings|ADR-100]].
- **Edit-trade account picker** — `EditPortfolioTxnDialog` has an account selector. `PATCH /api/investments/transactions/:id` accepts `account_id` (number to reassign, `null` to unassign).
- **Partial-move cost-basis strategy** — `POST /api/investments/:id/move` now accepts `strategy: 'fifo' | 'proportional'`. `proportional` (average-cost) splits every lot by the same fraction rather than peeling oldest lots first. `MoveHoldingDialog` exposes the selector for partial moves.
- **Close-account workflow** — `CloseAccountDialog` lists an account's holdings, transfers them in-specie to another account (calls the move endpoint), then archives the account (`is_active=false`). Wired into `AccountsPage`.
- **Portfolio import batch account assignment** — `portfolio_import_batches.account_id` added (migration 0057, authored, not applied). `POST /api/portfolio/import/batches/:id/commit` accepts optional `account_id`; committed lots inherit it.

Frontend hooks added: `useAccountPositions.ts` (per-account holdings breakdown), `useAccountNetWorth.ts` (per-account net-worth breakdown — ADR-093/ADR-100).

## Related
- [[docs/adr/index|All ADRs]]
- [[docs/adr/088-account-entity|ADR-088: Account Entity]]
- [[docs/adr/100-net-worth-account-native-holdings|ADR-100]] (realizes the per-account parity step)
- [[docs/adr/073-shared-portfolio-math|ADR-073: Shared Portfolio Math]] (cost-basis calculators, unchanged)
- [[docs/adr/044-portfolio-summary-single-source-of-truth|ADR-044: Portfolio Summary]] (extended, not replaced)
- [[docs/adr/090-cash-sleeve-trades-as-transfers|ADR-090: Cash Sleeve & Trades = Transfers]] (depends on this)
