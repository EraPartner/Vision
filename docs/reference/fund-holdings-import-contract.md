---
title: Fund Holdings Import Contract Reference
type: reference
status: active
date: 2026-09-12
tags: [reference, portfolio, funds, holdings, import, provenance]
description: Version-1 source document and parser result rules for user-supplied fund holdings.
aliases: [fund holdings source contract, holdings file contract]
related_code:
  - packages/types/src/fundHoldings.js
  - packages/types/src/fundHoldings.d.ts
  - apps/node-backend/tests/fundHoldingsContract.test.js
---

# Fund Holdings Import Contract Reference

> [!abstract] Purpose
> `@vision/types/fund-holdings` is the strict normalization boundary for future fund-holdings
> importers. Version 1 supports user-supplied files. It does not download issuer data, persist
> imports, aggregate exposure, or grant permission to copy or redistribute source material.

## Supported Source Boundary

The supported source kind is `user-supplied-file`. The user deliberately supplies a file for their
own portfolio workflow. A document records the provider and source URL when known, but those fields
are provenance only.

Automatic iShares retrieval and redistribution are unsupported pending an applicable permission or
agreement. A public holdings page or working download URL establishes technical availability, not
reuse rights. Import adapters must not turn that availability into an automatic retrieval feature.

## Exports

| Export                           | Purpose                                              |
| -------------------------------- | ---------------------------------------------------- |
| `FUND_HOLDINGS_CONTRACT_VERSION` | Current strict contract version, currently `1`       |
| `FUND_HOLDING_IDENTIFIER_TYPES`  | Canonical identifier vocabulary                      |
| `fundHoldingsDocumentSchema`     | Normalized holdings document runtime validator       |
| `fundHoldingsImportResultSchema` | Parser/import outcome and structured issue validator |
| `FundHoldingsDocument`           | TypeScript normalized document declaration           |
| `FundHoldingsImportResult`       | TypeScript parser/import result declaration          |

## Document Identity and Source

`fund` and `shareClass` are separate identities. Both require a name and at least one identifier.
The share class also requires its three-letter currency. Supported identifier types are `isin`,
`ticker`, `sedol`, `cusip`, `lei`, and `proprietary`. Tickers may carry an exchange; other
identifier types may not. Identifiers are unique within an identity, and constituent identifiers
are unique across holding rows.

The source records:

- the original file name and optional provider and URL;
- the holdings `asOfDate` and UTC `retrievedAt` time; and
- license status, redistribution status, and optional terms URL and note.

License and redistribution fields preserve the import-time decision. They are not an authorization
mechanism. Unknown or restricted terms stay explicit.

## Holding Rows

Every row records its source row number and optional sheet name. This provenance is retained after
normalization so parser errors and later drill-through can point back to the supplied file.

Each row includes a name, typed identifiers, instrument type, exposure kind and status, decimal
weight percentage, and optional currency and country. Non-cash rows require an identifier. Cash may
have no security identifier, but it must be an explicit source row.

Weights are non-negative canonical decimal strings between 0 and 100 with at most 12 fractional
digits. Exponent notation, trailing fractional zeroes, and JavaScript floating-point values are not
part of the wire contract.

Version 1 supports `direct` and `cash` exposure. `nested-fund`, `derivative`, `synthetic`, and
`unknown` exposure must use `exposureStatus: unsupported` and provide `unsupportedReason`.

## Coverage and Staleness

Coverage separately records reported, supported, unsupported, and missing weight percentages. The
following invariants are enforced exactly with scaled integer decimal arithmetic:

- reported weight equals the sum of all holding rows;
- supported and unsupported weights equal their respective row sums;
- reported plus missing weight equals 100; and
- coverage is `complete` only when unsupported and missing weights are both zero.

A consumer must display unsupported and missing weight. It must not scale supported rows to 100.

Staleness records an evaluation date, maximum accepted age in days, source age in days, and status.
The status is `stale` when age exceeds the configured maximum. Stale data is accepted as historical
input, but consumers must not present it as current.

## Import Results and Errors

An import result is `imported`, `partial`, or `rejected`. Input, accepted, and rejected row counts
must reconcile. Imported results cannot contain errors or rejected rows. Partial results require a
validated document plus errors for rejected rows. Rejected results require errors and cannot carry
a document. Whenever a document is present, the accepted count must equal its normalized holding
row count and the result file name must match the document source file name.

Issue codes cover invalid files and identities, invalid or duplicate identifiers, invalid weights
and totals, stale or partial data, unsupported exposure, license restrictions, unmapped columns,
and unsupported formats. An issue can retain the source row, field, and bounded raw value. Raw
values must not contain secrets or unrelated personal data.

## Version 1 Non-goals

- automatic issuer retrieval or scheduled refresh;
- redistribution of issuer holdings;
- a universal issuer-column mapping;
- recursive nested-fund expansion;
- derivative or synthetic look-through;
- inferred cash or renormalized partial coverage; and
- persistence, portfolio matching, or exposure aggregation.

These need separate design and acceptance work. A source becoming technically reachable does not
change this boundary.

## Related

- [[docs/adr/139-fund-holdings-source-and-import-contract|ADR-139: Fund Holdings Source and Import Contract]]
- [[docs/features/portfolio|Portfolio]]
- [[docs/features/portfolio-import|Portfolio Import]]
- [[docs/reference/analysis-contract|Analysis Contract Reference]]
