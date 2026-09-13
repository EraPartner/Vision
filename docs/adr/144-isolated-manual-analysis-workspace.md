---
title: ADR-144 - Isolated Manual Analysis Workspace
type: adr
status: Accepted
date: 2026-09-13
tags: [adr, analysis, sql, security, query-builder, persistence, spreadsheet]
description: Run manual financial analysis through a fixed least-privilege PostgreSQL role and persist immutable definitions separately from execution runs.
aliases: [analysis executor, saved analyses, manual analysis workspace]
---

# ADR-144: Isolated Manual Analysis Workspace

## Status

Accepted

## Context

ADRs 137 and 140 define the shared analysis contract and four approved datasets. They do not provide
an executor, a manual builder, or persistence. Reusing the admin database editor or the application
connection would give analysis SQL unnecessary write and table privileges. Saving only SQL text would
also lose parameters, visual origins, charts, dataset references, versions, and refresh failures.

## Decision

The backend provisions the fixed `vision_analysis_executor` login from `DATABASE_URL_ANALYSIS`. At
each boot it resets role defaults and table grants, revokes access to `public` and all unapproved
analysis relations, then grants `SELECT` on the four version-1 analysis views only. Execution uses a
dedicated two-connection pool and `BEGIN READ ONLY`, a five-second statement timeout, a one-second
lock timeout, an eight-megabyte work-memory limit, at most 1,000 returned rows, a two-megabyte result
cap, and same-role backend cancellation. SQL validation is defense in depth; database privileges are
the authority.

The visual builder compiles catalog identifiers, typed values, duplication-safe joins, groups,
measures, and sorting to inspectable PostgreSQL SQL. The same executor runs custom SQL with scalar
parameters. The UI provides dataset and column help, query history, result paging, drill-through,
complete-result-only pivots and charts, and preserves the last usable result after a failure.

Migrations 0110 creates `saved_analyses`, immutable `saved_analysis_definition_versions`, and
`saved_analysis_runs`. Library metadata stores the current version, workspace, parameters, chart
bindings, source references, refresh state, last successful run, and latest failure. A failed refresh
does not replace its last successful result. The three product workspaces are Budgeting, Portfolio,
and Research; the shared contract's explicit cross-workspace scope remains available for analyses
that intentionally join concerns.

## Consequences

- A database owner or migration role with `CREATEROLE` is needed to provision the executor. Boot is
  fail-soft, but analysis execution fails closed when the role or grants are unavailable.
- Custom SQL does not silently round-trip into visual blocks. An unchanged visual result shape may
  retain a visual origin; immutable definition versions preserve earlier saved definitions.
- The first spreadsheet slice is result-oriented. It does not add the separate typed-formula engine,
  macro execution, arbitrary JavaScript, file access, or network access.
- The new HTTP operations are additive. Existing application and admin database behavior is unchanged.

## Related

- [[docs/adr/137-shared-analysis-definition-and-result-contract|ADR-137]]
- [[docs/adr/140-versioned-analysis-datasets|ADR-140]]
- [[docs/features/analysis-workspace|Analysis Workspace]]
- [[docs/api/analysis|Analysis API]]
- [[docs/security/ai-data-access|AI Data Access]]
- [[docs/adr/index|All ADRs]]
