/**
 * Feature Flag Repository — data access for the feature_flags table.
 *
 * Table is created by Alembic migration 0002_feature_flags.
 * All mutations use parameterised queries.
 */

import { query } from '../database/connection.js';

/**
 * @typedef {Object} FeatureFlag
 * @property {number} id
 * @property {string} key
 * @property {boolean} enabled
 * @property {string|null} description
 * @property {string} created_at
 * @property {string} updated_at
 */

/**
 * Return all feature flags ordered by key.
 * @returns {Promise<FeatureFlag[]>}
 */
async function listAll() {
  const result = await query(
    'SELECT id, key, enabled, description, created_at, updated_at FROM feature_flags ORDER BY key ASC',
  );
  return result.rows;
}

/**
 * Return a single feature flag by key, or null if not found.
 * @param {string} key
 * @returns {Promise<FeatureFlag|null>}
 */
async function findByKey(key) {
  const result = await query(
    'SELECT id, key, enabled, description, created_at, updated_at FROM feature_flags WHERE key = $1',
    [key],
  );
  return result.rows[0] ?? null;
}

/**
 * Check whether a feature flag is enabled. Returns false for unknown keys.
 * @param {string} key
 * @returns {Promise<boolean>}
 */
async function isEnabled(key) {
  const flag = await findByKey(key);
  return flag?.enabled ?? false;
}

/**
 * Update the enabled state of a feature flag. Returns the updated row.
 * Throws if the key does not exist.
 * @param {string} key
 * @param {boolean} enabled
 * @returns {Promise<FeatureFlag>}
 */
async function setEnabled(key, enabled) {
  const result = await query(
    `UPDATE feature_flags
        SET enabled = $2, updated_at = NOW()
      WHERE key = $1
      RETURNING id, key, enabled, description, created_at, updated_at`,
    [key, enabled],
  );
  return result.rows[0] ?? null;
}

export default { listAll, findByKey, isEnabled, setEnabled };
