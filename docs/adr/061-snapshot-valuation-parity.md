---
title: ADR-061 - Snapshot Valuation Parity with Live Summary
type: adr
status: accepted
date: 2026-05-18
tags: [adr, portfolio, snapshots, net-worth, valuation, fixed-income, real-estate, savings, bonds, accrued-interest, appreciation, reconciliation, parity]
description: Rewrite snapshotBuilder non-unit asset valuation to mirror live portfolioSummaryService formulas exactly, eliminating the 2,142.24 € discrepancy between the Net Worth "Investments" headline and the Portfolio Overview / Performance "Portfolio Value" cards.
related: [docs/adr/043-portfolio-snapshot-atomicity, docs/adr/044-portfolio-summary-single-source-of-truth, docs/features/portfolio, docs/features/net-worth]
---

# ADR-061: Snapshot Valuation Parity with Live Summary

## Status

**Accepted** — Implemented 2026-05-18.

## Date

2026-05-18

## Context

### Three-page divergence

Vision exposes portfolio totals on three surfaces:

| Surface | Data source | Method |
|---------|-------------|--------|
| Dashboard "Total Value" card | `GET /api/info/portfolio-summary` | Live `portfolioSummaryService` |
| Performance "Portfolio Value" card | `GET /api/info/portfolio-summary` (realtime override, per ADR-044) | Live `portfolioSummaryService` |
| Net Worth "Investments" headline + historical chart | `GET /api/info/net-worth` → `portfolio_performance_snapshots` | `snapshotBuilder.computeDailySnapshots()` |

ADR-044 unified the first two surfaces onto `portfolioSummaryService`. The third surface — `portfolio_performance_snapshots` — was still computed by `snapshotBuilder.js` using a different formula for non-unit assets (savings, bonds, real_estate), producing a persistent divergence.

### Root cause: flat `current_price` valuation for non-unit assets

Before this fix, `snapshotBuilder` valued fixed-income and real-estate investments as:

```
value = investments.current_price   (for every historical day)
```

This ignored:
- **Accrued interest**: savings/bond principal accumulates daily interest between payments
- **Appreciation transactions**: real estate value grows via explicit `appreciation` transaction entries
- **Transaction-based principal**: buy/sell/gift transactions alter the invested principal over time

`portfolioSummaryService` (the live summary) already computed the correct values by walking transactions and accumulating `runningInvested + accruedInterest` (fixed-income) or `runningInvested + runningAppreciation` (real estate). The snapshot pipeline did not mirror this.

A user reported a **2,142.24 € discrepancy**: Net Worth showed a lower "Investments" figure than Portfolio Overview showed as "Total Value" for the same day.

### Additional issue: unit-based assets on the latest day

For unit-based assets (stock, etf, crypto, metals), the snapshot pipeline forward-filled `asset_price_history` for every day including today. However, `asset_price_history` is only updated by explicit price refreshes, so a price refresh that updated `investments.current_price` would not appear in the latest snapshot until the next history fetch. This caused a secondary divergence on the current day.

## Decision

Rewrite `snapshotBuilder.computeDailySnapshots()` to mirror `portfolioSummaryService` formulas exactly for every non-unit investment, and to use `investments.current_price` directly for the latest day for unit-based assets.

### Non-unit asset valuation (fixed-income: savings/bond)

Day-by-day walk accumulates:

```
runningInvested  ← sum of buy+gift amounts (converted to target currency)
                 ← minus sell amounts
lastInterestDate ← date of most recent `interest` transaction (resets accrual clock)
firstBuyDate     ← date of first `buy` transaction

accruedInterest = runningInvested × (interestRate / 100 / 365) × calendarDaysBetween(startDate, day)
  where startDate = lastInterestDate ?? firstBuyDate

value = runningInvested + accruedInterest
```

`calendarDaysBetween` uses `APP_TIMEZONE` (per ADR-009) to prevent TZ-skewed day counts.

### Non-unit asset valuation (real_estate)

```
runningInvested      ← sum of buy amounts (gift excluded for real estate invested-capital semantics)
runningAppreciation  ← sum of `appreciation` transaction amounts

value = runningInvested + runningAppreciation
```

### Legacy fallback (no transactions)

To preserve backward-compatibility for investments entered without any buy transactions (manual current_price entry), if `value ≤ 0` and `day >= inv.active_from` and `inv.current_price > 0`, the snapshot still uses `current_price` converted to target currency. This prevents manually-entered, txn-less investments from regressing to zero in the historical chart.

### Unit-based assets on the latest day

For the most recent snapshot day only, unit-based valuation uses `investments.current_price` directly:

```javascript
const price = isLatestDay && inv.currentPrice > 0
  ? inv.currentPrice
  : resolvePrice(inv, day, lastKnownPrice);   // forward-fill from asset_price_history
```

Historical days are unchanged (still use `asset_price_history` forward-fill). This guarantees the latest snapshot reconciles with `portfolioSummaryService` even when `asset_price_history` lags behind a price refresh.

### Regression tests added

`apps/node-backend/tests/portfolioPerformanceSnapshotService.test.js` now covers:

- Savings accrual: `value = principal × rate × days / (100 × 365)` confirmed to cent precision
- Real-estate appreciation: cumulative `appreciation` transactions summed correctly
- Bond interest payment: `interest` transaction resets accrual clock; subsequent days start from payment date
- Latest-day unit-based: snapshot uses `inv.current_price`, not stale history

## Consequences

### Positive

1. **Three-page reconciliation**: Dashboard "Total Value", Performance "Portfolio Value", and Net Worth "Investments" now show the same value for the same day using the same underlying formulas.
2. **Accrued interest visible in history**: Savings and bond investments accrue interest day-by-day in the historical chart, reflecting true economic value rather than flat `current_price`.
3. **Real-estate appreciation in history**: Appreciation transactions are visible in the Net Worth chart immediately after entry, not only in the live summary.
4. **Latest snapshot always matches live summary**: Latest-day unit prices come from `investments.current_price`, eliminating the secondary divergence after price refreshes.
5. **Legacy investments preserved**: Investments without transactions continue to display using `current_price` from `active_from`.

### Negative / Behavioral Consequences

1. **Historical chart redraw on next refresh**: The next `computeAndStoreSnapshots` run rewrites historical net-worth values for fixed-income and real-estate days. Values will typically shift **upward** as accrued interest and appreciation are now layered in. Users will see the historical Net Worth chart redraw on their next page refresh.
2. **Slightly heavier snapshot computation**: The day walk now maintains per-investment accumulators (`runningInvested`, `runningAppreciation`, `lastInterestDate`, `firstBuyDate`) for all non-unit investments, adding O(investments × days) state, but this is negligible compared to the existing price-history forward-fill.

### Neutral

1. **No schema changes**: `portfolio_performance_snapshots` columns are unchanged; only the values written to `cash_value` (and indirectly `value`, `gain_loss`, `return_pct`) change.
2. **No API contract changes**: Response shape of `/api/info/net-worth` is unchanged.
3. **No frontend changes**: All three pages continue to consume their existing endpoints; the fix is entirely in `snapshotBuilder.js`.

## Implementation

- **Service**: [[apps/node-backend/src/services/portfolio/snapshotBuilder.js]]
- **Utility**: [[apps/node-backend/src/utils/portfolioMath.js]] (`calendarDaysBetween` export used by snapshot builder)
- **Tests**: [[apps/node-backend/tests/portfolioPerformanceSnapshotService.test.js]]
- **Live summary (reference)**: [[apps/node-backend/src/services/portfolio/portfolioSummaryService.js]]

## Related Decisions

- [[docs/adr/074-fx-attribution-historical-rates|ADR-074]] — Extends this ADR by locking invested capital at purchase-date FX rates and adding the `value_fx_neutral` column to `portfolio_performance_snapshots` (migration 0039); the FX-neutral chart series shows `value − value_fx_neutral` as the cumulative currency effect
- [[docs/adr/043-portfolio-snapshot-atomicity|ADR-043]] — Atomic snapshot replace (DELETE + INSERT in one transaction)
- [[docs/adr/044-portfolio-summary-single-source-of-truth|ADR-044]] — Live summary as single source of truth for dashboard + performance totals
- [[docs/adr/009-timezone-policy|ADR-009]] — `calendarDaysBetween` uses `APP_TIMEZONE` for exact integer day counts

## Related Docs

- [[docs/features/portfolio|Portfolio Feature]] — Net Worth Tracking section
- [[docs/features/net-worth|Net Worth Feature]] — Backend Computation section
- [[docs/reference/algorithms|Algorithms]] — Net Worth Snapshot Algorithm section
