---
title: ADR-139 - Fund Holdings Source and Import Contract
type: adr
status: Accepted
date: 2026-09-12
tags: [adr, portfolio, funds, holdings, import, provenance, licensing]
description: Establish user-supplied files as the supported fund-holdings baseline and define strict identity, coverage, provenance, and import-result contracts.
aliases: [fund holdings contract, holdings import contract]
---

# ADR-139: Fund Holdings Source and Import Contract

## Status

Accepted

## Date

2026-09-12

## Context

Portfolio exposure analysis needs constituent weights below a fund position. A downloadable issuer
page proves that a file is available, but it does not establish permission to automate retrieval,
retain every version, or redistribute the contents. The iShares individual-site terms include
restrictions on copying and distributing site material. Vision has no separate issuer agreement
that overrides those terms.

Fund files also differ in identity fields, weight units, dates, cash representation, derivative
rows, and completeness. Accepting a file without an explicit contract could match the wrong share
class, present stale data as current, renormalize a partial file to 100%, or imply unsupported
look-through for synthetic exposure.

## Decision

The version 1 supported baseline is a file deliberately supplied by the user. Vision may parse and
store that file for the importing user's own portfolio workflow. Automatic iShares retrieval and
redistribution are unsupported until an applicable permission or agreement has been reviewed and
recorded. Public page availability is not treated as permission.

`@vision/types/fund-holdings` owns two strict runtime and TypeScript contracts:

- `fundHoldingsDocumentSchema` validates one normalized source document; and
- `fundHoldingsImportResultSchema` records an imported, partial, or rejected parser result with
  stable issue codes and row-level errors.

An import result is tied to its normalized document: `accepted` equals the number of normalized
holding rows, and the result file name equals the document source file name. A successful envelope
cannot therefore overstate accepted rows or detach the holdings from their stated provenance.

Each document identifies both the fund and its exact share class. Identities require at least one
typed identifier. The source records the original file name, optional provider and URL, holdings
as-of date, retrieval time, and explicit license and redistribution status. These fields describe
provenance; they do not grant rights.

Every constituent row retains its source row and optional sheet name. Non-cash rows require an
identifier. Cash is a supported explicit holding and is never inferred from a remainder. Weights
are canonical decimal percentage strings with up to 12 fractional digits. The reported weight must
equal the row sum, supported and unsupported weights must reconcile to their rows, and reported
plus missing weight must equal 100.

Direct holdings and cash are supported by version 1. Nested funds, derivatives, synthetic
exposures, and unknown exposure types must be marked unsupported with a reason. Any unsupported or
missing weight makes coverage partial. Consumers must display that weight and must not renormalize
the supported portion.

Staleness records the evaluation date, configured maximum age, computed age, and current or stale
status. A stale file remains valid data with a visible warning; it is not silently refreshed.

This decision defines a normalized contract and parser outcome. It does not implement a file
picker, a CSV/XLSX parser, database persistence, issuer-specific column mappings, scheduled
retrieval, exposure aggregation, or a user interface.

## Consequences

- A future importer has one fail-closed boundary for identity, weights, coverage, provenance, and
  errors.
- Fund exposure can keep cash, unsupported instruments, missing weight, and stale dates visible.
- User-supplied files work without depending on an issuer API or a redistribution right.
- Each issuer format still needs a reviewed adapter or explicit column mapping before ingestion.
- Automatic iShares retrieval remains blocked on permission, even if its download URL is
  technically accessible.
- A future contract version is required before nested-fund, derivative, or synthetic look-through
  can be described as supported.

## Acceptance Evidence

The focused backend contract suite covers a complete file, share-class identity, row provenance,
cash, stale and partial inputs, duplicate identifiers, malformed and inconsistent weights,
derivative and synthetic exposure, and rejected parser results with row errors.

See [[docs/reference/fund-holdings-import-contract|Fund Holdings Import Contract Reference]] for
the exact vocabulary and invariants.

## Related

- [[docs/adr/index|All ADRs]]
- [[docs/reference/fund-holdings-import-contract|Fund Holdings Import Contract Reference]]
- [[docs/adr/137-shared-analysis-definition-and-result-contract|ADR-137: Shared Analysis Definition and Result Contract]]
- [[docs/features/portfolio|Portfolio]]
