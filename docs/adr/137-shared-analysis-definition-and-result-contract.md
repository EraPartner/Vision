---
title: ADR-137 - Shared Analysis Definition and Result Contract
type: adr
status: Accepted
date: 2026-09-12
tags:
  [adr, architecture, analysis, contract, lineage, versioning, money, timezone]
description: Define one versioned, runtime-validated contract for manual, SQL, spreadsheet, chart, and AI-assisted financial analyses.
aliases:
  [shared analysis contract, analysis result contract, analysis definition]
---

# ADR-137: Shared Analysis Definition and Result Contract

## Status

Accepted

## Date

2026-09-12

## Context

Vision already has financial calculations, saved charts, research-provider results, and AI tool
envelopes. None of these contracts can describe one analysis across manual visual queries, custom
SQL, formulas, assumptions, grids, charts, and optional AI assistance. In particular, they do not
jointly express row grain, effective scope, source and metric versions, missing coverage,
pagination, truncation, or row-level provenance.

Without a shared contract, each future surface could silently apply different transfer, refund,
currency, time, or portfolio rules. A chart could also treat a returned page as the full result,
or a saved definition could be overwritten when a refreshed result becomes incompatible.

## Decision

`@vision/types/analysis` owns the provider-neutral runtime and TypeScript contract. Version 1 has
two top-level documents:

- an immutable analysis definition, identified by `definitionId` and a monotonically increasing
  `definitionVersion`; and
- an immutable execution result that points to that exact definition identity and records its own
  `runId`.

Definitions declare logical datasets and their schema versions. Their source is either a bounded,
typed `visual-plan` or verbatim-text-preserved `custom-sql`. Visual selections, join-path identifiers,
filters, grouping, and ordering are structured data rather than executable fragments. Editing
generated SQL creates a custom-SQL source; an unsupported visual conversion is explicit data and
never causes the SQL or its visual origin to be discarded. Parameter bindings use explicit
JavaScript UTF-16 code-unit ranges. This keeps casts, comments, quoted strings, and dollar-quoted bodies opaque instead of
trying to parse advanced SQL with a regular expression. The future binder validates and substitutes
only those declared ranges.

Definitions also declare typed parameters, editable assumptions, versioned calculations,
presentation bindings, expected result columns, and reporting-scope parameters. Decimal and money
values use normalized decimal strings without exponent notation, redundant trailing fractional
zeros, or negative zero. The contract does not use JavaScript floating-point numbers for persisted
financial values. Money may use a literal currency or the reporting-currency parameter. Percentage
units state whether their value is a ratio or a percent.

Results record:

- executor, snapshot, source, dataset, metric, and formula-language versions;
- effective parameters and assumptions;
- reporting currency, application timezone, and inclusive date range;
- column types, units, row grain, rows, and lineage;
- explicit complete, paged, or truncated result windows; and
- complete, partial, unknown, or unavailable coverage with warnings.

Lineage either names bounded source records or provides an opaque drill-through token for an
aggregate whose contributing set is too large to enumerate. Source identities can include provider,
version, as-of time, URI, content hash, and passage identity. Dataset and dimension coverage record
missing ratios and source evidence. Missing fund weight, foreign-exchange fallbacks, unavailable
providers, or missing document passages therefore remain explicit facts. Consumers must not
renormalize or invent missing data.

`checkAnalysisResultCompatibility` validates definitions and results without mutating either one.
It fails closed on definition drift, dataset-schema drift, effective-input or reporting-scope drift,
missing or changed calculation results, missing or changed columns, incompatible units, unreadable
status, or incomplete data required by a presentation. Additive, unreferenced columns remain
compatible.

Contract, definition, dataset, metric, formula, executor, and source versions are independent. A
refresh creates a new run; it never mutates a frozen prior run. Persistence remains owned by the
future saved-analysis capability.

This decision deliberately does not select a SQL runtime, create database tables, add an API, or
claim that current Statistics, Saved Charts, Research, or AI Chat already consume the contract.

## Financial Semantics Boundary

The contract records, but does not recalculate, canonical domain meaning:

- ledger expenses are negative and income or refunds are positive;
- transfers remain balance movements and are excluded from spending unless an analysis explicitly
  selects another documented metric;
- money calculations use decimal arithmetic and half-even rounding;
- timestamps use Coordinated Universal Time `Z` notation while business-day grouping uses
  `APP_TIMEZONE`; dates are not timezone-shifted;
- portfolio flows use transaction-date foreign exchange, current holdings use current foreign
  exchange, and any fallback remains visible;
- partial sales use the configured canonical cost-basis replay; and
- broker partitions must reconcile to the same global portfolio engine.

Dataset and metric owners remain responsible for producing those semantics. The shared result
contract makes their version and coverage inspectable.

## Consequences

- Manual, SQL, grid, chart, formula, and AI paths can share one result without sharing privileged
  execution access.
- Saved definitions and prior usable results survive incompatible refreshes.
- Future executors must provide explicit scope, completeness, lineage, and version evidence.
- The strict runtime schema rejects unknown or malformed fields. Breaking changes require a new
  contract version.
- Version 1 is intentionally bounded. It does not promise general Excel compatibility, arbitrary
  host code, or automatic conversion of advanced SQL into visual blocks.
- Zod becomes a direct dependency of `@vision/types`, matching the version already used by both
  application workspaces.

## Acceptance Evidence

The backend fixture catalog contains ten distinct definitions and results covering the reference
budgeting, portfolio, research, and cross-mode questions. Tests also prove structured visual plans,
custom SQL parameter and verbatim text preservation, paired visual/custom results, typed inputs, formula and
metric results, source lineage, missing coverage, row-window consistency, compatibility failure on
scope/version/schema/unit/completeness drift, and non-mutation of frozen inputs.

See [[docs/reference/analysis-contract|Analysis Contract Reference]] for the exact vocabulary and
validation rules.

## Related

- [[docs/adr/index|All ADRs]]
- [[docs/reference/analysis-contract|Analysis Contract Reference]]
- [[docs/reference/typescript-types|TypeScript Types]]
- [[docs/features/statistics|Statistics]]
- [[docs/features/saved-charts|Saved Charts]]
- [[docs/features/research|Research]]
- [[docs/features/ai-chat|AI Chat]]
- [[docs/security/ai-data-access|AI Data Access]]
