/**
 * Settings Repository - data access for user_settings table.
 *
 * Stores per-key settings as JSON values with a single-row-per-key pattern.
 * Since this is a single-user local app, settings are global (no user_id).
 */

import { query } from '../database/connection.js';
import { logger } from '../config/logger.js';

/**
 * Ensure the user_settings table exists (auto-create on first use).
 */
async function ensureTable() {
  await query(`
    CREATE TABLE IF NOT EXISTS user_settings (
      key TEXT PRIMARY KEY,
      value JSONB NOT NULL DEFAULT '{}',
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

let tableReady = false;

async function init() {
  if (!tableReady) {
    await ensureTable();
    tableReady = true;
  }
}

export const settingsRepository = {
  /**
   * Get a setting by key. Returns null if not found.
   */
  async get(key) {
    await init();
    const result = await query('SELECT value FROM user_settings WHERE key = $1', [key]);
    if (result.rows.length === 0) return null;
    return result.rows[0].value;
  },

  /**
   * Get all settings as a key→value map.
   */
  async getAll() {
    await init();
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
    await init();
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
    await init();
    const result = await query('DELETE FROM user_settings WHERE key = $1 RETURNING key', [key]);
    return result.rowCount > 0;
  },

  /**
   * Bulk upsert multiple settings at once.
   */
  async setMany(settings) {
    await init();
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
