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

const pool = new pg.Pool({
  connectionString: settings.database.url,
  max: settings.database.poolSize + settings.database.maxOverflow,
});

pool.on('error', (err) => {
  logger.error('Unexpected error on idle database client', err);
});

/**
 * Execute a query against the database.
 * @param {string} text - SQL query
 * @param {any[]} params - Query parameters
 * @returns {Promise<pg.QueryResult>}
 */
export async function query(text, params) {
  const start = Date.now();
  const result = await pool.query(text, params);
  const duration = Date.now() - start;
  if (settings.database.echo) {
    logger.debug(`Query executed in ${duration}ms: ${text.slice(0, 100)}`);
  }
  return result;
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

export async function closePool() {
  await pool.end();
}

export default pool;
