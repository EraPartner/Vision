---
title: Analysis Workspace
type: feature
status: active
date: 2026-09-19
updated: 2026-09-19
tags:
  [
    feature,
    analysis,
    query-builder,
    sql,
    spreadsheet,
    formulas,
    saved-analysis,
    ai,
  ]
description: Visual and SQL analysis over approved financial datasets, with bounded formulas, isolated assumptions, inspectable optional AI edits, reusable versions, pivots, charts, and drill-through.
aliases: [manual analysis, visual query builder, SQL workspace]
related_code:
  - apps/frontend/src/pages/AnalysisWorkspacePage.tsx
  - apps/node-backend/src/routes/analysis.js
  - apps/node-backend/src/services/analysisExecutor.js
  - apps/node-backend/src/services/savedAnalysisService.js
---

# Analysis Workspace

> [!abstract] Purpose
> `/analysis` lets a user query Vision data without AI. Visual, SQL, grid, pivot, chart, and saved
> analysis paths share the same approved datasets and bounded executor.

## Visual workflow

1. Choose Transactions, Accounts, Holding events, or Cash flows.
2. Select fields and measures. Every selected field must be grouped when a measure is present.
3. Add typed filters, ordering, and the published many-to-one account join when needed.
4. Run the plan and inspect the generated SQL.
5. Double-click a grouped result to read at most 100 contributing source records.

The default example groups non-transfer active cash flow by month and category. Join IDs come from
the catalog; raw join expressions are not accepted. Sorting reruns the server query rather than
sorting only the loaded page.

The start panel also offers three ordinary, editable templates over the same synthetic-data-safe
catalog: category spending, monthly cash flow, and portfolio activity. Applying a template copies
its visual plan into the normal builder. It does not create a special execution mode or lock fields.
The SQL editor and run-preference overrides live under progressive advanced controls; loading,
failure, and empty catalog states are explicit.

## SQL workflow

The SQL editor accepts one PostgreSQL `SELECT` or `WITH` statement. Users declare the approved
datasets it references and enter scalar `$1`, `$2`, and later values as a JSON array. Dataset and
column buttons provide local schema help. PostgreSQL window functions, aggregates, common table
expressions, and approved joins remain available. Writes, arbitrary tables, file access, extension
escape, and network escape are rejected independently by SQL validation and database privileges.

Running custom SQL records a local ten-query history. Editing generated SQL changes the saved source
to `custom-sql`; the original saved visual definition remains an immutable earlier version, and a
compatible visual origin is retained when the result shape is unchanged.

## Result transformations

- The grid pages through server results and shows whether more rows exist or a byte limit truncated it.
- Header sorting reruns visual SQL with the selected order.
- Drill-through uses the selected group values as typed filters.
- A pivot uses the first two groups and first measure only when the complete result is loaded.
- A bar chart uses chosen result columns only when the complete result is loaded.
- A failed run leaves the last usable result visible with an explicit error.

These rules prevent a loaded page from being presented as a whole-population chart or pivot.

## Formulas and scenarios

Saved analyses can add calculated row columns, summary formulas, named assumptions, and separate
scenario values. Vision evaluates them with decimal arithmetic and a bounded expression language.
Arithmetic, comparisons, conditionals, date operations, and conditional aggregates are supported.
Dependencies are ordered explicitly; cycles, broken references, null/type errors, and resource caps
produce visible formula errors. The language has no JavaScript, macros, file access, network access,
or ledger writes. Scenario values remain analysis parameters and never mutate transactions.

Version 1 tabular scenario inputs accept CSV files up to 1 MB, 1,000 rows, and 32 columns. Vision
stores the inferred column types, normalized values, file digest, and one explicit result-column to
input-column left join per attachment in saved-analysis parameters. It never evaluates imported
cells as formulas. Unsafe integers remain exact text. Duplicate input join keys and multiple joins
for one attachment are rejected. Save and execution both require the result join column to exist
with a compatible declared type. Joined columns use the attachment ID as a prefix and are applied
before bounded analysis formulas during saved refresh.

Safe CSV export contains the current result values plus definition and run identity, workspace and
dataset scope, source references, source-date columns, column types, timezone, and truncation
metadata. It labels column units as unavailable when the executor did not return them. It preserves
values as returned and does not relabel or convert them to the preferred reporting currency.
Vision snapshots this export context when a result is produced or loaded, so later editor changes
cannot relabel an older result.
Spreadsheet-formula prefixes are neutralized. Version 1 intentionally does not export XLSX or
round-trip formulas.

## Preference precedence

Reporting currency, benchmark, answer depth, and language resolve per field in this order:
run parameters, saved-analysis settings, application defaults, then product defaults. The effective
values are visible in the analysis and investigation interfaces. Reporting timezone remains an
explicit run and saved-analysis parameter, with the browser timezone used for a new analysis.
Benchmarks are optional and explicit; Vision does not infer a benchmark or risk preference from
holdings.

## Saved analyses

The library is filtered by Budgeting, Portfolio, Research, or explicit cross-workspace scope. Save
stores the strict ADR-137 definition, scalar parameters, chart binding, source references, refresh
mode, and a new immutable version. Refresh records a run and either advances the last-successful-run
pointer or retains the old result with a failure state. Delete removes only that saved analysis and
its private versions and runs.

Definition versions also snapshot their formula model, scenario values, chart bindings, source
references, and refresh mode. Restoring an older version creates a new version, so undo never erases
history. A local model can propose a typed edit against the current version. The UI shows the exact
before/after document; applying it requires a separate action and a stale base version is rejected.
Users can continue editing and saving with AI unavailable.

## Operational boundary

`DATABASE_URL_ANALYSIS` must name `vision_analysis_executor`, use the same database as
`DATABASE_URL`, and provide its password. When omitted, the server derives that URL from the runtime
URL by replacing the username. Provisioning uses `DATABASE_URL_MIGRATIONS` when available.

## Related

- [[docs/features/analysis-monitors|Analysis Monitors]]
- [[docs/api/analysis|Analysis API]]
- [[docs/reference/analysis-contract|Analysis Contract Reference]]
- [[docs/reference/analysis-datasets|Analysis Datasets]]
- [[docs/adr/144-isolated-manual-analysis-workspace|ADR-144]]
- [[docs/adr/149-cloud-authored-catalog-analysis-plans|ADR-149]]
- [[docs/features/portfolio|Portfolio]]
