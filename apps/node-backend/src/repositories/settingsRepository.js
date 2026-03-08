/**
 * Settings Repository - data access for user_settings table.
 *
 * Stores per-key settings as JSON values with a single-row-per-key pattern.
 * Table is created by the schema initialiser on startup.
 */

import { query } from '../database/connection.js';

let userSettingsTableReady = false;

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
    return result.rows[0].value;
  },

  /**
   * Get all settings as a key→value map.
   */
  async getAll() {
    await ensureUserSettingsTable();
    const result = await query('SELECT key, value FROM user_settings ORDER BY key');
    const settings = {};
    for (const row of result.rows) {
      settings[row.key] = row.value;
    }
    return settings;
  },

  /**
   * Upsert a setting (insert or update).
   */
  async set(key, value) {
    await ensureUserSettingsTable();
    await query(
      `INSERT INTO user_settings (key, value, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
      [key, JSON.stringify(value)]
    );
    return { key, value };
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

    for (const [key, value] of entries) {
      await query(
        `INSERT INTO user_settings (key, value, updated_at)
         VALUES ($1, $2, NOW())
         ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
        [key, JSON.stringify(value)]
      );
    }
  },
};

export default settingsRepository;
