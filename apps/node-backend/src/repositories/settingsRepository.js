/**
 * Settings Repository - data access for user_settings table.
 *
 * Stores per-key settings as JSON values with a single-row-per-key pattern.
 * Table is created by the schema initialiser on startup.
 */

import { query } from '../database/connection.js';

let userSettingsTableReady = false;

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

async function ensureUserSettingsTable() {
  if (userSettingsTableReady) return;

  await query(`
    CREATE TABLE IF NOT EXISTS user_settings (
      key VARCHAR(100) PRIMARY KEY,
      value JSONB NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  userSettingsTableReady = true;
}

export const settingsRepository = {
  /**
   * Get a setting by key. Returns null if not found.
   */
  async get(key) {
    await ensureUserSettingsTable();
    const result = await query('SELECT value FROM user_settings WHERE key = $1', [key]);
    if (result.rows.length === 0) return null;
    const v = result.rows[0].value;
    // Some DB versions or legacy rows might store a JSON string; normalize.
    if (typeof v === 'string') {
      try { return JSON.parse(v); } catch { return v; }
    }
    return v;
  },

  /**
   * Get all settings as a key→value map.
   */
  async getAll() {
    await ensureUserSettingsTable();
    const result = await query('SELECT key, value FROM user_settings ORDER BY key');
    const settings = {};
    for (const row of result.rows) {
      const v = row.value;
      settings[row.key] = (typeof v === 'string') ? (() => {
        try { return JSON.parse(v); } catch { return v; }
      })() : v;
    }
    return settings;
  },

  /**
   * Upsert a setting (insert or update).
   */
  async set(key, value) {
    await ensureUserSettingsTable();
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
   */
  async delete(key) {
    await ensureUserSettingsTable();
    const result = await query('DELETE FROM user_settings WHERE key = $1 RETURNING key', [key]);
    return result.rowCount > 0;
  },

  /**
   * Bulk upsert multiple settings at once.
   */
  async setMany(settings) {
    await ensureUserSettingsTable();
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
