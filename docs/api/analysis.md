---
title: Analysis API
type: endpoint
status: active
date: 2026-09-13
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

## Execution contract

`requestId` is 8–128 ASCII letters, digits, underscores, or hyphens. Visual execution receives a
catalog plan. Custom SQL receives `sql`, declared `datasetIds`, scalar `values`, and declared result
columns. Page limits are clamped to 1–1,000 rows; results above two megabytes are explicitly
`truncated`. PostgreSQL cancellation or timeout returns `408 ANALYSIS_CANCELLED_OR_TIMED_OUT`.
Rejected SQL returns `400 ANALYSIS_EXECUTION_REJECTED`; a PostgreSQL character position is included
when available.

## Persistence contract

Saved inputs contain `name`, `workspace`, `querySpec`, `parameters`, formulas, assumptions, charts,
`sourceReferences`, and `refreshMode`. `PUT` never edits a definition row. It inserts the next
version and advances the library pointer. `expectedVersion` prevents overwriting a concurrent manual
edit. Formula refresh uses decimal arithmetic and preserves explicit formula errors as a partial
result. Each version snapshots the matching parameters, formula assumptions, chart bindings, source
references, and refresh mode. Restore and AI apply also append versions; neither mutates history.

## Related

- [[docs/api/index|API Documentation]]
- [[docs/features/analysis-workspace|Analysis Workspace]]
- [[docs/reference/analysis-contract|Analysis Contract Reference]]
- [[docs/reference/analysis-datasets|Analysis Datasets]]
- [[docs/api/ai-research|AI Research API]]
