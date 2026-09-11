import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { hasTestDatabase } from "./setup/db.js";

const execFileAsync = promisify(execFile);
const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const ALEMBIC_BIN = process.env.ALEMBIC_BIN || "alembic";
const ALEMBIC_CONFIG = path.join(REPO_ROOT, "config/alembic.ini");
const BEFORE = "0105_retire_legacy_exchange_rate_cache";
const TARGET = "0106_remove_federal_pit_total_alias";
const SETTING_KEY = "belgian_tax_profile_snapshot_meta_v1";

function scratchDbName() {
  const base = new URL(
    process.env.TEST_DATABASE_URL ?? "postgres://x/x",
  ).pathname.replace(/^\//, "");
  return `${base}_federal_pit_0106`;
}

function scratchUrl() {
  const url = new URL(process.env.TEST_DATABASE_URL ?? "postgres://x/x");
  url.pathname = `/${scratchDbName()}`;
  return url.toString();
}

function alembic(...args) {
  return execFileAsync(ALEMBIC_BIN, ["-c", ALEMBIC_CONFIG, ...args], {
    cwd: REPO_ROOT,
    env: { ...process.env, DATABASE_URL: scratchUrl() },
    timeout: 120_000,
  });
}

/** @type {pg.Client|null} */
let db = null;

async function setValue(value) {
  await db.query(
    `INSERT INTO user_settings (key, value)
     VALUES ($1, $2::jsonb)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [SETTING_KEY, JSON.stringify(value)],
  );
}

async function getValue() {
  const result = await db.query(
    "SELECT value FROM user_settings WHERE key = $1",
    [SETTING_KEY],
  );
  return result.rows[0]?.value;
}

describe.skipIf(!hasTestDatabase())(
  "migration 0106 federal PIT alias retirement",
  () => {
    beforeAll(async () => {
      const admin = new pg.Client({
        connectionString: process.env.TEST_DATABASE_URL,
      });
      await admin.connect();
      await admin.query(
        `DROP DATABASE IF EXISTS ${scratchDbName()} WITH (FORCE)`,
      );
      await admin.query(
        `CREATE DATABASE ${scratchDbName()} WITH TEMPLATE template0 ENCODING 'UTF8' LC_COLLATE 'C.UTF-8' LC_CTYPE 'C.UTF-8'`,
      );
      await admin.end();

      db = new pg.Client({ connectionString: scratchUrl() });
      await db.connect();
      await db.query(
        "CREATE TABLE alembic_version (version_num VARCHAR(64) NOT NULL, CONSTRAINT alembic_version_pkc PRIMARY KEY (version_num))",
      );
      await alembic("upgrade", BEFORE);
    }, 180_000);

    afterAll(async () => {
      if (db) await db.end();
      const admin = new pg.Client({
        connectionString: process.env.TEST_DATABASE_URL,
      });
      await admin.connect();
      await admin.query(
        `DROP DATABASE IF EXISTS ${scratchDbName()} WITH (FORCE)`,
      );
      await admin.end();
    });

    it("is a no-op without the setting row", async () => {
      await alembic("upgrade", TARGET);
      expect(await getValue()).toBeUndefined();
      await alembic("downgrade", BEFORE);
    }, 180_000);

    it("strips equal aliases, preserves other JSON, and restores on downgrade", async () => {
      await setValue({
        2025: {
          status: "frozen",
          frozenCalculation: {
            federalPITBeforeExemption: 123.45,
            federalPITTotal: 123.45,
            totalPIT: 99,
          },
        },
        note: { untouched: true },
      });

      await alembic("upgrade", TARGET);
      expect(await getValue()).toEqual({
        2025: {
          status: "frozen",
          frozenCalculation: {
            federalPITBeforeExemption: 123.45,
            totalPIT: 99,
          },
        },
        note: { untouched: true },
      });

      await alembic("downgrade", BEFORE);
      expect((await getValue())["2025"].frozenCalculation).toMatchObject({
        federalPITBeforeExemption: 123.45,
        federalPITTotal: 123.45,
        totalPIT: 99,
      });
    }, 180_000);

    it.each([
      ["alias-only", { federalPITTotal: 10 }],
      ["divergent", { federalPITBeforeExemption: 11, federalPITTotal: 10 }],
      ["non-numeric", { federalPITBeforeExemption: 10, federalPITTotal: "10" }],
    ])(
      "fails atomically for %s data",
      async (_label, frozenCalculation) => {
        const value = { 2025: { frozenCalculation }, untouched: { value: 1 } };
        await setValue(value);

        await expect(alembic("upgrade", TARGET)).rejects.toThrow();
        expect(await getValue()).toEqual(value);
      },
      180_000,
    );
  },
);
