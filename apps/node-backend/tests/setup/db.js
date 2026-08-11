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
 *
 * A run that skipped for want of a database is not a complete run, so
 * `dbSkipBanner.js` shouts about it after the summary — importing this file is
 * what marks a module as DB-backed for that count.
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

// ── Cross-suite serialization ───────────────────────────────────────────────
// Vitest runs test FILES in parallel workers, but every DB-backed suite shares
// the one TEST_DATABASE_URL database and wipes whole tables between tests —
// two suites running concurrently delete each other's fixtures mid-test. A
// session-scoped Postgres advisory lock serializes them at the database level
// without slowing the (much larger) non-DB portion of the run: each suite
// takes the lock in beforeAll and releases it in afterAll, so DB suites queue
// behind one another while everything else stays parallel.
//
// Suites must pass a generous timeout to beforeAll (the wait is the sum of the
// suites ahead in the queue): `beforeAll(acquireDbSuiteLock, 180_000)`.

const DB_SUITE_LOCK_KEY = 715_001;

/** @type {import('pg').PoolClient | null} */
let lockClient = null;

/** Block until this process holds the shared DB-suite advisory lock. */
export async function acquireDbSuiteLock() {
  const pool = getTestPool();
  if (!pool || lockClient) return;
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [DB_SUITE_LOCK_KEY]);
  } catch (err) {
    client.release();
    throw err;
  }
  lockClient = client;
}

/** Release the advisory lock (safe to call when not held). */
export async function releaseDbSuiteLock() {
  if (!lockClient) return;
  const client = lockClient;
  lockClient = null;
  try {
    await client.query('SELECT pg_advisory_unlock($1)', [DB_SUITE_LOCK_KEY]);
  } finally {
    client.release();
  }
}
