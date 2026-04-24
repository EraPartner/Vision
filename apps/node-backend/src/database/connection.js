/**
 * Database connection and pool management module.
 *
 * Mirrors: apps/backend/database/connection.py
 * Uses node-postgres (pg) with a connection pool.
 */

import pg from 'pg';
import { getSettings } from '../config/config.js';
import { logger } from '../config/logger.js';

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
  idleTimeoutMillis: 30_000,      // close idle connections after 30s
  connectionTimeoutMillis: 5_000,  // fail fast if can't connect in 5s
  statement_timeout: 30_000,       // kill queries running > 30s
});

pool.on('error', (err) => {
  logger.error('Unexpected error on idle database client', err);
});

// Cache for named prepared statements (name -> SQL text).
// Pass a { name, text, values } object to queryPrepared() to use.
const preparedStatements = new Map();

/**
 * Execute a query against the database with optional retry on transient errors.
 * @param {string} text - SQL query
 * @param {any[]} [params] - Query parameters
 * @param {{ retries?: number }} [opts]
 * @returns {Promise<pg.QueryResult>}
 */
export async function query(text, params, opts = {}) {
  const maxRetries = opts.retries ?? 0;
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
 * Execute a named prepared statement. Prepared statements are parsed by
 * PostgreSQL only once per connection, reducing per-query planning overhead
 * for hot query paths.
 *
 * @param {string} name      - Unique statement name (stable across calls)
 * @param {string} text      - SQL text (only used on first invocation per name)
 * @param {any[]}  [values]  - Bound parameters
 * @returns {Promise<pg.QueryResult>}
 */
export async function queryPrepared(name, text, values) {
  preparedStatements.set(name, text);
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
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackErr) {
      logger.error('Transaction rollback failed', rollbackErr);
    }
    throw err;
  } finally {
    client.release();
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
