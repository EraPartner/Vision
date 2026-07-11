/**
 * Database connection and pool management module.
 *
 * Mirrors: apps/backend/database/connection.py
 * Uses node-postgres (pg) with a connection pool.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import pg from 'pg';
import { getSettings } from '../config/config.js';
import { logger } from '../config/logger.js';

// Ambient transaction context: withTransaction() runs its callback inside this
// store so module-level query() joins the transaction instead of grabbing a
// separate pool connection. Without it, a repo call inside withTransaction
// silently runs OUTSIDE the transaction — it can't see uncommitted rows and
// survives a rollback, which is exactly the partial-write bug transactions
// exist to prevent. The store is invalidated (client nulled) when the
// transaction ends so a leaked continuation can't write on a released client.
const txStorage = new AsyncLocalStorage();

/**
 * The pg client of the withTransaction() this code is running inside, or null.
 * Exposed for callers that must adapt to ambient-transaction mode (e.g. wrap a
 * catch-and-retry INSERT in a SAVEPOINT — see withSavepointIfInTransaction).
 * @returns {pg.PoolClient|null}
 */
export function getAmbientTransactionClient() {
  return txStorage.getStore()?.client ?? null;
}

const settings = getSettings();

// pool.max should be the true ceiling for concurrent DB connections.
// settings.database.poolSize is the sustained pool size;
// settings.database.maxOverflow is kept for configuration parity but we use
// the larger of the two so burst traffic is absorbed without exhausting the DB.
const poolMax = Math.max(settings.database.poolSize, settings.database.maxOverflow)
  || settings.database.poolSize
  || 10;

const pool = new pg.Pool({
  connectionString: settings.database.url,
  max: poolMax,
  idleTimeoutMillis: 60_000,      // close idle connections after 60s
  connectionTimeoutMillis: 5_000,  // fail fast if can't connect in 5s
  statement_timeout: 30_000,       // kill queries running > 30s
});

pool.on('error', (err) => {
  logger.error('Unexpected error on idle database client', err);
});


/**
 * A statement is safe to transparently retry only if it cannot have applied a
 * write before the connection dropped. A transient error (e.g. ECONNRESET) can
 * fire *after* the server committed an INSERT/UPDATE/DELETE — retrying that
 * would double-apply the write. Restrict retries to plain read statements.
 *
 * @param {string} sql
 * @returns {boolean}
 */
function isRetryableStatement(sql) {
  return /^\s*(?:SELECT|SHOW|EXPLAIN)\b/i.test(sql);
}

/**
 * Execute a query against the database with optional retry on transient errors.
 * Retries apply to read-only statements only — see {@link isRetryableStatement}.
 * @param {string} text - SQL query
 * @param {any[]} [params] - Query parameters
 * @param {{ retries?: number }} [opts]
 * @returns {Promise<pg.QueryResult>}
 */
export async function query(text, params, opts = {}) {
  // Inside withTransaction(): run on the transaction's client, and never
  // retry — after a connection error the transaction is dead, so a retried
  // statement would run outside it (or on a poisoned client).
  const ambient = getAmbientTransactionClient();
  if (ambient) {
    return ambient.query(text, params);
  }

  const maxRetries = (opts.retries ?? 0) > 0 && isRetryableStatement(text)
    ? opts.retries
    : 0;
  let attempt = 0;

  while (true) {
    const start = Date.now();
    try {
      const result = await pool.query(text, params);
      const duration = Date.now() - start;
      if (settings.database.echo || duration > 1000) {
        logger.debug(`Query executed in ${duration}ms: ${text.slice(0, 100)}`);
      }
      return result;
    } catch (err) {
      const duration = Date.now() - start;
      const isTransient =
        err.code === 'ECONNRESET' ||
        err.code === '57P01' || // admin_shutdown
        err.code === '08006' || // connection_failure
        err.code === '08001' || // sqlclient_unable_to_establish_sqlconnection
        err.message?.includes('Connection terminated');

      if (isTransient && attempt < maxRetries) {
        attempt++;
        const backoff = Math.min(200 * attempt, 2000);
        logger.warn(`Transient DB error (attempt ${attempt}/${maxRetries}), retrying in ${backoff}ms: ${err.message}`);
        await new Promise((r) => setTimeout(r, backoff));
        continue;
      }

      logger.error(`Query failed after ${duration}ms: ${text.slice(0, 100)}`, { error: err.message });
      throw err;
    }
  }
}

/**
 * Execute a named prepared statement. PostgreSQL parses the plan once per
 * connection; pg passes text every call because pool connections are independent.
 *
 * @param {string} name      - Unique statement name (stable across calls)
 * @param {string} text      - SQL text
 * @param {any[]}  [values]  - Bound parameters
 * @returns {Promise<pg.QueryResult>}
 */
export async function queryPrepared(name, text, values) {
  return pool.query({ name, text, values });
}

/**
 * Get a client from the pool for transactions.
 * Remember to call client.release() when done.
 * @returns {Promise<pg.PoolClient>}
 */
export async function getClient() {
  return pool.connect();
}

/**
 * Run `fn` inside a database transaction.
 *
 * Acquires a pooled client, issues BEGIN, invokes `fn(client)`, then COMMITs
 * on success or ROLLBACKs on throw. Always releases the client.
 *
 * @template T
 * @param {(client: pg.PoolClient) => Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function withTransaction(fn) {
  const client = await getClient();
  // The callback runs inside txStorage so module-level query() joins this
  // transaction (see getAmbientTransactionClient). fn still receives the
  // client for code that threads it explicitly — both routes hit the same
  // connection.
  const store = { client };
  let rollbackFailed = false;
  try {
    await client.query('BEGIN');
    const result = await txStorage.run(store, () => fn(client));
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackErr) {
      logger.error('Transaction rollback failed', rollbackErr);
      rollbackFailed = true;
    }
    throw err;
  } finally {
    // Invalidate the ambient store: a continuation leaked out of the callback
    // (timer, un-awaited promise) must fall back to the pool, not write on a
    // released client.
    store.client = null;
    // If ROLLBACK threw, the connection's transaction state is unknown.
    // Passing a truthy arg to release() destroys the client instead of
    // returning a poisoned connection to the pool.
    client.release(rollbackFailed || undefined);
  }
}

/**
 * Run `fn` under a SAVEPOINT when inside an ambient withTransaction(), so a
 * caught failure doesn't abort the whole transaction (PostgreSQL poisons a tx
 * on ANY statement error — a catch-and-retry pattern that works on a pool
 * connection would otherwise fail with 25P02 on every statement after the
 * catch). Outside a transaction this is a plain passthrough.
 *
 * `name` must be a static identifier from the caller, never user input.
 *
 * @template T
 * @param {string} name
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function withSavepointIfInTransaction(name, fn) {
  const client = getAmbientTransactionClient();
  if (!client) return fn();
  await client.query(`SAVEPOINT ${name}`);
  try {
    const result = await fn();
    await client.query(`RELEASE SAVEPOINT ${name}`);
    return result;
  } catch (err) {
    await client.query(`ROLLBACK TO SAVEPOINT ${name}`);
    throw err;
  }
}

/**
 * Check if the database is reachable.
 * @returns {Promise<boolean>}
 */
export async function checkConnection() {
  try {
    await pool.query('SELECT 1');
    return true;
  } catch {
    return false;
  }
}

/**
 * Get table count in the public schema.
 * @returns {Promise<number>}
 */
export async function getTableCount() {
  const result = await pool.query(
    "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public'"
  );
  return parseInt(result.rows[0].count, 10);
}

/**
 * Get pool statistics for monitoring.
 */
export function getPoolStats() {
  return {
    totalCount: pool.totalCount,
    idleCount: pool.idleCount,
    waitingCount: pool.waitingCount,
    maxConnections: poolMax,
  };
}

export async function closePool() {
  await pool.end();
}

export default pool;
