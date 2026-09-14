---
title: ADR-150 - Explicit portfolio look-through exposure
type: adr
status: Accepted
date: 2026-09-14
tags: [adr, portfolio, exposure, funds, holdings, provenance, decimal]
description: Aggregate direct and supported fund holdings only from explicit classifications and exact share-class identifiers while preserving uncovered weight.
aliases: [portfolio look-through, portfolio exposure aggregation]
---

# ADR-150: Explicit portfolio look-through exposure

## Status

Accepted

## Date

2026-09-14

## Context

ADR-139 defined a strict user-supplied fund-holdings document, but deliberately stopped before
persistence, portfolio matching, and aggregation. Portfolio users need issuer, sector, and
issuer-country exposure that combines directly held securities with supported fund constituents.
Ticker guesses, name matching, weight renormalization, or currency-based foreign-exchange inference
would make the result appear more complete than its sources justify.

## Decision

Vision stores explicit security classifications and version-1 fund-holdings documents in two
additive tables. A classification targets either an investment ID or one typed identifier. A fund
document is attached to one investment only when the supplied share-class identifier exactly occurs
in that document's validated share-class identity and the target is an existing ETF investment.
Imports upsert matching sources and do not delete omitted sources.

The exposure service multiplies each fund position value by each supported constituent weight with
decimal arithmetic. It combines those values with direct classified positions for issuer, sector,
and issuer-country views. Each row and coverage bucket reports its effective percentage of total
portfolio value. Missing document weight, unsupported rows, and missing reported weight
remain uncovered. Missing classifications remain unclassified. Explicit cash rows remain separate.
Neither uncovered weight nor supported rows are scaled to 100 percent. Economic foreign-exchange
exposure is out of scope and is not inferred from security or currency metadata.
The service re-evaluates each document's age against the current portfolio computation date rather
than trusting its import-time status. Fund contributions expose the source as-of date.

## Consequences

- Every classified amount has a direct investment or fund-source drill-through path.
- Partial and stale source documents remain visible instead of silently appearing complete.
- Users must supply classifications; Vision does not guess issuers, sectors, or countries.
- Recursive funds, derivatives, synthetic exposure, automatic issuer downloads, XLSX round-trips,
  and economic foreign-exchange exposure remain future work.

## Related

- [[docs/adr/index|All ADRs]]
- [[docs/features/portfolio|Portfolio]]
- [[docs/api/investments|Investments API]]
- [[docs/reference/fund-holdings-import-contract|Fund Holdings Import Contract Reference]]
- [[docs/adr/139-fund-holdings-source-and-import-contract|ADR-139]]
