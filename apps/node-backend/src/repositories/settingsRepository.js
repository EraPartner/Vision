/**
 * Settings Repository - data access for user_settings table.
 *
 * Stores per-key settings as JSON values with a single-row-per-key pattern.
 * Table is created by Alembic migration 0030_add_user_settings_table.
 */

import { query } from '../database/connection.js';

/**
 * Settings whose values are plain strings. The legacy self-heal in
 * reviveLegacyJsonString must never JSON.parse these — a stored value that
 * happens to parse as JSON ("123", "true") would silently type-flip on
 * read. Register any new string-valued setting key here.
 */
const STRING_VALUED_KEYS = new Set(['cost_basis_method']);

/**
 * Legacy rows (and some restore paths) stored the JSON of the value inside a
 * jsonb string — e.g. jsonb `"true"` for the boolean true. Self-heal those on
 * read by parsing, but only for keys that are not string-valued by contract.
 *
 * @param {string} key
 * @param {any} value Parsed JSONB value from pg.
 * @returns {any}
 */
function reviveLegacyJsonString(key, value) {
  if (typeof value !== 'string' || STRING_VALUED_KEYS.has(key)) return value;
  try { return JSON.parse(value); } catch { return value; }
}

/**
 * @param {any} value Arbitrary JSON-serialisable setting value.
 * @returns {any}
 */
function normalizeSettingValue(value) {
  let normalizedValue = value;

  try {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      normalizedValue = { ...value };
      if (Array.isArray(value.excludedCategoryIds)) {
        normalizedValue.excludedCategoryIds = value.excludedCategoryIds.map(Number);
      }
      if (Array.isArray(value.excludedRecipientIds)) {
        normalizedValue.excludedRecipientIds = value.excludedRecipientIds.map(Number);
      }
    }
  } catch {
    // ignore normalization errors — DB will still store original value
  }

  return normalizedValue;
}

export const settingsRepository = {
  /**
   * Get a setting by key. Returns null if not found.
   * @param {string} key
   * @returns {Promise<any>} Parsed JSONB value, or null.
   */
  async get(key) {
    const result = await query('SELECT value FROM user_settings WHERE key = $1', [key]);
    if (result.rows.length === 0) return null;
    return reviveLegacyJsonString(key, result.rows[0].value);
  },

  /**
   * Get all settings as a key→value map.
   * @returns {Promise<Record<string, any>>}
   */
  async getAll() {
    const result = await query('SELECT key, value FROM user_settings ORDER BY key');
    /** @type {Record<string, any>} */
    const settings = {};
    for (const row of result.rows) {
      settings[row.key] = reviveLegacyJsonString(row.key, row.value);
    }
    return settings;
  },

  /**
   * Upsert a setting (insert or update).
   * @param {string} key
   * @param {any} value Arbitrary JSON-serialisable value.
   * @returns {Promise<{ key: string, value: any }>}
   */
  async set(key, value) {
    const normalized = normalizeSettingValue(value);
    const jsonValue = JSON.stringify(normalized);

    await query(
      `INSERT INTO user_settings (key, value, updated_at)
       VALUES ($1, $2::jsonb, NOW())
       ON CONFLICT (key) DO UPDATE SET value = $2::jsonb, updated_at = NOW()`,
      [key, jsonValue]
    );
    return { key, value: normalized };
  },

  /**
   * Delete a setting by key.
   * @param {string} key
   * @returns {Promise<boolean>} true if a row was removed
   */
  async delete(key) {
    const result = await query('DELETE FROM user_settings WHERE key = $1 RETURNING key', [key]);
    return result.rowCount > 0;
  },

  /**
   * Bulk upsert multiple settings at once.
   * @param {Record<string, any>} settings key→value map.
   * @returns {Promise<void>}
   */
  async setMany(settings) {
    const entries = Object.entries(settings);
    if (entries.length === 0) return;

    const keys = [];
    const values = [];
    for (const [key, value] of entries) {
      keys.push(key);
      values.push(JSON.stringify(normalizeSettingValue(value)));
    }

    await query(
      `INSERT INTO user_settings (key, value, updated_at)
       SELECT u.key, u.value::jsonb, NOW()
       FROM UNNEST($1::text[], $2::text[]) AS u(key, value)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
      [keys, values]
    );
  },
};

export default settingsRepository;
