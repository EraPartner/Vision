---
title: ADR-097 Portfolio × Research — Watchlist Backtest & Allocation Drift
type: adr
date: 2026-06-18
tags: [adr, portfolio, research, watchlist, backtest, allocation, drift, benchmarks, adr-065, adr-079]
description: Two Portfolio×Research statistics — a watchlist "what-if I'd bought when I added it" backtest using add-date vs current price, and allocation drift (target vs actual weights) compared against canonical portfolios (60/40, all-weather, three-fund).
aliases: [watchlist backtest, allocation drift, classic portfolios, benchmark compositions]
---

# ADR-097: Portfolio × Research — Watchlist Backtest & Allocation Drift

## Status
Partially implemented — 2026-06-18 (watchlist backtest shipped; allocation drift deferred)

## Date
2026-06-18

## Context

The watchlist records what a user is *considering*; nothing tells them how those ideas would have
done. And the portfolio shows current weights but not how far they've drifted from a target or how
they compare to well-known model portfolios. Both are read-only analytics over data that exists
(watchlist `created_at`, `asset_price_history` / research provider, holdings).

## Decision

Two pure statistics in the Research/Portfolio surface:

- **Watchlist what-if backtest.** For each watchlist item, return = `(currentPrice −
  priceAtAddDate) / priceAtAddDate`, where `priceAtAddDate` is the historical close on/around the
  item's `created_at` (from `asset_price_history`, ADR-065, falling back to the research provider).
  "Had I bought when I added it…" Pure given the two prices; the data layer supplies the add-date
  price.
- **Allocation drift + classic benchmarks.** Drift per asset class/sleeve = `actualWeight −
  targetWeight`; actual weights come from holdings (ADR-044), target weights from a stored target
  allocation (new, small per-class config). Also compare actual weights against **canonical
  compositions** — 60/40, all-weather, three-fund — shipped as constants, so the user sees how
  their mix lines up with model portfolios even without a personal target.

Both are descriptive: no writes, no forecast coupling.

## Consequences

**Positive**
- Concrete "what my watchlist ideas did" + "how far off my target / a model portfolio am I."
- Reuses watchlist `created_at`, price history (ADR-065), and holdings weights.

**Negative / cost**
- Target allocation needs a small new store (per-class targets); canonical benchmarks cover the
  no-target case.
- Backtest accuracy depends on price-history coverage at the add-date (provider fallback).

**Risks / mitigations**
- *Missing add-date price* → fall back to the nearest available close / provider; show "no data"
  rather than a wrong number.
- *Weights not summing to 100%* → normalize before diffing; surface unclassified holdings.

## Implementation status (2026-06-18)

**Watchlist backtest — shipped.** Rather than deriving the add-date price from `asset_price_history`
at query time (which requires history coverage), the implementation snapshots the live quote at add
time. Migration 0058 (authored, not applied) adds `added_price NUMERIC(18,6) NULLABLE` to the
`watchlist` table. `POST /api/watchlist` accepts `added_price`; the backend sets it from the live
quote at add time when not explicitly provided. `WatchlistPage` shows "Since added {date} +X%"
using `(current_price - added_price) / added_price`.

**Allocation drift + classic benchmarks — deferred.** Not built in this epic. Tracked in TODO.md.

## Related
- [[docs/adr/index|All ADRs]]
- [[docs/adr/065-daily-gap-fill-dense-asset-history|ADR-065: Price history]]
- [[docs/adr/079-multi-provider-research-aggregation|ADR-079: Research providers]]
- [[docs/adr/044-portfolio-summary-single-source-of-truth|ADR-044: Holdings weights]]
- [[docs/features/watchlist|Watchlist Feature]] — added_price display + backtest UI
- [[docs/api/watchlist|Watchlist API]] — added_price field details
