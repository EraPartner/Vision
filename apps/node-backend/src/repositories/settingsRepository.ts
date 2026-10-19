/**
 * Settings Repository - data access for user_settings table.
 *
 * Stores per-key settings as JSON values with a single-row-per-key pattern.
 * Table is defined in db/migrations/0001_baseline.sql.
 */

import { sql } from "kysely";
import { withTransaction } from "../database/connection.ts";
import { checkedRow, checkedRows, db } from "../database/db.ts";
import {
  settingRowSchema,
  settingValueRowSchema,
} from "../database/rows/catalog.ts";
import { ConflictError } from "../middleware/errorHandler.ts";
import type { Json } from "../database/schema.generated.ts";

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
/** `JSON.stringify(value)` bound as a jsonb parameter (undefined binds NULL). */
const jsonb = (value: unknown) =>
  sql<Json>`${JSON.stringify(value)}::jsonb`;

const settingRows = () =>
  db.selectFrom("user_settings").select(["key", "value"]).orderBy("key");

const settingValue = (key: string) =>
  db.selectFrom("user_settings").select("value").where("key", "=", key);

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
    const rows = await checkedRows(settingRowSchema, settingRows());
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
    const row = await checkedRow(settingValueRowSchema, settingValue(key));
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
      ? await db
          .updateTable("user_settings")
          .set({ value: jsonb(value), updated_at: sql<Date>`NOW()` })
          .where("key", "=", key)
          .where("value", "=", jsonb(expected.value))
          .executeTakeFirst()
          .then((r) => r.numUpdatedRows)
      : await db
          .insertInto("user_settings")
          .values({ key, value: jsonb(value), updated_at: sql<Date>`NOW()` })
          .onConflict((oc) => oc.column("key").doNothing())
          .executeTakeFirst()
          .then((r) => r.numInsertedOrUpdatedRows ?? 0n);
    if (result === 0n)
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
    const result = await db
      .deleteFrom("user_settings")
      .where("key", "=", key)
      .where("value", "=", jsonb(expected.value))
      .executeTakeFirst();
    if (result.numDeletedRows === 0n)
      throw new ConflictError("Settings changed. Reload before deleting.");
    return true;
  },

  /**
   * Get a setting by key. Returns null if not found.
   * @returns Parsed JSONB value, or null.
   */
  async get(key: string): Promise<SettingValue> {
    const row = await checkedRow(settingValueRowSchema, settingValue(key));
    if (!row) return null;
    return reviveLegacyJsonString(key, row.value);
  },

  /**
   * Get all settings as a key→value map.
   */
  async getAll(): Promise<Record<string, SettingValue>> {
    const rows = await checkedRows(settingRowSchema, settingRows());
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
    await db
      .insertInto("user_settings")
      .values({ key, value: jsonb(value), updated_at: sql<Date>`NOW()` })
      .onConflict((oc) =>
        oc.column("key").doUpdateSet({
          value: jsonb(value),
          updated_at: sql<Date>`NOW()`,
        }),
      )
      .execute();
    return { key, value };
  },

  /**
   * Delete a setting by key.
   * @returns true if a row was removed
   */
  async delete(key: string): Promise<boolean> {
    const result = await db
      .deleteFrom("user_settings")
      .where("key", "=", key)
      .executeTakeFirst();
    return result.numDeletedRows > 0n;
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

    await sql`
      INSERT INTO user_settings (key, value, updated_at)
      SELECT u.key, u.value::jsonb, NOW()
      FROM UNNEST(${keys}::text[], ${values}::text[]) AS u(key, value)
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
    `.execute(db);
  },
};

export default settingsRepository;
