---
title: Analysis Workspace
type: feature
status: active
date: 2026-09-30
updated: 2026-09-30
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

The default example groups non-transfer active cash flow by month, category, and currency. Join IDs come from
the catalog; raw join expressions are not accepted. Sorting reruns the server query rather than
sorting only the loaded page. For a single total across the filtered dataset, select measures such
as Count or Sum with no fields or groups. The compiler omits `GROUP BY` for this form while
retaining filters and ordering on the selected measures.

The start panel also offers three ordinary, editable templates over the same synthetic-data-safe
catalog: category spending, monthly cash flow, and portfolio activity. Applying a template copies
its visual plan into the normal builder and collapses the editor into a summary of the dataset,
columns, measures, filter count and row limit. Run remains visible. Focus moves to Edit configuration,
which reveals the full editable plan. Blank starts, saved-analysis loads and failed runs open the
editor. Export and scenario-file options use their own disclosure. Templates do not create a special
execution mode or lock fields.
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

- Table, Chart and Pivot are keyboard-accessible result tabs within one surface; Table opens first. Chart-axis choices survive tab changes. Pivot explains its requirements when unavailable, and the outdated-query warning remains visible in every view.
- Catalog choices and recognized result columns use readable English or Dutch labels in the builder,
  table, chart selectors, and pivot. Custom column aliases remain unchanged. Display labels do not
  replace the identifiers used by queries, sorting, drill-through, saved definitions, or CSV exports.
- Numeric table, chart, and pivot values use the selected number-format separators while preserving
  the available decimal precision. Identifiers and text remain literal; display formatting does not
  round or modify the underlying result or export values.
- The grid pages through server results and shows whether more rows exist or a byte limit truncated it.
- Header sorting reruns visual SQL with the selected order. Saving, reopening, and refreshing a
  visual analysis retain that order.
- Drill-through uses the selected group values as typed filters.
- A pivot requires exactly two groups and uses the first measure only when the complete result is loaded and the query is current. It never silently collapses additional currency or investment groups.
- A bar chart uses chosen result columns only when the complete result is loaded. It renders all numeric, non-missing rows with negative values left of zero and positive values right of zero. Mixed-currency results must be filtered to one currency before charting. Its selectors
  are labelled **Category axis** and **Value axis**; the value selector offers only numeric
  columns. Results without a numeric column show an explanation instead of an empty chart.
- A failed run leaves the last usable result visible with an explicit error.

Visual money sums require currency grouping or an explicit equality filter for one currency. The reporting-currency preference does not convert amounts. Raw event unit sums also require investment grouping or a single-investment filter. Holdings event totals are explicitly raw sums, not net positions or canonical portfolio replay. Existing unsafe saved visual plans must be edited before rerunning.

Visual limits are page sizes, applied by the executor rather than an inner SQL limit; the extra-row probe can therefore report more available data. User-authored SQL may still define its own limited population and arithmetic.

These rules prevent a loaded page from being presented as a whole-population chart or pivot.
Calendar-date results stay `YYYY-MM-DD` strings without a timezone conversion; timestamp results
remain ISO datetime strings.

## Formulas and scenarios

Saved analyses can add calculated row columns, summary formulas, named assumptions, and separate
scenario values. Vision evaluates them with decimal arithmetic and a bounded expression language.
Arithmetic, comparisons, conditionals, date operations, and conditional aggregates are supported.
Dependencies are ordered explicitly; cycles, broken references, null/type errors, and resource caps
produce visible formula errors. Numeric zero is false in `IF`. A row error clears only the affected cell and reports its zero-based row index; consumed failed dependencies also fail, including summaries. The UI shows the errors and does not chart missing values as zero. On incomplete result windows, aggregate formulas and calculations consuming their errors are withheld while independent row calculations remain available. Numeric aggregate formulas reject contributing rows with different `currency` values using `MIXED_CURRENCIES`; counts remain available and conditional sums may select one currency. This conservative guard also blocks non-money numeric aggregates across currencies. It cannot infer units when custom SQL omits or renames currency metadata.
The language has no JavaScript, macros, file access, network access,
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

Opening a saved analysis restores valid bar-chart column choices. Missing or stale choices fall
back independently to the first result column for categories and the first numeric column for
values. Without a cached result, stored axis choices are preserved until the next run can check
them against the returned columns. Opening the analysis also returns its result paging to the
beginning.

**Version history** shows a loading state while fetching. An empty history or one containing only
the current version displays **No earlier versions**. Failed requests display an error rather
than leaving the action without feedback. A response for an analysis or version that is no longer
selected cannot replace the current history or error state.

## Operational boundary

`DATABASE_URL_ANALYSIS` must name `vision_analysis_executor`, use the same database as
`DATABASE_URL`, and provide its password. When omitted, the server derives that URL from the runtime
URL by replacing the username. The native runtime additionally requires the same host and port.

Native startup provisions the login and its password through the private cluster administrator in
`packaging/electron/runtime/native.js`. It reapplies the restricted role attributes, read-only
default, timeouts, and `vision_analysis, pg_catalog` search path. The migration owner remains
`NOCREATEROLE`; it does not administer executor credentials.

After migrations succeed, backend startup calls `analysisRoleBootstrap.js` through
`DATABASE_URL_MIGRATIONS` when available. A restricted owner checks the existing login's attributes
before resetting relation grants. The grant set contains six approved views: `transactions_v1`,
`transactions_v2`, `accounts_v1`, `holding_events_v1`, `cash_flows_v1`, and `cash_flows_v2`.
Running this pass after migrations includes newly created or replaced views. A privileged bootstrap
connection can still provision the role directly for standalone backend deployments.

A missing role without role-creation privileges, unsafe existing attributes, or failed grant pass
produces a bootstrap warning and degraded result. This does not prevent the rest of Vision from
starting. See [[docs/guides/native-macos-runtime|Native macOS Runtime Guide]] for native diagnostics.

## Related

- [[docs/features/index|Features]]

- [[docs/features/analysis-monitors|Analysis Monitors]]
- [[docs/api/analysis|Analysis API]]
- [[docs/reference/analysis-contract|Analysis Contract Reference]]
- [[docs/reference/analysis-datasets|Analysis Datasets]]
- [[docs/adr/144-isolated-manual-analysis-workspace|ADR-144]]
- [[docs/adr/149-cloud-authored-catalog-analysis-plans|ADR-149]]
- [[docs/features/portfolio|Portfolio]]

## Template selection

The template chooser closes after selecting a template, starting a blank analysis, or loading a saved analysis. Choose a template reopens it without discarding the current draft. Analysis name and optional source references have visible labels; optional source references sit in a disclosure. Saving is a secondary action with guidance to run and review first. Visual and SQL expose their selected state.

## Task-focused guidance and hierarchy

The builder explains columns versus totals and counts, including the explicit Group by requirement. Result guidance identifies the last completed run and asks users to rerun after editing; it does not imply automatic updates or SQL drill-through.

## Clarity and recovery feedback

A query-input signature marks displayed results as needing an update after the query changes. The warning remains through a failed rerun and clears after a successful run for the current query. It concerns query inputs, not unsaved analysis metadata.

The workspace provides task guidance alongside its templates. Advanced SQL controls use a disclosure that stays open while SQL mode is active; full editing remains available.
