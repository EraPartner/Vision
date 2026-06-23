---
title: ADR-085 - Belgian Tax Point-in-Time FX Rates
type: adr
status: accepted
date: 2026-06-18
tags: [adr, belgian-tax, fx, exchange-rates, historical-rates, tax-report]
description: The tax report converts foreign-currency tax, fee, and dividend amounts at the exchange rate on the transaction date instead of today's rate, matching Belgian tax rules for foreign movable income and the TOB.
aliases: [adr-085, tax-point-in-time-fx, tax-historical-fx]
---

# ADR-085: Belgian Tax Point-in-Time FX Rates

## Status
Accepted

## Date
2026-06-18

## Context

ADR-058/059 closed the historical-fidelity gaps on the **inputs** side of the Belgian
tax viewer (frozen per-year profile snapshots, as-filed calculations, audit log). Both
ADRs explicitly flagged one remaining gap as their natural successor:

> Foreign-currency transactions continue to convert at today's FX rates. Calling this
> out again — it's the largest remaining historical fidelity gap. (ADR-059)

Concretely, the tax data fetcher that feeds the tax PDF report
(`apps/node-backend/src/services/reports/dataFetcherTax.js`) converted every
foreign-currency tax, fee, and dividend amount with `loadCurrentRates()` +
`convertWithRates()` — i.e. **today's** ECB rate, regardless of when the dividend was
collected or the trade executed. For anyone holding foreign-currency assets, the
reported TOB, withholding tax, fees, and gross dividends drifted with the live exchange
rate and did not match what was actually owed/withheld at the time.

This is wrong against the Belgian rules we are best-effort mimicking:

- **TOB (taks op beursverrichtingen).** The official guidance is explicit: a
  foreign-currency transaction value is converted to EUR "using the official ECB
  exchange rate of the day the transaction took place."
- **Foreign movable income (dividends/interest).** Movable income is taxable at its
  **date of collection**; the taxpayer must be able to evidence the income *and the date
  it was collected*. The conversion anchor is therefore the collection-date rate, not the
  current rate.

The point-in-time FX infrastructure already existed and was used by the portfolio
surfaces — a per-date `exchange_rates` table (`rate_date`, `rate_to_eur`), an ECB
full-history backfill, per-transaction `fx_rate_to_eur` stamping, an in-memory
historical rate index (`buildHistoricalRateIndex`), and on-or-before lookup
(`findRateOnOrBeforeInIndex`). Only the tax path had not been wired to it.

## Decision

Convert each tax row in `fetchTaxTransactions` at the exchange rate on **that row's
transaction date** instead of the current rate.

- Build a historical rate index once per report from `exchange_rates`, scoped to the
  currencies actually present in the period (plus the target currency).
- For each row, resolve `rate_to_eur` for both the source and target currency using
  `findRateOnOrBeforeInIndex` — the standard FX convention where a weekend/holiday date
  uses the last published rate (Saturday → Friday's close). EUR is always `1`.
- Reuse `convertWithRates` with a small per-row rate table, so the conversion math and
  unsupported-currency handling stay identical to the live path; only the rate *source*
  (historical vs. current) changes.
- **Fallback.** When no rate is stored on or before a row's date (e.g. a brand-new
  transaction imported before the FX backfill has run), fall back to the current rate.
  This keeps the report functional rather than dropping rows, at the cost of a transient
  approximation that self-corrects once the backfill stamps the date.

EUR-only periods skip the FX lookup entirely (no `exchange_rates` query), so the common
Belgian case pays no extra cost.

## Consequences

### Positive

- Tax report numbers (TOB, withholding tax, fees, gross dividends) match the Belgian
  rules: each amount is valued at its transaction/collection date, not today.
- Reports are now **stable over time** — re-generating last year's report no longer
  produces different totals just because the live exchange rate moved.
- No new infrastructure: rides entirely on the existing historical-rate table, index,
  and backfill.

### Negative / known limits

- **Backfill dependency.** Accuracy depends on `exchange_rates` actually holding a rate
  on/before each transaction date. The portfolio FX backfill populates this on startup;
  until it runs for a freshly imported transaction, that row falls back to the current
  rate. Fallback rows are an approximation, not a silent error — they converge once the
  backfill stamps the date.
- **Scope: the tax report path.** This wires historical FX into the authoritative tax
  data fetcher (`dataFetcherTax.js`). The frontend tax *overview* still values live
  portfolio figures via the portfolio summary at current rates — that is a current-value
  display concern, not the tax computation, and is intentionally left unchanged.
- **Not the average-rate method.** Belgian practice also tolerates an annual-average
  rate for recurring foreign income as a simplification. We use the per-date rate, which
  is the more precise and more defensible anchor (and the one TOB mandates).

### Neutral

- Four unit tests (`tests/dataFetcherTax.test.js`) lock the behavior: transaction-date
  conversion, weekend on-or-before convention, current-rate fallback, and the EUR-only
  fast path.

## Related
- [[docs/adr/058-belgian-tax-historical-year-snapshots|ADR-058]] — historical year viewer (inputs side)
- [[docs/adr/059-belgian-tax-historical-year-extensions|ADR-059]] — as-filed snapshots; named point-in-time FX as the successor gap
- [[docs/features/belgian-tax|Belgian Tax feature]]
- [[docs/features/portfolio-tax|Portfolio Tax feature]]
- [[docs/adr/index|All ADRs]]
