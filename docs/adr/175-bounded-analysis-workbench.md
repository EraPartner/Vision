---
title: Bounded Analysis Workbench
type: adr
status: accepted
date: 2026-09-30
tags: [adr, analysis, portfolio, spreadsheet, units]
description: Extend deterministic analysis through service datasets, complete-source pivots and bounded pure transformations while preserving the restricted SQL boundary.
related_code:
  - apps/node-backend/src/services/analysisFinancialDatasets.js
  - apps/node-backend/src/services/analysisPivotService.js
  - apps/node-backend/src/services/analysisExtensions.js
  - apps/frontend/src/features/analysis/AnalysisWorkbenchPanel.tsx
---

# ADR-175: Bounded Analysis Workbench

## Status

Accepted.

## Context

The manual workspace needs practical spreadsheet analysis without requiring SQL or JSON. Raw
portfolio events cannot stand in for positions or performance. Page-based aggregation, omitted
currency metadata and partial contributors can produce plausible but incorrect numbers.

## Decision

Keep arbitrary SQL restricted to approved analysis views. Add enumerated service datasets with
safe field projections, canonical portfolio replay, stored dated FX and explicit coverage. Reuse
stored valuation history without writing snapshots. Benchmark price history uses the existing
research provider boundary with provider/methodology disclosure.

SQL pivots aggregate every hierarchy level over the full filtered source in one statement;
financial pivots reuse one canonical source snapshot. Currency and investment partitions remain
at all levels. Reject incomplete/oversized output instead of presenting partial totals.

Preparation, calendar comparison, named scenarios, sensitivity and Goal Seek are bounded pure
functions. Fresh execution, guided preview and saved refresh use the same pipeline. Saved parameter
snapshots retain workbench options, financial options, named scenarios, pivot configuration and
chart bindings. Unit metadata follows fields and formulas, including explicit result-column
currency and instrument references. Failed/missing financial contributors withhold totals.

The frontend provides guided editors, multiple chart series and typed workbook value interchange.
XLSX contains separate result/assumption/provenance/formula-definition sheets. Formula definitions
are text; import supports Vision snapshots rather than arbitrary Excel computation. No new runtime
dependency or schema migration is needed.

## Consequences

Common cash-flow and financial analyses can be configured directly. Canonical arithmetic and
source limits are independently tested. Bounded output means large pivots or sensitivity grids
must be narrowed. Workbook numbers beyond Excel precision are text. Benchmark/history methodology
is explicit; the feature does not claim dividend-adjusted benchmarks or true time-weighted returns.
Native Demo/PostgreSQL reconciliation and opening exported workbooks in desktop Excel remain
separate runtime acceptance checks, tracked in TODO until they can run.

## Related

- [[docs/adr/index|All ADRs]]
- [[docs/adr/140-versioned-analysis-datasets|Versioned Analysis Datasets]]
- [[docs/features/analysis-workspace|Analysis Workspace]]
- [[docs/api/analysis|Analysis API]]
- [[docs/reference/analysis-datasets|Analysis Datasets]]
- [[docs/reference/analysis-contract|Analysis Contract]]
