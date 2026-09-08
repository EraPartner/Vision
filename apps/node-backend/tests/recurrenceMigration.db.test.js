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
const BEFORE = "0098_account_statement_balances";
const TARGET = "0099_canonical_biweekly_recurrence";

function scratchDbName() {
  const base = new URL(
    process.env.TEST_DATABASE_URL ?? "postgres://x/x",
  ).pathname.replace(/^\//, "");
  return `${base}_recurrence_0099`;
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

async function scalar(sql) {
  const result = await db.query(sql);
  return result.rows[0] ? Object.values(result.rows[0])[0] : undefined;
}

describe.skipIf(!hasTestDatabase())(
  "migration 0099 canonical recurrence",
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
      await db.query(
        `INSERT INTO investments (id, name, asset_class, currency)
       VALUES (1, 'Recurrence fixture', 'stock', 'EUR')`,
      );
      await db.query(
        `INSERT INTO portfolio_transactions
         (investment_id, type, date, amount, currency, is_recurring, recurrence_interval)
       VALUES (1, 'dividend', '2026-09-01', 10, 'EUR', true, 'bi-weekly')`,
      );
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

    it("rewrites, constrains, downgrades, and re-upgrades the stored cadence", async () => {
      await alembic("upgrade", TARGET);
      expect(
        await scalar(
          "SELECT recurrence_interval FROM portfolio_transactions WHERE investment_id = 1",
        ),
      ).toBe("biweekly");
      expect(
        await scalar(
          `SELECT data_type FROM information_schema.columns
         WHERE table_name = 'portfolio_transactions'
           AND column_name = 'recurrence_interval'`,
        ),
      ).toBe("text");
      await expect(
        db.query(
          "UPDATE portfolio_transactions SET recurrence_interval = 'bi-weekly' WHERE investment_id = 1",
        ),
      ).rejects.toMatchObject({ code: "23514" });

      await alembic("downgrade", BEFORE);
      expect(
        await scalar(
          "SELECT recurrence_interval::text FROM portfolio_transactions WHERE investment_id = 1",
        ),
      ).toBe("bi-weekly");

      await alembic("upgrade", TARGET);
      expect(
        await scalar(
          "SELECT recurrence_interval FROM portfolio_transactions WHERE investment_id = 1",
        ),
      ).toBe("biweekly");
    }, 180_000);
  },
);
