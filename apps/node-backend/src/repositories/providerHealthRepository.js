/**
 * Provider Health Repository — data access for the provider_health table.
 *
 * Table is created by Alembic migration 0010_add_provider_health.
 * All mutations use parameterised queries.
 */

import { query } from '../database/connection.js';

/**
 * @typedef {Object} ProviderHealth
 * @property {string} provider
 * @property {string} kind  - 'price' | 'fx' | 'inflation' | 'import'
 * @property {string|null} last_success_at
 * @property {string|null} last_error_at
 * @property {string|null} last_error
 * @property {number} consecutive_failures
 * @property {string} updated_at
 */

/**
 * Return all provider health rows ordered by kind, then provider.
 * @returns {Promise<ProviderHealth[]>}
 */
async function listAll() {
  const result = await query(
    `SELECT provider, kind, last_success_at, last_error_at, last_error,
            consecutive_failures, updated_at
       FROM provider_health
      ORDER BY kind ASC, provider ASC`,
  );
  return result.rows;
}

/**
 * Return a single row by provider key, or null.
 * @param {string} provider
 * @returns {Promise<ProviderHealth|null>}
 */
async function findByProvider(provider) {
  const result = await query(
    `SELECT provider, kind, last_success_at, last_error_at, last_error,
            consecutive_failures, updated_at
       FROM provider_health
      WHERE provider = $1`,
    [provider],
  );
  return result.rows[0] ?? null;
}

/**
 * Upsert a success event: clear error state, reset consecutive_failures.
 * @param {string} provider
 * @param {string} kind
 */
async function recordSuccess(provider, kind) {
  await query(
    `INSERT INTO provider_health (provider, kind, last_success_at, consecutive_failures, updated_at)
          VALUES ($1, $2, NOW(), 0, NOW())
     ON CONFLICT (provider) DO UPDATE
        SET last_success_at      = NOW(),
            consecutive_failures = 0,
            updated_at           = NOW()`,
    [provider, kind],
  );
}

/**
 * Upsert an error event: set last_error, increment consecutive_failures.
 * @param {string} provider
 * @param {string} kind
 * @param {string} errorMessage
 */
async function recordError(provider, kind, errorMessage) {
  await query(
    `INSERT INTO provider_health
            (provider, kind, last_error_at, last_error, consecutive_failures, updated_at)
          VALUES ($1, $2, NOW(), $3, 1, NOW())
     ON CONFLICT (provider) DO UPDATE
        SET last_error_at        = NOW(),
            last_error           = $3,
            consecutive_failures = provider_health.consecutive_failures + 1,
            updated_at           = NOW()`,
    [provider, kind, String(errorMessage).slice(0, 1000)],
  );
}

export default { listAll, findByProvider, recordSuccess, recordError };
