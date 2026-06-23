/**
 * Provider API Key Repository — data access for provider_api_keys.
 *
 * Table is created by Alembic migration 0043. Stores Settings-managed research
 * provider API keys (ADR-079); one row per provider. The key is masked in API
 * responses by the service layer and never returned in full to the frontend.
 */

import { query } from '../database/connection.js';

/**
 * All stored provider keys.
 * @returns {Promise<Array<{ provider: string, api_key: string, updated_at: string }>>}
 */
export async function listAll() {
  const result = await query(
    'SELECT provider, api_key, updated_at FROM provider_api_keys ORDER BY provider ASC',
  );
  return result.rows;
}

/**
 * Insert or replace a provider's key.
 * @param {string} provider
 * @param {string} apiKey
 */
export async function upsert(provider, apiKey) {
  await query(
    `INSERT INTO provider_api_keys (provider, api_key, updated_at)
          VALUES ($1, $2, NOW())
     ON CONFLICT (provider) DO UPDATE
        SET api_key = EXCLUDED.api_key,
            updated_at = NOW()`,
    [provider, apiKey],
  );
}

/**
 * Delete a provider's stored key.
 * @param {string} provider
 * @returns {Promise<boolean>} true if a row was removed
 */
export async function remove(provider) {
  const result = await query('DELETE FROM provider_api_keys WHERE provider = $1', [provider]);
  return result.rowCount > 0;
}
