---
title: "ADR-240: Portfolio tax figures per tax year, at transaction-date FX"
type: adr
status: accepted
date: 2026-10-21
tags: [adr, belgian-tax, portfolio-tax, capital-gains-tax, tob, fx, historical-rates, adr-085, adr-216]
description: "Accepted on 2026-10-21. The Belgian portfolio-tax dashboard computes realized gains, the CGT and Reynders estimates and the effective tax rate from the sells of the viewed tax year only, using the portfolio summary's own replay so the years add up to the lifetime gain. Recorded taxes, fees, dividends and TOB legs on both tax dashboards convert at the transaction date's rate (stamped fx_rate_to_eur, else the stored on-or-before rate), extending ADR-085; the latest stored rate is only the fallback. The TOB counts the sale as well as the purchase (WDRT art. 122). Supersedes the dashboard statements of ADR-216 and of docs/api/belgian-tax.md."
aliases: [adr-240, portfolio tax per tax year, tax-year realized gains]
related_code:
  [
    "apps/node-backend/src/services/tax/portfolioDashboardService.ts",
    "apps/node-backend/src/services/tax/dashboardService.ts",
    "apps/node-backend/src/services/tax/transactionDateFx.ts",
    "packages/shared-utils/src/belgianTax/portfolioTax.ts",
    "packages/shared-utils/src/belgianTax/portfolioDashboard.ts",
    "packages/shared-utils/src/belgianTax/costBreakdown.ts",
  ]
---

# ADR-240: Portfolio tax figures per tax year, at transaction-date FX

## Status

Accepted

## Date

2026-10-21

## Context

`GET /api/belgian-tax/portfolio-dashboard?year=` filtered recorded costs, dividends and buy legs
by the viewed year, but took realized gains from the lifetime portfolio summary. Every year's
CGT and Reynders estimates, `totalRealizedGain` and `effectiveTaxRate` therefore included sells
from earlier and later years: a 2025 sell with a 37,594.94 gain pushed the 2026 CGT estimate to
1,812.08 although 2026's own gain (525.83) was under the exemption, and the 2025 view counted
sells dated in 2026.

Recorded taxes and fees converted at today's rate, even when the transaction carried a stamped
rate. [[docs/adr/085-belgian-tax-point-in-time-fx|ADR-085]] already converts the tax report at
the transaction date's rate because the TOB and foreign movable income are valued on that day;
the dashboards did not follow it, so a closed year's TOB and withholding tax moved with today's
rate. [[docs/adr/216-server-owned-domain-calculations|ADR-216]] and the API documentation
described the lifetime gains and latest-rate costs as the dashboard's behaviour.

The TOB estimate and the recorded TOB counted buy legs only, and a sell's recorded taxes were
labelled capital-gains tax. The Wetboek diverse rechten en taksen, art. 122, 1°, makes the tax
"afzonderlijk verschuldigd" on the sale and on the purchase (source WDRT in
[[docs/reference/belgian-tax-rule-matrix]]).

## Decision

1. **Realized gains per tax year.** The service replays the canonical portfolio summary through
   31 December of the viewed year and through 31 December of the year before, and uses the
   difference per investment as that year's realized gain. This is the summary's own replay:
   the configured cost-basis method, each sell against the cost basis built up to it, sell-date
   FX against buy-date FX, net of the sell's fees and taxes. The years add up to the lifetime
   realized gain the portfolio shows. The CGT and Reynders estimates, `totalRealizedGain`,
   `effectiveTaxRate` and `investmentBreakdown[].realizedGain` use it. Unrealized gains and
   current values stay current holdings figures.
2. **Transaction-date FX for recorded amounts.** Before the estimators run, each transaction's
   amount, taxes and fees are restated in the target currency at its own date's rate: the
   stamped `fx_rate_to_eur`, else the stored rate on or before the date
   (`restateAtTransactionDateRates`). This applies to the portfolio-tax dashboard and to the
   recorded portfolio taxes of `GET /api/belgian-tax/dashboard`. A transaction without a dated
   rate keeps its currency and converts at the latest stored rate; with no stored rate at all it
   is left out and flagged, as before (ADR-216).
3. **TOB on both legs.** The TOB estimate charges every buy and sell leg at the asset class rate,
   capped per leg. Recorded TOB counts a buy's taxes and the TOB part of a sell's taxes. Before
   capital-gains tax applies, a sell's recorded taxes are its TOB; from 2026, when the same field
   can also hold withheld capital-gains tax, the part up to the leg's statutory TOB is TOB and
   the rest is capital-gains tax. The tax breakdown labels the parts the same way.

## Consequences

- A historical year's realized gain, CGT and Reynders estimates and effective tax rate change
  for anyone with sells in other years. The sum over all years equals the lifetime figure.
- Closed years' recorded taxes, fees and TOB no longer change with today's rate. They now agree
  with the tax report (ADR-085).
- The TOB estimate and recorded TOB rise for years with sells. The split of a sell's taxes
  between TOB and capital-gains tax from 2026 is an estimate: a broker that reports them
  separately would allow an exact split.
- Each dashboard request replays the portfolio summary two more times.
- The locale strings `tax.tobAutoEstimateDesc` and `tax.tobTrackedFromBuyTaxes` still describe
  buy legs only and need rewording.

## Related

- [[docs/adr/085-belgian-tax-point-in-time-fx|ADR-085]]
- [[docs/adr/216-server-owned-domain-calculations|ADR-216]] (dashboard statements superseded)
- [[docs/adr/217-belgian-tax-figures-on-the-server|ADR-217]]
- [[docs/api/belgian-tax]]
- [[docs/features/portfolio-tax]]
- [[docs/reference/belgian-tax-rule-matrix]]
- [[docs/adr/index|All ADRs]]
