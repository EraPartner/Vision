#!/usr/bin/env bun
/**
 * Standalone migration runner — brings the DATABASE_URL database up to head.
 *
 * This deliberately delegates to `src/database/migrate.js` (the exact code the
 * app runs on boot) rather than shelling out to `alembic upgrade head`, because
 * a plain alembic invocation CANNOT migrate a fresh database in this repo:
 * alembic auto-creates `alembic_version.version_num` as VARCHAR(32), and the
 * chain's revision identifiers are longer than that (e.g.
 * `0003_import_batch_id_on_transactions` is 36 chars), so the third revision
 * dies with `value too long for type character varying(32)`.
 * `runMigrations()` preflights that table at VARCHAR(64) via
 * `stampBaselineIfLegacy()` first, which is why the app boots fine and a bare
 * `alembic upgrade head` does not.
 *
 * Used by CI ("Test (Backend)" migrates its Postgres service with this) and by
 * scripts/with-test-db.sh for local real-DB runs. Requires the Python alembic
 * toolchain on PATH (config/requirements.txt); override the binary with
 * ALEMBIC_BIN if it lives in a venv.
 *
 * Usage: DATABASE_URL=postgres://... bun run apps/node-backend/scripts/db-migrate.js
 */

import { runMigrations } from '../src/database/migrate.js';
import { closePool } from '../src/database/connection.js';

if (!process.env.DATABASE_URL) {
  console.error('[db-migrate] DATABASE_URL is not set — refusing to guess a target database.');
  process.exit(1);
}

try {
  await runMigrations();
  console.log('[db-migrate] schema is at head');
} catch (error) {
  console.error(`[db-migrate] migration failed: ${error.message}`);
  await closePool().catch(() => {});
  process.exit(1);
}

await closePool().catch(() => {});
process.exit(0);
