---
title: ADR-101 - Admin DB data editor (raw table view/edit)
type: adr
status: accepted
date: 2026-06-18
tags: [adr, admin, database, maintenance, data-editor, audit, security, adr-026]
description: Add a JetBrains-style table browser/editor to the admin DB Maintenance UI — browse, filter, sort, and edit/insert/delete rows with changes committed straight to PostgreSQL behind admin auth, optimistic concurrency, a constraint-aware safety model, and a committed-SQL audit trail.
aliases: [db data editor, raw table editor, admin sql data grid]
---

# ADR-101: Admin DB data editor (raw table view/edit)

## Status
Accepted — 2026-06-18.

## Context

The admin **DB Maintenance** page ([[docs/features|features]], `apps/frontend/src/pages/DbMaintenancePage.tsx`)
was read-only: per-table planner stats (live/dead rows, size, last vacuum) plus a VACUUM action. There
was no way to inspect or correct row-level data without an external SQL client (psql, JetBrains
DataGrip). For a self-hosted single-operator app, a built-in JetBrains-style table editor — double-click
a table, then browse/filter/sort/edit with commits going back to the DB — removes that dependency.

The hazard is that a raw data editor **bypasses the app's domain logic by design**. Vision has no central
server-side validation layer (no Zod/Joi on the backend); invariants live partly in PostgreSQL DDL
(~445 FK / CHECK / NOT NULL / UNIQUE constraints) and partly in scattered repository/service code. A raw
write therefore still honors every *structural* constraint Postgres enforces, but skips app-level rules,
computed/derived values, cascade side-effects, and materialized-view refreshes.

## Decision

Add three admin endpoints (mounted under the existing `/api/admin` middleware stack — admin Bearer auth,
CSRF guard, rate limiter; see [[docs/adr/026-unified-api-response-envelope|ADR-026]]) backed by a new
`services/dbEditor.js`, plus a `/admin/db/:table` page:

- `GET /api/admin/database/tables/:table/schema` — columns + discovered primary key (composite-aware).
- `GET /api/admin/database/tables/:table/rows` — paginated, sortable, filterable reads.
- `POST /api/admin/database/tables/:table/mutate` — batch insert/update/delete; `dryRun` returns the SQL.

**Safety model:**

- **Identifier allowlisting.** Table names are validated against `pg_stat_user_tables`; column names
  against `information_schema.columns`. Identifiers are double-quoted, never interpolated raw. Values are
  always parameterized — reusing the pattern already proven by the VACUUM endpoint.
- **Read-only reads.** Browse/filter/sort run inside a `BEGIN; SET TRANSACTION READ ONLY; SET LOCAL
  statement_timeout` block. Filtering is done exclusively through the structured, parameterized
  `filters[]` path (column allowlisted, operator whitelisted, value bound as a parameter).

  > **Addendum (2026-07-10): raw-WHERE escape hatch removed.** The original design offered a raw
  > `where` string, guarded only by rejecting `;`. That guard was insufficient and the field was a
  > blind-SQLi timing oracle: because the read is a **GET** (exempt from the CSRF guard's safe-method
  > check), a cross-site page could issue it, and `pg_sleep()` inside the WHERE made response *timing*
  > a boolean channel over the whole schema — CORS does not stop a timing side-channel. A bare `--`
  > also silently truncated the ORDER BY/LIMIT/OFFSET past the `;` check. The raw `where` param is
  > gone; `readRows` now returns 400 for any `where`, and the UI exposes only the per-column
  > structured filters. The earlier claim that "a hostile WHERE clause can neither mutate nor hang the
  > database" was true only for those two vectors and missed the read/timing exfiltration entirely.
- **Optimistic concurrency via `xmin`.** Each row carries its PostgreSQL `xmin` (row version) as a hidden
  token. On commit, the row is locked `FOR UPDATE` and its current `xmin` compared to the token the client
  loaded; a mismatch (or a vanished row) is a `409 Conflict`, never a silent overwrite. This implements the
  chosen "detect changes underneath you" guarantee more robustly than comparing serialized cell values,
  which is fragile for JSON/timestamp/numeric columns.
- **All-or-nothing batches.** A commit runs the whole change set in one transaction; any failure rolls
  back everything.
- **Friendly constraint errors.** PostgreSQL SQLSTATEs (`23502/23503/23505/23514/22P02/…`) are mapped to
  typed `ValidationError`/`ConflictError` so the UI shows "Column X cannot be empty" instead of a raw code.
- **Audit trail (dual sink).** Every committed statement is written to a new `db_editor_audit` table
  (table, op, pk, before/after images, statement, timestamp) **inside the same transaction** as the change,
  and also emitted on the structured logger.
- **Tables without a primary key** are read-only for writes.

**Frontend.** `pages/admin/TableDataEditorPage.tsx` is a controlled grid on the existing `ui/table`
primitives (no new dependency): click-to-sort headers, per-column filters + a raw WHERE box, click-to-edit
cells with a NULL toggle and boolean checkboxes, add-row / mark-delete affordances. Edits accumulate as
highlighted dirty state; a **Preview** dialog shows the exact SQL (server-rendered dry-run) before
**Commit**. Filtering/sorting/paging are paused while uncommitted changes exist, so edits are never
silently dropped by a refetch.

## Consequences

**Positive.** Built-in row inspection/repair without an external SQL client; safe-by-construction reads;
no silent clobbering; an auditable trail of every manual edit; automatic dashboard freshness (below).

**Negative / risks.** Direct writes still bypass app-level domain logic — the operator can create states
the app's own code paths would reject. Mitigated by: admin gating, the SQL preview, the audit trail, and
PostgreSQL's own structural constraints (which remain fully enforced). The `db_editor_audit` table is
itself editable through the tool (acceptable for a single-operator, admin-gated deployment).

**Auto-refresh of materialized views (implemented).** The dashboard materialized views
(`mv_monthly_summary`, `mv_category_totals`, `mv_cashflow_daily`, `mv_bank_balances`) derive from
`transactions`, `recipients`, and `categories`. After a successful commit to any of those base tables the
service calls the existing debounced `scheduleRefresh()` (materializedViewService), so edits don't leave
the dashboard stale. Edits to other tables don't touch the views and skip the refresh.

**Domain-constraint enforcement (explored; partially implemented).** Full app-level validation on raw
edits is **not** implemented because there is no single backend schema to apply — invariants are spread
across PostgreSQL DDL and ad-hoc repository/service code. What *is* enforced today: every structural
constraint Postgres owns (FK/CHECK/NOT NULL/UNIQUE), surfaced as friendly errors. Closing the remaining
gap would mean one of: (a) routing edits for known domain tables through their existing repository/service
write paths instead of generic SQL (highest fidelity, large surface, only covers tables with such paths);
(b) introducing a declarative per-table validation schema the editor consults before commit (new shared
artifact to build and keep in sync); or (c) a post-commit invariant-check pass that warns on violations.
Each is a sizeable follow-up tracked separately rather than folded into this change.

## Related
- [[docs/adr/026-unified-api-response-envelope|ADR-026: Unified API response envelope]]
- [[docs/reference/api-endpoint-matrix|API endpoint matrix]]
- [[docs/adr/index|All ADRs]]
