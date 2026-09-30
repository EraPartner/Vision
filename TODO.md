# TODO

Vision's live implementation queue. Completed findings and earlier planning remain in Git history
and the relevant project docs.

## Queue contract

- `- [ ]` means open. Revalidate the current code before implementing it.
- Remove completed findings after verification; this file is not an archive.
- Put evidence or a blocker on an indented `Tracking:` line. Do not put history in the title.
- Every finding has one owner-sized outcome.
- `🔎 verified-present YYYY-MM-DD` means the issue was reproduced on that date.
- `🔎 partial YYYY-MM-DD` means only the stated remainder is open.
- `🔎 decision-needed YYYY-MM-DD` means implementation waits for a product or data decision.
- `🔎 runtime-unverified YYYY-MM-DD` means source work is complete but a live environment check is
  still required.
- `🔎 needs-GitHub-check YYYY-MM-DD` means the current platform state must be read from GitHub.

Run `bun run todo:list` for the concise queue and `bun run todo:check` for ledger hygiene.

## Findings

### Analysis capability roadmap

Deliver these as separate, reviewed changes. The target is practical Excel-level financial analysis
without SQL or JSON for common workflows; AI remains optional. Completed correctness fixes belong
in the analysis documentation, not as checked-off history here.

- [ ] **Verify analysis correctness in the native Demo and disposable PostgreSQL** 🔼
  - Tracking: 🔎 runtime-unverified 2026-09-30. Verify currency-separated totals, raw holdings labels, complete-result pagination, formula cell errors and withheld partial summaries, signed charts, and every displayed chart row. The previous Demo review stopped at Starting Vision; local browser health access was denied. Rebuild the Demo after these changes and verify synthetic data only. Reconcile totals against independently computed fixture values. Focused tests, typecheck and workspace lint pass; production compilation passes to a temporary output directory because clearing the existing dist/assets is denied. Refresh existing analyses after correcting any newly rejected currency scope.
  - ↪ _from: [[docs/features/analysis-workspace|Analysis Workspace]] correctness review_

- [ ] **Build configurable complete-result pivots** 🔼
  - Tracking: 🔎 verified-present 2026-09-30. Replace the fixed two-group, first-measure pivot with explicit Rows, Columns, Values and Filters; support multiple measures, totals, subtotals, hierarchy expansion, percentage of total and drill-through. Aggregate on the server over the complete filtered population and preserve currency/instrument boundaries. Acceptance: monthly category spending and share of total without SQL or JSON.
  - ↪ _from: [[apps/frontend/src/pages/AnalysisWorkspacePage.tsx]] PivotTable_

- [ ] **Replace formula JSON with a guided formula editor** 🔼
  - Tracking: 🔎 verified-present 2026-09-30. Add autocomplete, field references, function help, live previews and cell-level errors; support reusable derived measures and selected financial/statistical functions with defined semantics. Carry units and currency provenance through formulas, including results that omit a currency column, rather than relying on the current mixed-currency row guard. Acceptance: create and debug a savings-rate calculation without JSON.
  - ↪ _from: [[apps/frontend/src/pages/AnalysisWorkspacePage.tsx]] formulas and assumptions controls_

- [ ] **Add reusable time comparisons to visual analysis** 🔼
  - Tracking: 🔎 verified-present 2026-09-30. Support day/week/month/quarter/year buckets, previous-period and year-over-year comparisons, rolling averages, cumulative totals and explicit missing-period handling. Acceptance: compare category spending with the prior year without SQL and with calendar-correct period boundaries.
  - ↪ _from: [[apps/node-backend/src/services/analysisCatalog.js]] visual time fields_

- [ ] **Expose canonical financial datasets and unit-aware measures** 🔼
  - Tracking: 🔎 verified-present 2026-09-30. Add current positions, cost basis, valuation history, returns, dated currency conversion and benchmark data through the approved catalog. Reuse canonical portfolio replay and rate logic; distinguish native currency, reporting currency and missing-rate coverage. Raw event sums must remain explicitly separate from position and performance measures.
  - ↪ _from: [[docs/reference/analysis-datasets|Analysis Datasets]] catalog boundary_

- [ ] **Expand analysis chart types and series controls** 🔽
  - Tracking: 🔎 verified-present 2026-09-30. Add line, grouped/stacked bar, scatter and waterfall charts, multiple series, explicit units and meaningful axes. Persist bindings and show data coverage. Acceptance: compare income, spending and net cash flow over time with no silent omissions or cross-currency comparisons.
  - ↪ _from: [[apps/frontend/src/pages/AnalysisWorkspacePage.tsx]] chart result view_

- [ ] **Add named scenario comparison and sensitivity analysis** 🔽
  - Tracking: 🔎 verified-present 2026-09-30. Replace raw assumption-value JSON with named input sets, side-by-side outcomes and one/two-variable sensitivity tables. Add bounded Goal Seek with explicit convergence/failure reporting after deterministic scenarios work. Scenario changes must never mutate ledger data.
  - ↪ _from: [[docs/features/analysis-workspace|Analysis Workspace]] formulas and scenarios_

- [ ] **Add repeatable analysis data preparation** 🔽
  - Tracking: 🔎 verified-present 2026-09-30. Provide typed import previews, conversion, lookup/merge, append, calculated columns and pivot/unpivot steps with refresh and lineage. Validate cardinality and unmatched rows; expand beyond the current small one-key CSV attachment only with explicit resource limits.
  - ↪ _from: [[apps/frontend/src/features/analysis/AnalysisInterchangePanel.tsx]] scenario inputs_

- [ ] **Add typed Excel workbook interchange** 🔽
  - Tracking: 🔎 verified-present 2026-09-30. Export XLSX results, assumptions and provenance on separate sheets with exact numeric/date handling and completeness metadata. Define supported formula export/import and refresh behavior explicitly; do not imply arbitrary Excel workbook round trips. Acceptance: open a workbook in Excel and reconcile values and types with Vision.
  - ↪ _from: [[apps/frontend/src/features/analysis/analysisInterchange.ts]] CSV-only export_
