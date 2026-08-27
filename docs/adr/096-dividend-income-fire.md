---
title: ADR-096 Dividend/Coupon Income & FIRE Coverage (descriptive)
type: adr
date: 2026-06-18
updated: 2026-08-27
tags: [adr, portfolio, dividend, coupon, income, fire, coverage-ratio, statistics, descriptive, adr-044, adr-073]
description: Surface projected + realized investment income and a FIRE coverage ratio (passive yield vs spending run-rate) as portfolio-workspace statistics that READ budgeting numbers but never feed Planned Transactions or the cash-flow forecast.
aliases: [dividend income, coupon income, FIRE, coverage ratio, passive yield]
---

# ADR-096: Dividend/Coupon Income & FIRE Coverage (descriptive)

## Status
Deferred

Deferred on 2026-08-27. No route or user-interface caller exists, so
`portfolioIncomeService` remains an isolated prototype with focused unit tests rather than a
shipped feature. Resume this proposal only through a new implementation batch that wires the
endpoint and user interface and revalidates the inputs and boundaries below.

## Date
2026-06-18

## Context

Investment income (dividends, coupons/interest, rent) is already computed per investment inside
the portfolio summary (`buildInvestmentSummaryCore` → `totalDividends` / `totalInterestPaid` /
`totalRent`; fixed-income `projectedAnnualInterest`). What's missing is a **portfolio-level** view
of income and a **FIRE coverage ratio** — passive yield vs spending run-rate. The hard
constraint: this is **descriptive**. It must NOT feed Planned Transactions or the cash-flow
forecast; it reads budgeting's spending number but never writes back.

## Decision

Two portfolio-workspace statistics, both pure aggregations over data that already exists:

- **Income** = realized (Σ over holdings of `totalIncome` = dividends + interest + rent for the
  period) + **projected annual** (Σ over holdings of declared yield: `projectedAnnualInterest`
  for fixed-income; `current_price × units × dividend_yield` for unit-based when a yield is
  known). Reuses the ADR-073 math + the ADR-044 single summary; no new persistence.
- **FIRE coverage ratio** = `annualPassiveIncome / annualSpending`, where `annualSpending` is the
  spending run-rate **read** from the budgeting aggregates (e.g. trailing average monthly spending
  × 12). Coverage ≥ 1 means passive income covers spending. Pure function of the two inputs.

**Boundary (enforced by placement):** these live in a portfolio-statistics service and surface in
the portfolio workspace only. They are NOT added to the Planned Transactions ingest, the
cash-flow forecast inputs (ADR-081/forecast), or any write path. Budgeting is read-only here.

## Consequences

**Positive**
- A clear "are my investments covering my spending yet?" number, reusing existing math.
- No new storage; no risk of polluting the forecast (descriptive-only by construction).

**Negative / cost**
- Projected income needs a yield input per holding; absent a yield, projection contributes 0
  (realized still shown).

**Risks / mitigations**
- *Leaking into the forecast* → kept in a portfolio-stats service, never wired to forecast/planned
  inputs; this ADR records the boundary explicitly.
- *Double-counting income vs the cash sleeve* → income here is descriptive yield, not a ledger
  movement; the dividend's cash leg (ADR-090) is the ledger side and is separate.

## Related
- [[docs/adr/index|All ADRs]]
- [[docs/adr/044-portfolio-summary-single-source-of-truth|ADR-044: Portfolio Summary]]
- [[docs/adr/073-shared-portfolio-math|ADR-073: Shared Portfolio Math]] (income + projectedAnnualInterest)
- [[docs/adr/081-research-analytics-forecasting|ADR-081]] (forecast — deliberately NOT fed by this)
