---
title: ADR-100 - Account-native net-worth holdings + Σ-accounts parity
type: adr
status: accepted
date: 2026-06-18
tags: [adr, net-worth, accounts, portfolio, snapshots, parity, adr-093, adr-091, adr-064, adr-061]
description: Realize ADR-093's snapshot supersession step — express portfolio holdings per account in the live summary (Σ accounts) and lock the re-sum with parity tests, while deliberately retaining the existing daily-snapshot history engine to avoid shifting the series.
aliases: [account-native net worth, per-account holdings backend, sum-of-accounts parity]
---

# ADR-100: Account-native net-worth holdings + Σ-accounts parity

## Status
Accepted — 2026-06-18.

## Context

ADR-093 redefined net worth as **Σ over in-net-worth accounts** (cash ledger + holdings − debt),
superseding ADR-064's "bank balances + portfolio summary" composition. The aggregate was realized
by the account foundation: the net-worth snapshot engine's **liquid** side already groups the live
transaction balances by `account_id`, gated by `in_net_worth` (ADR-089). The parked follow-ons were
(a) the per-account *holdings* breakdown and (b) the snapshot-engine cutover, sequenced behind an
ADR-061 parity pass to avoid silently shifting the historical series.

Until now `getPortfolioSummary` returned only per-investment summaries and portfolio-wide totals —
holdings were *global*, with no per-account split, so the net-worth page could show cash per account
but not holdings per account.

## Decision

- **Per-account holdings in the live summary.** `getPortfolioSummary` is *extended* (additively —
  the per-investment contract and its golden tests are untouched) with a top-level `byAccount`
  array. Each investment's lots are grouped by `account_id` and run through the **same**
  per-investment cost-basis math (ADR-073/ADR-044), then aggregated per account into
  `{ account_id, currentValue, totalInvested, gainLoss }`. Names are resolved by the caller from the
  accounts list. Unassigned lots (`account_id NULL`) collapse into one `account_id: null` row.
- **Parity by construction, locked by tests.** Because the per-account split partitions the same lot
  set and reuses the same math + FX multipliers, `Σ byAccount` equals the per-investment totals. An
  ADR-061-style parity test asserts `Σ byAccount.currentValue == totals.totalPortfolioValue` (and the
  same for invested/gain), so the cutover cannot silently diverge.
- **Net-worth page = Σ accounts.** The page composes each account's cash (computed balance, ADR-094)
  with its holdings (the `byAccount` split) for a per-account net-worth breakdown.
- **History engine retained — deliberately.** The persisted daily series keeps the existing engine
  (liquid already account-native; investments forward-filled from `portfolio_performance_snapshots`
  per ADR-061). Per ADR-093's own risk note, rebuilding the *historical* per-account series is NOT
  done here — there is no per-account daily holdings snapshot, and reconstructing one would shift the
  series. The live aggregate and the current-day breakdown are account-native; history stays stable.

## Consequences

**Positive**
- The net-worth page and live summary are expressed natively as Σ accounts, holdings included.
- Parity tests lock the decomposition to the golden-locked totals — no drift on future changes.
- No historical-series disturbance (the documented ADR-093 risk is avoided).

**Negative / cost**
- `byAccount` is a current-point decomposition only; the daily chart's *investments* line remains a
  single aggregate (no per-account history). A full per-account historical rebuild is a later step
  if/when per-account daily snapshots exist.
- A new additive response field to keep in sync with the OpenAPI contract.

## Related
- [[docs/adr/index|All ADRs]]
- [[docs/adr/093-net-worth-sum-of-accounts|ADR-093: Net worth = Σ accounts]] (this realizes its follow-on)
- [[docs/adr/091-per-account-positioning|ADR-091: Per-account positioning]]
- [[docs/adr/064-net-worth-snapshots|ADR-064]] (composition superseded)
- [[docs/adr/061-snapshot-valuation-parity|ADR-061: Snapshot valuation parity]] (parity-test approach)
