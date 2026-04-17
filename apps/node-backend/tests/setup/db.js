/**
 * Shared DB test-fixture helper (Phase 0 step 6).
 *
 * Tests that need a real Postgres instance import `getTestPool()`. Resolution
 * rules:
 *   - If `TEST_DATABASE_URL` is set, use it (expected: compose DB on a dedicated
 *     test schema, or a testcontainers-pg instance in CI)
 *   - Otherwise return null so the test can self-skip with `it.skipIf(!pool)`
 *
 * Callers are responsible for their own schema/truncate/rollback strategy. A
 * per-test transaction + rollback pattern is recommended; a per-suite truncate
 * is acceptable when transactions would hide the behaviour under test.
 *
 * The pool is memoised per-process so repeated imports don't leak connections.
 * Closing is handled in the vitest `afterAll` hook at call-site; the helper
 * exposes `closeTestPool()` for that purpose.
 */

import pg from 'pg';

const { Pool } = pg;

let cachedPool = null;

/**
 * Return a shared Postgres pool if `TEST_DATABASE_URL` is set, else null.
 * @returns {import('pg').Pool | null}
 */
export function getTestPool() {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) return null;
  if (cachedPool) return cachedPool;
  cachedPool = new Pool({ connectionString: url, max: 4 });
  return cachedPool;
}

/**
 * Close the shared pool if it was opened. Safe to call when no pool exists.
 */
export async function closeTestPool() {
  if (!cachedPool) return;
  const pool = cachedPool;
  cachedPool = null;
  await pool.end();
}

/**
 * Boolean convenience for `it.skipIf(!hasTestDatabase())`.
 * @returns {boolean}
 */
export function hasTestDatabase() {
  return Boolean(process.env.TEST_DATABASE_URL);
}
