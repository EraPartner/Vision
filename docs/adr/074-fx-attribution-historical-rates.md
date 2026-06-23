---
title: "ADR-074: FX attribution with purchase-date rates"
type: adr
status: accepted
date: 2026-06-11
tags: [adr, portfolio, fx, currency, attribution]
description: Invested capital locks at purchase-date FX rates; total gain includes the FX component, decomposed into asset gain + FX gain; ECB full history backfills past rates automatically
aliases: [fx attribution, currency attribution, ADR-074]
---

# ADR-074: FX attribution with purchase-date rates

## Status
Accepted

## Date
2026-06-11

## Context

A user counting in EUR holding a USD investment saw the portfolio value move when
USD/EUR moved, with no way to tell currency noise apart from asset performance.
Three concrete defects underpinned this:

1. **The live summary converted *everything* at today's rate** — including
   invested capital (`portfolioSummaryService`). "Invested" jiggled with FX, and
   the headline `gainLoss` was the native gain × today's rate, i.e. it silently
   *excluded* FX effects — while the snapshot series (ADR-061) *included* them.
   Two contradictory stories on one page.
2. **No attribution.** Nothing decomposed a gain into "the asset moved" vs
   "the currency moved".
3. **Fabricated rate history.** The only historical-rate source was ECB's
   90-day feed; for older transaction dates the backfill stored the
   nearest-known (often current) rate as if it were historical.

The user chose (interview, 2026-06-11): keep valuation at **current** rates
(true EUR worth) with attribution shown, headline gain **includes** FX with the
split visible, surface it on summary cards / per-investment rows / the
performance chart / the detail view, and **fully backfill** past data
automatically.

## Decision

**Valuation contract.** Holdings *values* (current value, current price,
accrued interest) convert at **today's** rate. *Flows* (buys, sells, fees,
taxes, income) convert at the rate of **their transaction date**, preferring
the rate stamped on the row (`portfolio_transactions.fx_rate_to_eur`), else the
stored historical rate on-or-before the date, else today's rate with a
`usedFallbackRate` disclosure flag. Therefore:

- `totalInvested` is locked at purchase-date rates and no longer moves with FX.
- `gainLoss` = value at today's rate − invested at purchase-date rates (plus
  income/realized terms as before) — it **includes** the FX component.
- `assetGain` = native-currency gain × today's rate (pure asset performance);
  `fxGain` = `gainLoss − assetGain` (the residual currency effect). The
  identity `gainLoss = assetGain + fxGain` holds by construction, per
  investment and in totals.

**Where the math lives.** The shared cost-basis calculators
(`@vision/shared-utils/portfolio`, ADR-073) carry a parallel **converted
track**: each transaction may bear an `fxMultiplier`; weighted-avg/FIFO/LIFO
all track converted cost basis through sells (lot-accurate), so
`realizedGainConv` compares sell-date proceeds against buy-date cost.
`buildInvestmentSummaryCore` returns a `converted` block; with no FX inputs it
degrades to the native numbers, so the frontend mirror is unaffected.

**Automatic rates.** `rateFetcher` gains an ECB **full-history** tier
(`eurofxref-hist.xml`, daily since 1999) behind the existing 90-day feed.
Lookups use the on-or-before convention (a Saturday uses Friday's close, never
Monday's). The startup backfill now: (a) one-time repairs previously fabricated
rows from full history (flagged via `user_settings.fx_full_history_repair_done`
so offline starts retry), (b) fills missing (currency, date) pairs without ever
persisting nearest-rate guesses, and (c) bulk-stamps `fx_rate_to_eur` onto
non-EUR transactions that lack it (≤ 7-day on-or-before only). New/edited
transactions are stamped at write time from stored rates (DB-only — the write
path never blocks on HTTP).

**FX-neutral snapshot series.** `portfolio_performance_snapshots` gains
`value_fx_neutral` (migration 0039, nullable): the portfolio valued at each
investment's cost-weighted average purchase-date rate. `value −
value_fx_neutral` is the cumulative currency effect; the performance chart
exposes it as an opt-in dashed series. The writer detects the column and
degrades gracefully on un-migrated databases.

## Consequences

- **Displayed numbers change** for multi-currency portfolios: invested and
  gain/loss now reflect purchase-date rates (this is the fix, not a
  regression). Live totals finally agree with the snapshot series' semantics.
- API additions (non-breaking, additive): per-investment `assetGain`, `fxGain`,
  `nativeCurrentValue`, `usedFallbackRate`; totals `totalAssetGain`,
  `totalFxGain`, `usedFallbackRate`; snapshots `value_fx_neutral?`.
- Migration 0039 must be applied by the user (`bun run db:upgrade`); until
  then the FX-neutral chart series is simply absent.
- Known limitations, accepted: non-ECB currencies (e.g. AED) have no deep rate
  history — their old conversions stay nearest-rate and are flagged; FX gain on
  *sold* lots attributes via the converted cost-basis track (weighted by the
  active cost-basis method), not per-lot tax-grade accounting; fixed-income
  snapshot values remain accumulated at txn-date rates (pre-existing ADR-061
  behaviour), so a foreign-currency savings account's snapshot ignores
  day-to-day FX on principal.
- The one-time repair **overwrites** old `exchange_rates` rows with ECB truth;
  safe because no manual-rate entry path exists.

## Related
- [[docs/adr/061-snapshot-valuation-parity|ADR-061: Snapshot valuation parity]]
- [[docs/adr/073-shared-portfolio-math-package|ADR-073: Shared portfolio math]]
- [[docs/adr/044-portfolio-summary-single-source-of-truth|ADR-044: Portfolio summary SSoT]]
- [[docs/integrations/currency-conversion|Currency conversion integration]]
- [[docs/adr/index|All ADRs]]
