/**
 * The SQLite test harness (ADR-263): every test file has its own database
 * copy of the migrated template, and resetTestDatabase() restores it.
 */
import { describe, expect, it } from "vitest";
import { getTestPool, hasTestDatabase, resetTestDatabase } from "./db.ts";

describe("tests/setup/db", () => {
  it("gives every test file its own migrated database", async () => {
    expect(hasTestDatabase()).toBe(true);
    expect(process.env.VISION_DATABASE_PATH).toMatch(/test-\d+-[0-9a-f-]+\.sqlite3$/);
    const { rows } = await getTestPool().query<{ n: number }>(
      "SELECT count(*) AS n FROM vision_migrations",
    );
    expect(rows[0]?.n).toBeGreaterThan(0);
  });

  it("resetTestDatabase() discards every change", async () => {
    const pool = getTestPool();
    await pool.query("CREATE TABLE harness_probe (x INTEGER)");
    await resetTestDatabase();
    const { rows } = await pool.query<{ n: number }>(
      "SELECT count(*) AS n FROM sqlite_schema WHERE name = 'harness_probe'",
    );
    expect(rows[0]?.n).toBe(0);
  });
});
