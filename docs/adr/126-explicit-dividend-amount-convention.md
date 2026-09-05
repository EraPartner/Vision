---
title: ADR-126 Explicit Dividend Amount Convention
type: adr
status: Accepted
date: 2026-09-04
updated: 2026-09-04
tags: [adr, portfolio, belgian-tax, dividends, withholding-tax, data-quality]
description: Store whether each dividend amount is gross, net, or unknown and withhold convention-dependent tax metrics when any included row is unknown.
aliases: [adr-126, dividend-amount-convention]
---

# ADR-126: Explicit Dividend Amount Convention

## Status

Accepted

## Context

Vision stored a dividend `amount` and its withholding tax but did not say whether the amount was
before or after that tax. The frontend assumed every amount was net and added recorded tax to find
the gross base. The PDF assumed every amount was gross and subtracted tax to find the net result.
Both could produce plausible but incorrect tax figures.

Existing rows cannot be classified reliably from their values alone.

## Decision

Migration 0097 adds `portfolio_transactions.dividend_amount_convention` with the values `gross`,
`net`, and `unknown`. Existing rows and new rows without an explicit choice use `unknown`. Add and
edit dialogs expose the choice for dividend transactions, and the API validates it.

Recorded dividend amounts and withholding taxes remain visible regardless of the convention. A
gross row contributes `amount` to the gross base and `amount - taxes` to the net result. A net row
contributes `amount + taxes` to the gross base and `amount` to the net result. If any included
dividend is `unknown`, convention-dependent figures such as effective withholding rate, reclaim,
net withholding cost, and net dividend result are shown as incomplete.

## Consequences

- Tax totals no longer silently depend on contradictory gross/net assumptions.
- Legacy data is preserved without inventing a classification.
- Users must classify legacy dividend rows before convention-dependent estimates become available.
- Imports continue to create `unknown` rows unless a future parser supplies explicit provenance.

## Related

- [[docs/features/portfolio-tax|Portfolio Tax]]
- [[docs/features/belgian-tax|Belgian Tax]]
- [[docs/reference/data-model#PortfolioTransaction|PortfolioTransaction data model]]
- [[docs/adr/085-belgian-tax-point-in-time-fx|ADR-085]]
