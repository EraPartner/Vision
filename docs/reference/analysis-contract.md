---
title: Analysis Definition and Result Contract Reference
type: reference
status: active
date: 2026-09-12
tags: [reference, analysis, contract, lineage, versioning, datasets, money]
description: Exact version-1 shapes, invariants, compatibility rules, and acceptance fixtures for shared Vision financial analyses.
aliases:
  [
    analysis contract reference,
    analysis definition schema,
    analysis result schema,
  ]
related_code:
  - packages/types/src/analysis.js
  - packages/types/src/analysis.d.ts
  - apps/node-backend/tests/analysisContract.test.js
  - apps/node-backend/tests/fixtures/analysis/referenceQuestionsV1.js
---

# Analysis Definition and Result Contract Reference

> [!abstract] Purpose
> `@vision/types/analysis` defines the neutral boundary shared by future manual, SQL,
> spreadsheet, chart, and AI-assisted analysis surfaces. It validates data shape and compatibility;
> it does not execute queries, calculate financial metrics, persist runs, or grant data access.

## Exports

| Export                               | Purpose                                                        |
| ------------------------------------ | -------------------------------------------------------------- |
| `ANALYSIS_CONTRACT_VERSION`          | Current strict contract version, currently `1`                 |
| `ANALYSIS_WORKSPACES`                | Budgeting, Portfolio, Research, and cross-workspace vocabulary |
| `ANALYSIS_VALUE_TYPES`               | Contract-safe logical scalar types                             |
| `analysisDefinitionSchema`           | Strict runtime validator for saved definitions                 |
| `analysisExecutionResultSchema`      | Strict runtime validator for immutable execution results       |
| `checkAnalysisResultCompatibility()` | Non-mutating, fail-closed consumer compatibility check         |
| `AnalysisDefinition`                 | TypeScript declaration paired with the runtime schema          |
| `AnalysisExecutionResult`            | Discriminated TypeScript result declaration                    |

## Definition Version 1

An analysis definition contains:

- contract and definition identity;
- one workspace and one or more versioned logical datasets;
- a `visual-plan` or `custom-sql` source;
- typed parameters, calculations, and editable assumptions;
- presentation bindings and their required columns;
- an expected result-column contract; and
- parameter references for reporting currency, application timezone, and inclusive date range.

Dataset declarations include an authorization scope. That label does not grant access by itself;
the future executor must enforce the authenticated user's rows independently.

### Source modes

`visual-plan` records typed field or metric selections, catalog-approved join-path IDs, typed
filters, output-ID grouping and ordering, an optional limit, and optional generated SQL. It never
uses raw join or filter expressions. `custom-sql` records PostgreSQL text, referenced datasets and
parameters, and whether visual conversion is supported. Each binding names a declared parameter and
the exact JavaScript UTF-16 code-unit range containing its `:parameter` placeholder. SQL text is otherwise opaque and
preserved verbatim, including casts, comments, quoted strings, and dollar-quoted bodies. A saved visual
origin may accompany edited SQL, but consumers must not pretend advanced SQL can round-trip.

### Money and scalar values

The wire vocabulary includes strings, integers, decimals, booleans, dates, UTC datetimes, and
three-uppercase-letter currency codes. Decimal and money values are normalized strings without
exponent notation, leading integer zeros, redundant trailing fractional zeros, or negative zero.
Scale is a maximum fractional precision. A money unit declares either a literal currency or a
currency parameter. A percentage declares whether values are ratios (`0.0842` means 8.42%) or
percent values (`8.42` means 8.42%). Financial calculations can declare half-even rounding.

### Referential integrity

Runtime validation rejects:

- duplicate dataset, parameter, calculation, assumption, presentation, or column identifiers;
- source datasets or SQL parameters not declared by the definition;
- unknown calculation dependencies;
- reporting parameters not declared by the definition; and
- typed reporting parameters with missing or incorrect roles;
- calculation/result-column version, type, or unit mismatches; and
- presentation bindings or requirements that do not exactly resolve to result columns.

## Execution Result Version 1

A result points to the exact definition ID and version. It records status, UTC timestamps, executor
identity, query mode, snapshot consistency, effective inputs, reporting scope, dataset revisions,
metric and formula results, coverage, and status-dependent data.

Completed and partial results require a completion time and data. Failed and cancelled results
require a completion time and explicit error, and cannot carry data. Queued or running results cannot
carry terminal fields.

### Rows, grain, and lineage

The result schema declares stable columns and one row grain. Every row must contain exactly the
declared columns, and every value must match its logical type and nullability.

Row IDs and row-grain tuples are unique. Grain keys must name declared columns. Each row has one or
more lineage entries using declared datasets:

- `records` enumerates a bounded set of stable source entity IDs; or
- `opaque` provides a bounded drill-through token and reason when full enumeration would be unsafe
  or impractical.

Record and opaque lineage can carry provider, source/version, as-of time, URI, content hash, and
passage identity. The token is an executor-owned reference. It is not authority and must be checked
again when used.

### Coverage and result windows

Coverage is `complete`, `partial`, `unknown`, or `unavailable`, overall, per dataset, and for named
dimensions such as provider availability, fund weight, or foreign-exchange fallback. Entries can
carry a missing ratio and source evidence. Warnings identify declared columns. Missing data stays
missing; consumers do not infer or renormalize it. A `complete` entry cannot carry a positive
missing ratio.

The result window is explicitly one of:

- `complete`, with a total row count;
- `page`, with offset, limit, optional total, and `hasMore`; or
- `truncated`, with returned rows, the enforced limit, optional total, and a reason.

This prevents a chart or pivot from presenting a loaded page as the complete population.

## Compatibility Rules

`checkAnalysisResultCompatibility(definition, result)` returns `{ compatible: true }` or a list of
stable reasons. It rejects:

- malformed inputs;
- definition ID or version drift;
- unreadable result status;
- dataset schema-version drift;
- missing, unknown, mistyped, or contradictory effective inputs and reporting scope;
- missing, failed, or version-drifted calculations;
- missing expected columns;
- changed column type, nullability, or unit; and
- partial, paged, or truncated input when a presentation requires completeness.

The function parses into new values and never edits the supplied definition or result. Callers keep
the saved definition and last usable result when a refresh is incompatible.

## Reference Fixtures

The fixture catalog covers ten acceptance questions:

1. category change with transfers and refunds;
2. recurring versus discretionary costs;
3. contract comparison with editable assumptions;
4. portfolio total return versus cash income;
5. fund overlap with explicit uncovered weight;
6. hypothetical contribution without ledger writes;
7. filing-version comparison with cited passages;
8. evidence linked to a position or budget topic;
9. contradictory and unavailable research sources; and
10. cross-mode custom SQL preservation and refresh compatibility.

The fixtures use distinct budgeting, portfolio, holdings, filing, evidence, provider, and
cross-workspace datasets. They assert comparison rows, missing-weight ratios, source passages,
contradictory sources, unavailable providers, and paired visual/custom results. They prove the
contract can represent and reject drift for the questions. They do not claim that an executor,
dataset catalog, saved-analysis repository, or user interface is implemented.

## Ownership Boundaries

- `@vision/types/analysis` owns vocabulary, runtime validation, and compatibility.
- Dataset owners define and test financial meaning.
- The future restricted executor owns authorization, resource limits, and query execution.
- The future saved-analysis service owns definition and run persistence.
- Presentations own rendering but cannot weaken completeness or compatibility checks.
- AI can propose inspectable definitions but receives no privileged execution path.

## Related

- [[docs/adr/137-shared-analysis-definition-and-result-contract|ADR-137]]
- [[docs/adr/index|Architecture Decisions]]
- [[docs/reference/typescript-types|TypeScript Types]]
- [[docs/features/statistics|Statistics]]
- [[docs/features/saved-charts|Saved Charts]]
- [[docs/features/research|Research]]
- [[docs/features/ai-chat|AI Chat]]
- [[docs/security/ai-data-access|AI Data Access]]
