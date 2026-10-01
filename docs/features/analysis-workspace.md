---
title: Analysis Workspace
type: feature
status: active
date: 2026-10-01
updated: 2026-10-01
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

The workspace uses full-width Data, Prepare, Calculate and Present sections. Data holds the source
configuration. After a successful explicit Run, focus moves to Present, which appears directly below
Data. Sorting and paging do not move focus to the result heading. A successful explicit Run collapses the
source editor and optional tools so the result stays prominent. Prepare and Calculate live in the
closed-by-default Refine this analysis disclosure after the results; collapsing it preserves all inputs.
Their section links open the disclosure. Save/library panels share the bottom area instead of reserving
an empty side column. Selected preparation operations, formula scope and scenario tasks include short
contextual guidance. Missing prerequisites and conflicting output names explain what to correct.

1. Choose a ledger dataset or Current positions, Current cost basis, Portfolio/Broker valuation history, Stored dated exchange rates, or Benchmark price history.
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

## Guided calculations and repeatable preparation

The workbench edits named formulas and assumptions without JSON. Formula rows show their name and
scope; one editor expands at a time, with technical identifiers under a separate disclosure. A searchable
field picker inserts into the active expression and returns focus there. Select row or summary scope,
insert fields/functions, inspect the live preview, and apply the calculation. Errors include the
formula identifier and row. Saved definitions retain derived formulas. Monetary fields carry a fixed
currency or a result-column currency reference; omitted provenance blocks arithmetic. Quantity
fields require investment identity. Money/quantity aggregates with unavailable contributors are
withheld. Result completeness includes transformation errors and unavailable values, independently
of pagination. Previews, saved refresh, charts and workbook provenance retain that coverage. Ratios of like money units are dimensionless.

Functions include IF, COALESCE, ABS, ROUND, calendar helpers, SUM/AVERAGE/MIN/MAX/COUNT,
COUNTIF/SUMIF, MEDIAN, sample STDEV/VARIANCE, and NPV/PV/FV/PMT. NPV discounts the first supplied
cash flow at period one; annuity functions use periodic rates and default to end-of-period payments, with an explicit beginning-of-period option. Financial
arguments and iteration counts are bounded; errors are explicit.

Preparation starts with Add preparation step and reveals the selected operation. Required fields must
be chosen before a step can be queued; queue summaries use readable operation and field names.
Preparation queues typed conversion, many-to-one lookup/merge, schema/unit-compatible append,
calculated columns, pivot and unpivot. Imported CSV/XLSX values have a type preview. Joins reject
row multiplication and can require all rows to match. Imported column-based currency and
instrument units are remapped to their selected output columns; the matching scope column must
also be imported. New output identifiers cannot overwrite existing columns. Lineage records step counts, unmatched rows
and source hashes. Refresh starts from the source snapshot, so applying the same queue twice does
not append twice. Population transforms require the full first page. Limits: 32 steps, 1,000 rows,
128 columns and 2 MiB output. Up to five imported tables have 1,000 rows and 32 columns each.

Time comparisons have day/week/month/quarter/year buckets, prior period, prior year, rolling
average and cumulative columns. Choose sum, average or last. Stock valuations require last and
broker history requires account grouping. Missing periods may remain null or become zero;
present unavailable values remain null. Weeks start on Monday; calendar boundaries use UTC date
arithmetic without shifting source calendar dates. Complete input is required.

Compare scenarios, Explore a variable, and Find a target are separate selected tasks. The second
sensitivity value list appears only when a second variable is selected; switching tasks retains inputs.
Named scenarios copy and edit assumption sets and display outcomes side by side. One/two-variable
sensitivity uses explicit value lists. Goal Seek uses lower/upper bounds, tolerance and a finite
iteration cap; convergence, unbracketed targets and failures are reported. These operations modify
only analysis inputs, never the ledger. Scenario evaluations use the same preparation and time
pipeline as formula previews and saved refresh.

## Excel workbook interchange

XLSX exports Results, typed Assumptions, Provenance, Formula definitions and Summary results.
The Summary results sheet contains the evaluated summary formula identifiers and exact values. Dates use the Excel
1900 calendar; values above 15 significant digits remain text to preserve precision. Formula
expressions remain text and are never executed. Provenance records units, source identifiers,
result-window completeness and static refresh instructions. Export reflects the displayed window;
refresh in Vision and export again.

Attachment names and row counts precede their expandable previews. Matching uses visible Result field
and Imported field labels and retains existing saved column choices when updated. Upload controls have
visible keyboard focus.

Import supports value snapshots produced by Vision, restores identifiers from provenance, and
rejects formula cells and unsupported ZIP compression. This is not an arbitrary Excel round trip.
Excel desktop opening remains a native verification task; independent workbook-reader fixtures
check value/type reconciliation in portable tests.

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
- Pivot has independent Rows, Columns, Values and Filters, up to three hierarchy levels per axis
  and eight measures. Row groups expand and collapse independently. Rows, column groups and values have explicit
  ordering controls, and hierarchy labels use the selected language. Column depth controls the
  visible column hierarchy. Values
  include server-computed row totals and percentage of partition total. Click a cell for bounded
  contributing records. Currency and investment partitions survive every subtotal. SQL pivot
  levels share one database statement (1,000 grouped output rows); canonical financial pivots reuse
  one source snapshot (1,000 rows per level and 4,000 across levels). Oversized pivots fail explicitly.
- Chart offers grouped/stacked bar, line, scatter and waterfall, persisted X and multiple series,
  unit-labelled axes, coverage counts and an accessible exact-value table. It requires a complete
  first page. Missing values remain gaps; waterfall rejects missing values. Currency and quantity
  scope must be compatible. Plot geometry uses numbers; the grid and export retain exact values.
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
produce visible formula errors. Numeric zero is false in `IF`. A row error clears only the affected cell and reports its zero-based row index; consumed failed dependencies also fail, including summaries. The UI shows the errors and does not chart missing values as zero. On incomplete result windows, aggregate formulas and calculations consuming their errors are withheld while independent row calculations remain available. Unit-aware monetary aggregates reject contributing rows with different currencies using `MIXED_CURRENCIES`; quantity aggregates likewise require one instrument. Counts and dimensionless ratios may span currencies. Conditional sums may select one currency. Fixed or column-based units preserve provenance when a result omits the original currency field. Untyped custom SQL retains a conservative currency guard; explicitly declared units are required to resolve omitted or renamed metadata.
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
Spreadsheet-formula prefixes are neutralized. CSV and XLSX exports are blocked after query,
preparation, calendar, formula, assumption or scenario-input edits until a successful rerun.
Exports use the inputs captured with that result. A cached saved result requires a fresh run before
export because its exact calculation input snapshot is not available. XLSX preserves formula
definitions as text; it does not round-trip executable formulas.

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

Opening a saved analysis restores its chart kind, X binding and selected series. Missing or stale
bindings are checked against returned columns and receive compatible defaults. Without a cached result, stored axis choices are preserved until the next run can check
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

- [[docs/adr/175-bounded-analysis-workbench|ADR-175: Bounded Analysis Workbench]]

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

Run shows an in-progress label and respects reduced-motion preferences. Saved refresh, restore,
proposal application and deletion show pending feedback beside the saved-analysis area and prevent
duplicate submissions. Failures keep the current draft and expose a local retry explanation. Opening
another analysis invalidates older query, refresh and save completions so they cannot replace the new
document. Saved-operation results also preserve edits made while the request is pending. Deleting the selected definition keeps its visible draft available as a new analysis.

Formula label and scope share a responsive row. Empty row formulas can start from a real numeric
result field with an editable reference, avoiding examples that refer to unavailable fields.
Formula previews show pending feedback, support retry after failure and ignore obsolete responses.
Stale sources suspend previews until rerun. Empty preparation and formula sections omit inactive
Apply controls; entered configuration remains mounted when tools are collapsed.

A query-input signature marks displayed results as needing an update after the query changes. The warning remains through a failed rerun and clears after a successful run for the current query. Calculation and preparation edits also mark exports as needing a new run. Unsaved analysis
metadata alone does not change the calculation result.

The workspace provides task guidance alongside its templates. Advanced SQL controls use a disclosure that stays open while SQL mode is active; full editing remains available.


## Presentation controls

Pivot axes explain their roles; incomplete setup, changed configuration, empty results and failed
builds provide a next step. Failure details remain expandable. Empty charts show guidance instead of
empty axes. Long field and formula labels wrap, and pivot controls stack until wide layouts.


Charts use aligned labeled controls and shared selection styling. Dates and scale ticks follow the
application display preferences; tooltips and chart-data tables preserve exact localized decimal values.
Pivot axes list selected fields first, with searchable Add field controls and explicit reorder/remove
actions. Selecting a field or pressing Escape returns focus to the corresponding Add field control.
Scenario result tables scroll at narrow widths, and solver details remain expandable below the outcome.
