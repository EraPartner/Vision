/**
 * Settings Repository - data access for user_settings table.
 *
 * Stores per-key settings as JSON values with a single-row-per-key pattern.
 * Table is created by Alembic migration 0030_add_user_settings_table.
 */

import { query, withTransaction } from "../database/connection.ts";
import { queryOne, queryRows } from "../database/rowContracts.ts";
import {
  settingRowSchema,
  settingValueRowSchema,
} from "../database/rows/catalog.ts";
import { ConflictError } from "../middleware/errorHandler.ts";

/**
 * Settings whose values are plain strings. The legacy self-heal in
 * reviveLegacyJsonString must never JSON.parse these — a stored value that
 * happens to parse as JSON ("123", "true") would silently type-flip on
 * read. Register any new string-valued setting key here.
 */
const STRING_VALUED_KEYS = new Set(["cost_basis_method"]);

/**
 * A parsed JSONB setting value. Every setting has its own shape, so callers
 * narrow it themselves (see {@link settingField}).
 */
type SettingValue = unknown;

/**
 * `value?.[field]` for a setting value of unknown shape: `undefined` for a
 * missing (null/undefined) value, otherwise the property as JavaScript reads
 * it (primitives are boxed, exactly like optional chaining does).
 */
export function settingField(value: SettingValue, field: string): unknown {
  if (value === null || value === undefined) return undefined;
  return (Object(value) as Record<string, unknown>)[field];
}

/** The value a conditional write expects to find (optimistic concurrency). */
export interface SettingExpectation {
  exists: boolean;
  value?: unknown;
}

/**
 * Legacy rows (and some restore paths) stored the JSON of the value inside a
 * jsonb string — e.g. jsonb `"true"` for the boolean true. Self-heal those on
 * read by parsing, but only for keys that are not string-valued by contract.
 *
 * @param value Parsed JSONB value from pg.
 */
function reviveLegacyJsonString(
  key: string,
  value: SettingValue,
): SettingValue {
  if (typeof value !== "string" || STRING_VALUED_KEYS.has(key)) return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

export const settingsRepository = {
  async getAllWithBaselines(): Promise<{
    settings: Record<string, SettingValue>;
    expected: Record<string, SettingExpectation>;
  }> {
    const rows = await queryRows(
      settingRowSchema,
      "SELECT key, value FROM user_settings ORDER BY key",
    );
    const settings = Object.fromEntries(
      rows.map((row) => [row.key, reviveLegacyJsonString(row.key, row.value)]),
    );
    const expected = Object.fromEntries(
      rows.map((row) => [row.key, { exists: true, value: row.value }]),
    );
    return { settings, expected };
  },

  /** Read the persisted value without confusing absence with JSON null. */
  async getRecord(
    key: string,
  ): Promise<{ value?: SettingValue; expected: SettingExpectation }> {
    const row = await queryOne(
      settingValueRowSchema,
      "SELECT value FROM user_settings WHERE key = $1",
      [key],
    );
    if (!row) return { expected: { exists: false } };
    return {
      value: reviveLegacyJsonString(key, row.value),
      expected: { exists: true, value: row.value },
    };
  },

  /**
   * Atomic whole-value replacement. Omitted object fields are removed; nested
   * values are not merged. PostgreSQL JSONB equality ignores object key order.
   */
  async replace<V>(
    key: string,
    value: V,
    expected: SettingExpectation,
  ): Promise<{
    key: string;
    value: V;
    expected: { exists: true; value: V };
  }> {
    const result = expected.exists
      ? await query(
          `UPDATE user_settings SET value = $2::jsonb, updated_at = NOW()
          WHERE key = $1 AND value = $3::jsonb RETURNING key`,
          [key, JSON.stringify(value), JSON.stringify(expected.value)],
        )
      : await query(
          `INSERT INTO user_settings (key, value, updated_at)
          VALUES ($1, $2::jsonb, NOW()) ON CONFLICT (key) DO NOTHING RETURNING key`,
          [key, JSON.stringify(value)],
        );
    if (!result.rowCount)
      throw new ConflictError("Settings changed. Reload before saving again.");
    return { key, value, expected: { exists: true, value } };
  },

  /** Conditional multi-key saves either all commit or all roll back. */
  async replaceMany(
    settings: Record<string, unknown>,
    expected: Record<string, SettingExpectation>,
  ): Promise<void> {
    return withTransaction(async () => {
      for (const key of Object.keys(settings).sort()) {
        // The route requires a baseline per key; a missing one is a caller bug.
        const baseline = expected[key];
        if (!baseline)
          throw new Error(`Missing expected baseline for setting ${key}`);
        await settingsRepository.replace(key, settings[key], baseline);
      }
    });
  },

  /** Conditional deletion also protects a newer replacement. */
  async deleteExpected(
    key: string,
    expected: SettingExpectation,
  ): Promise<true> {
    if (!expected.exists)
      throw new ConflictError("Settings changed. Reload before deleting.");
    const result = await query(
      `DELETE FROM user_settings
      WHERE key = $1 AND value = $2::jsonb RETURNING key`,
      [key, JSON.stringify(expected.value)],
    );
    if (!result.rowCount)
      throw new ConflictError("Settings changed. Reload before deleting.");
    return true;
  },

  /**
   * Get a setting by key. Returns null if not found.
   * @returns Parsed JSONB value, or null.
   */
  async get(key: string): Promise<SettingValue> {
    const row = await queryOne(
      settingValueRowSchema,
      "SELECT value FROM user_settings WHERE key = $1",
      [key],
    );
    if (!row) return null;
    return reviveLegacyJsonString(key, row.value);
  },

  /**
   * Get all settings as a key→value map.
   */
  async getAll(): Promise<Record<string, SettingValue>> {
    const rows = await queryRows(
      settingRowSchema,
      "SELECT key, value FROM user_settings ORDER BY key",
    );
    const settings: Record<string, SettingValue> = {};
    for (const row of rows) {
      settings[row.key] = reviveLegacyJsonString(row.key, row.value);
    }
    return settings;
  },

  /**
   * Upsert a setting (insert or update).
   * @param value Arbitrary JSON-serialisable value.
   */
  async set<V>(key: string, value: V): Promise<{ key: string; value: V }> {
    const jsonValue = JSON.stringify(value);

    await query(
      `INSERT INTO user_settings (key, value, updated_at)
       VALUES ($1, $2::jsonb, NOW())
       ON CONFLICT (key) DO UPDATE SET value = $2::jsonb, updated_at = NOW()`,
      [key, jsonValue],
    );
    return { key, value };
  },

  /**
   * Delete a setting by key.
   * @returns true if a row was removed
   */
  async delete(key: string): Promise<boolean> {
    const result = await query(
      "DELETE FROM user_settings WHERE key = $1 RETURNING key",
      [key],
    );
    return (result.rowCount ?? 0) > 0;
  },

  /**
   * Bulk upsert multiple settings at once.
   * @param settings key→value map.
   */
  async setMany(settings: Record<string, unknown>): Promise<void> {
    const entries = Object.entries(settings);
    if (entries.length === 0) return;

    const keys: string[] = [];
    const values: (string | undefined)[] = [];
    for (const [key, value] of entries) {
      keys.push(key);
      values.push(JSON.stringify(value));
    }

    await query(
      `INSERT INTO user_settings (key, value, updated_at)
       SELECT u.key, u.value::jsonb, NOW()
       FROM UNNEST($1::text[], $2::text[]) AS u(key, value)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
      [keys, values],
    );
  },
};

export default settingsRepository;
