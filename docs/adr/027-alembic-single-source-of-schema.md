---
title: ADR-027 - Alembic as Single Source of Schema Truth
type: adr
status: Accepted
date: 2026-04-21
tags: [adr, backend, database, migrations, alembic, phase-1, schema]
description: Port node-backend schemaInit.js (1021 LOC, idempotent CREATE-IF-NOT-EXISTS suite) into Alembic revisions and make Alembic the sole owner of schema DDL; node startup shells out to `alembic upgrade head`
aliases: [adr-027, alembic-port, schema-ownership, single-migration-system]
---

# ADR-027: Alembic as Single Source of Schema Truth

## Status
Accepted

## Date
2026-04-20

## Context

Vision has two parallel schema-mutation systems:

- **Alembic** — 32 revisions under `alembic/versions/` (`0001_initial_database_schema.py` → `0032_add_hot_path_indexes.py`), plus a `legacy_versions/` dir. Python migrations with `upgrade()` / `downgrade()`. Versioned via `alembic_version` table.
- **`apps/node-backend/src/database/schemaInit.js`** — 1021 LOC, idempotent `CREATE TABLE IF NOT EXISTS` + `DO $$` enum guards + index/trigger creation. Runs on every node-backend startup via `main.js:352`. Versioned via its own `schema_version` table with manual `CURRENT_SCHEMA_VERSION` bumps.

Overlap: every table owned by Alembic (`transactions`, `planned_transactions`, `investments`, `portfolio_transactions`, `exchange_rates`, 8 raw-import tables, etc.) is *also* redefined in `schemaInit.js`. The node initializer is the de-facto source of truth — changes land there first and sometimes get back-ported to Alembic, sometimes not.

Problems:

1. **Drift risk.** Two authoritative places to add a column means one gets forgotten. A fresh `alembic upgrade head` on a new DB produces a *different* schema from a schema built by node-backend boot.
2. **No rollback.** `schemaInit.js` is forward-only DDL with no `downgrade`. Rolling back a table addition requires hand-written SQL.
3. **Boot cost.** 50+ sequential `IF NOT EXISTS` queries on warm start — guarded by the `CURRENT_SCHEMA_VERSION` string, but that guard is easy to forget to bump.
4. **Migration pipeline is hand-managed.** Phase 5+ features (`batch_id`, `attachments`, `account_statements`, `notifications`, `import_templates`, `reconciliation_reports`, portfolio enum expansion) need real migrations with downgrades. Adding them to `schemaInit.js` perpetuates the drift.

Phase 1 of the perf/arch sweep requires a single schema authority before feature batches begin.

## Decision

### Ownership

**Alembic is the sole source of schema DDL.** `schemaInit.js` is deleted. `schema_version` table is dropped (Alembic's own `alembic_version` replaces it).

### Startup

The node-backend does not create or mutate schema. On boot it:

1. Shells out to `alembic upgrade head` (via `child_process.execFile`) against `DATABASE_URL`.
2. If exit code ≠ 0, node exits with a non-zero status and logs the alembic stderr. No partial-boot.
3. After migration success, calls `refreshMaterializedViews()` from `services/materializedViewService.js` (matviews are runtime artifacts, not schema — refresh on every start is cheap and correct).

```js
// apps/node-backend/src/database/migrate.js
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const run = promisify(execFile);

export async function runMigrations() {
  // Read alembic binary and config paths from environment, with sensible defaults.
  const alembicBin = process.env.ALEMBIC_BIN || 'alembic';
  const alembicConfig = process.env.ALEMBIC_CONFIG || 'config/alembic.ini';
  
  const { stdout, stderr } = await run(alembicBin, ['-c', alembicConfig, 'upgrade', 'head'], {
    cwd: REPO_ROOT,
    env: { ...process.env, PYTHONUNBUFFERED: '1' },
  });
  logger.info({ stdout, stderr }, 'alembic upgrade head complete');
}
```

`main.js:352` → `await runMigrations()` replaces `await initializeSchema()`.

#### Environment Variables

- `ALEMBIC_BIN` (default `alembic`) — Absolute or PATH-resolved path to the alembic binary. In Docker containers where alembic is installed in a venv (e.g., `/venv/bin/alembic`), this must be set.
- `ALEMBIC_CONFIG` (default `config/alembic.ini`) — Path to `alembic.ini` relative to repo root, passed to alembic via `-c`.

### Decomposition of `schemaInit.js`

Every table/enum/index/trigger currently in `schemaInit.js` that isn't already reflected in a committed alembic revision gets a new revision. Plan:

1. `alembic downgrade base` + `alembic upgrade head` on a fresh DB → dump schema (A).
2. Start fresh DB + run `schemaInit.js` end-to-end → dump schema (B).
3. `pg_dump --schema-only` diff A vs B → every missing object becomes a new alembic revision, chained after `0032`.
4. Expect revisions for: `savedCharts` columns not in `0031`, any `IF NOT EXISTS` indexes added inline, `ai_chat_tables` completeness check against `0031`, `watchlist` schema, trigger function bodies, enum value additions that landed via `DO $$` blocks.

Each diff-sourced revision gets a full `upgrade()` + `downgrade()`. No squash — preserve the chain for anyone mid-migration.

### `legacy_versions/` directory

Retained as-is. Already branch-merged into main line at `0001`. No churn.

### Dev workflow

- `bun run db:migrate` → `alembic upgrade head`
- `bun run db:migrate:down` → `alembic downgrade -1`
- `bun run db:new-migration <slug>` → `alembic revision -m <slug>`
- `bun run db:reset` → `alembic downgrade base && alembic upgrade head` (already exists; remove node-backend's `schema_version` wipe)

`docs/reference/scripts.md` updated to reflect the above.

### Python dependency at runtime

Node-backend now has a hard dependency on a Python interpreter + alembic being on PATH at runtime. Docker images already ship both (migrations were already runnable there). Electron packaging needs to bundle a Python runtime or ship pre-migrated DB snapshots for the desktop build; see consequences.

## Consequences

### Positive

- Single authoritative schema. No drift between Alembic and `schemaInit.js`.
- Every schema change ships with a tested downgrade — unlocks safer rollback for Phase 5+ feature migrations.
- `main.js` boot path shrinks — no more 50-query warm-start DDL replay; alembic's `alembic_version` check is a single `SELECT`.
- Removes 1021 LOC and the `schema_version` table/guard.
- Phase 5 migrations (`batch_id`, `attachments`, `account_statements`, `notifications`, `import_templates`, `reconciliation_reports`) land in one place.

### Negative

- Node-backend gains a runtime dependency on Python + Alembic on PATH. Docker is unaffected (already installed). **Electron desktop build must bundle a minimal Python runtime** or prebuild the DB. Follow-up ADR if the bundling strategy materially changes.
- One-time migration effort: diff `schemaInit.js` vs Alembic head and write N new revisions (expected 3–6).
- Developer onboarding now requires Python + alembic locally (already required for contributors touching migrations — now required for anyone running the backend).
- Loss of `IF NOT EXISTS` forgiveness — alembic fails hard on a dirty DB. This is the point, but it breaks the "just clone and run" path where the DB was in an ambiguous intermediate state. Mitigation: `bun run db:reset` script.

### Rollback

If Alembic-only startup destabilizes production:

1. Revert the main.js change (re-call `initializeSchema()`).
2. Restore `schemaInit.js` from git (kept in history).
3. `schema_version` table recreated on next boot by the restored code.
4. Any alembic revisions added during the port remain applied (they are a *subset* of `schemaInit.js` outputs) — no data loss.
5. Fully reversible in code; no destructive DB changes involved.

## Implementation Status

**Phase 1 Completion (2026-04-21):**

✅ `schemaInit.js` (1021 LOC) deleted  
✅ `alembic/versions/0001_initial_database_schema.py` created — baseline with 27 tables, 5 enums, 73 indexes, 13 triggers  
✅ `apps/node-backend/src/database/migrate.js` — shells out to `alembic upgrade head`, reads `ALEMBIC_BIN` and `ALEMBIC_CONFIG` env vars with sensible defaults  
✅ `apps/node-backend/src/database/migrate.js:stampBaselineIfLegacy()` — pre-upgrade hook that rewrites `alembic_version` from legacy revisions (0002–0032 moved to `alembic/legacy_versions/`) to the new `0001_initial` baseline, preserving existing schema  
✅ `apps/node-backend/src/main.js` — `initializeSchema()` replaced with `runMigrations()` + `stampBaselineIfLegacy()`  
✅ `docker-entrypoint.sh` — legacy-rev reconciliation block (lines 114–161): detects DBs stamped at pre-ADR-027 revisions and rewrites `alembic_version` to `0001_initial` without running DDL (schema is already equivalent)  
✅ `Dockerfile` (stage 2) — `ENV ALEMBIC_BIN=/venv/bin/alembic` set to point to venv-installed alembic; `COPY packages ./packages` before `bun install` so `@vision/types` workspace dep resolves  
✅ Docs updated: scripts.md, setup.md, migrations.md, deployment.md, backend-configuration.md, environment-variables.md  
✅ Legacy schema-initialization.md archived with deprecation notice  
✅ All routes/tests verified to work with new migration system

Verification: Fresh DB → `alembic upgrade head` → 27 tables + `alembic_version = 0001_initial` confirmed on ephemeral postgres.
Verification: Pre-port DB (stamped at e.g., `0031_ai_chat_tables`) → docker-entrypoint reconciliation block rewrites `alembic_version` to `0001_initial` → `alembic upgrade head` succeeds with no DDL changes.

## Related

- [[docs/adr/002-database-schema|ADR-002: Database Schema]] — original schema layout
- [[docs/adr/004-postgresql-table-inheritance|ADR-004: Postgres Table Inheritance]] — raw-transaction tables affected by port
- [[docs/adr/026-unified-api-response-envelope|ADR-026: Unified API Response Envelope]] — sibling Phase 1 decision
- [[docs/reference/scripts|Scripts Reference]] — updated with `db:migrate*` scripts
- [[docs/guides/migrations|Migration Guide]] — full migration workflow
- [[docs/guides/deployment|Deployment Guide]] — production startup behavior
- [[docs/architecture/index|Architecture Index]] — persistence section updated post-port
