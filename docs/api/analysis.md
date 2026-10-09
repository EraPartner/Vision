---
title: Analysis API
type: endpoint
status: active
date: 2026-10-09
tags: [api, analysis, sql, query-builder, saved-analysis]
description: Catalog, compile, bounded execution, cancellation, drill-through, and versioned saved-analysis operations under /api/analysis.
path: /api/analysis
methods: [GET, POST, PUT, DELETE]
aliases: [analysis endpoints, saved analysis API]
---

# Analysis API

All operations use the standard response envelope. The mounted group also uses the aggregation rate
limiter. This is an additive API introduced with [[docs/adr/144-isolated-manual-analysis-workspace|ADR-144]].

| Method   | Path                                  | Purpose                                                       |
| -------- | ------------------------------------- | ------------------------------------------------------------- |
| `GET`    | `/api/analysis/catalog`               | List approved datasets, fields, measures, and safe joins      |
| `POST`   | `/api/analysis/compile`               | Compile and normalize a visual plan without executing it      |
| `POST`   | `/api/analysis/pivot`                 | Complete-source hierarchy, subtotals and percentages          |
| `POST`   | `/api/analysis/extensions/evaluate`   | Preparation, time comparisons and isolated scenario evaluation |
| `POST`   | `/api/analysis/execute`               | Run a visual plan or custom SQL with row/byte/time limits     |
| `POST`   | `/api/analysis/cancel/:requestId`     | Cancel a running query through a same-role PostgreSQL session |
| `POST`   | `/api/analysis/drill`                 | Resolve one grouped row to a bounded source-record page       |
| `GET`    | `/api/analysis/saved?workspace=`      | List the saved-analysis library                               |
| `POST`   | `/api/analysis/saved`                 | Create definition version 1                                   |
| `GET`    | `/api/analysis/saved/:id`             | Read the current version and last usable result               |
| `PUT`    | `/api/analysis/saved/:id`             | Append an immutable definition version                        |
| `POST`   | `/api/analysis/saved/:id/run`         | Refresh and persist success or failure                        |
| `POST`   | `/api/analysis/saved/:id/ai-proposal` | Ask local AI for a typed preview without applying it          |
| `GET`    | `/api/analysis/saved/:id/versions`    | List immutable definition versions                            |
| `POST`   | `/api/analysis/saved/:id/restore`     | Restore an old definition as a new version                    |
| `POST`   | `/api/analysis/formulas/evaluate`     | Evaluate bounded formulas without ledger writes               |
| `POST`   | `/api/analysis/ai-proposals/preview`  | Inspect a version-bound AI edit                               |
| `POST`   | `/api/analysis/ai-proposals/apply`    | Apply the inspected edit with conflict detection              |
| `DELETE` | `/api/analysis/saved/:id`             | Delete one saved analysis and its private history             |

## Request validation

Each route parses its params, query, and body with a zod schema before any analysis work runs
([[docs/adr/193-zod-runtime-contracts|ADR-193]]). A malformed request returns
`400 VALIDATION_ERROR`. The schemas check the request envelope: every field a handler reads has a
checked type. The catalog compiler, executor, and formula and extension engines still own semantic
rules, such as allowed datasets, operators, and row limits.

- A visual plan needs a string `datasetId`. `fields`, `groups`, `measures`, and `joins` are string
  arrays. `filters` entries need string `fieldId` and `operator`, with a scalar `value`. `orderBy`
  entries need `id` and a `direction` of `asc` or `desc`. `limit` is a number and
  `reportingCurrency`, `from`, `to`, `symbol`, `range` and `costBasisMethod` are strings; `null`
  for any of them means the same as leaving it out. Unknown plan keys are kept.
- `/execute` accepts `mode: "visual"` with a `plan`, or an omitted `mode` or `mode: "sql"` with a
  string `sql`. Any other `mode` returns `400`. Custom SQL `columns` need string `id` and `type`.
- `/pivot` and `/drill` need a visual `plan`. `/formulas/evaluate` needs a `rows` array of objects.
  `/extensions/evaluate` needs one of the six `operation` values and a `rows` array.
- `/cancel/:requestId` rejects an id outside the `requestId` pattern with `400` instead of
  reporting `not-running`.
- `GET /saved?workspace=` accepts `budgeting`, `portfolio`, `research`, `cross-workspace`, or an
  empty value for all workspaces. Any other value returns `400`.
- `POST /saved` needs `name`, `workspace`, and `querySpec`. `PUT /saved/:id` needs `querySpec`.
  A `querySpec` is `{ mode: "visual", plan }` or `{ mode: "sql", sql, datasetIds }`.
  `refreshMode` is `live` or `frozen`.
- `/restore` needs positive integer `version` and `expectedVersion`. `/ai-proposal` needs an
  `instruction` of 1–2,000 characters after trimming. When the local model fails, returns invalid
  JSON, or returns a proposal outside the edit contract, `/ai-proposal` answers
  `502 BAD_GATEWAY` (it used to be `400`). A proposal that fails the saved analysis preview is
  still `400`.
- `/ai-proposals/preview` and `/apply` validate the whole typed proposal before the service runs:
  `schemaVersion: 1`, `savedAnalysisId`, `baseVersion`, `rationale`, and 1–30 `operations`.
  Unknown keys return `400`.

A database connection, resource, or network failure is a server fault. It now returns `500` instead
of a `400` rejection. This covers SQLSTATE classes `08`, `53`, `57P`, `58`, and `XX`, and socket
errors such as `ECONNREFUSED`. Query cancellation (`57014`) still returns `408`.

## Execution contract

`requestId` is 8–128 ASCII letters, digits, underscores, or hyphens. Visual execution receives a
catalog plan. Custom SQL receives `sql`, declared `datasetIds`, scalar `values`, and declared result
columns. Page limits are clamped to 1–1,000 rows; results above two megabytes are explicitly
`truncated`. PostgreSQL cancellation or timeout returns `408 ANALYSIS_CANCELLED_OR_TIMED_OUT`.
Rejected SQL returns `400 ANALYSIS_EXECUTION_REJECTED`; a PostgreSQL character position is included
when available.

Visual plans reject money sums without selected currency grouping or a single-currency equality
filter, and event unit sums without selected investment grouping or a single-investment equality
filter. These are intentionally stricter validations: existing unsafe plans now return 400 until
edited. Measure identifiers remain stable; holdings labels now describe raw totals.
Visual `limit` is a page size, not an inner SQL cap. SQL authors remain responsible for units,
currency conversion and explicit SQL limits.

Formula evaluation accepts optional `inputComplete` (default true). Saved and cloud-plan execution
set it from the result window; aggregate formulas on incomplete input return `INCOMPLETE_INPUT`
errors rather than page-only summaries. Errors carry `formulaId`, `code`, `message`, and optional
zero-based `rowIndex`. A failed cell does not clear other rows. Consumed failed references produce
`DEPENDENCY_ERROR`. Numeric aggregates reject mixed contributing `currency` values with `MIXED_CURRENCIES`; result units identify literal, parameter or result-column currency. Missing scope returns CURRENCY_PROVENANCE_REQUIRED; missing financial contributors withhold aggregates. Quantity arithmetic checks investment identity. Formula result columns are included in saved result metadata.

## Workbench extensions

`/execute` accepts `workbench`, `formulaModel` and `scenarioModel`. Fresh and saved runs apply
validated attachment joins, repeatable preparation, calendar comparisons and formulas in that order.
`parameters.workbench`, `pivotConfig`, `financialPlan` and chart bindings are version snapshots.
A source result accompanies transformed results for repeatable previews. Partial financial coverage
or transformation/formula errors persist a partial run rather than a completed run.

`/pivot` receives `{plan, config:{rows,columns,values,filters}, requestId}`. SQL levels use one
restricted statement. Financial levels reuse one canonical source snapshot. Every total aggregates
original source values; average totals are never sums of averages. Partition percentages are exact
decimal ratios. Output exposes population completeness separately from financial coverage.

`/extensions/evaluate` receives operation `prepare`, `time`, `scenarios`, `sensitivity`, `goal` or
`formulas`, typed rows/columns and `complete`. Formula dispatch combines this flag with window and transformation coverage before setting `inputComplete`.
Formula responses return the transformed column schema, inferred formula units, overall `complete`,
coverage and lineage. Pagination remains separate from value completeness.
The optional `workbench` pipeline runs before formula/scenario operations. Preparation and calendar comparison each run once before formula/scenario evaluation.
Steps/time/scenarios are bounded pure functions. No ledger or portfolio history writes occur. Oversized output and
partial population operations return validation errors; Goal Seek reports convergence explicitly.

Service dataset plans additionally accept reportingCurrency/from/to/symbol/range/costBasisMethod.
Current positions reject historical date parameters. History reads stored snapshots; benchmark
history fetches price points through the existing research aggregator. Benchmark returns are
based on the first positive close within `from`/`to`, before other field filters. Stock measures
aggregate closing observations per currency and broker account, while unavailable history
contributors still produce partial coverage. Arbitrary SQL remains
limited to approved views; service dataset markers are not executable SQL.

## Persistence contract

Saved inputs contain `name`, `workspace`, `querySpec`, `parameters`, formulas, assumptions, charts,
`sourceReferences`, and `refreshMode`. `PUT` never edits a definition row. It inserts the next
version and advances the library pointer. `expectedVersion` prevents overwriting a concurrent manual
edit. Formula refresh uses decimal arithmetic and preserves explicit formula errors as a partial
result. Each version snapshots the matching parameters, formula assumptions, chart bindings, source
references, and refresh mode. Restore and AI apply also append versions; neither mutates history.

`parameters.scenarioModel` may hold up to five typed CSV attachments. Each attachment is limited to
1 MB, 1,000 rows, and 32 columns and records normalized values plus a SHA-256 digest. Joins name one
result column and one scenario column explicitly. Saved refresh applies deterministic left joins
before formulas and rejects duplicate scenario keys. Safe CSV export is a client-side value export
of the current result window; it is not a new API operation.

## Related

- [[docs/adr/175-bounded-analysis-workbench|ADR-175]]

- [[docs/api/index|API Documentation]]
- [[docs/features/analysis-workspace|Analysis Workspace]]
- [[docs/reference/analysis-contract|Analysis Contract Reference]]
- [[docs/reference/analysis-datasets|Analysis Datasets]]
- [[docs/api/ai-research|AI Research API]]
