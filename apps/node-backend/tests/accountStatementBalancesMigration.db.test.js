/**
 * Migration 0098 acceptance fixture.
 *
 * Runs in a throwaway database derived from TEST_DATABASE_URL. It proves that
 * the legacy scalar balance is copied into the account's declared currency,
 * that the per-currency side table owns its documented constraints and
 * lifecycle, and that downgrade deliberately retains only the declared-
 * currency projection because the older schema cannot represent foreign rows.
 */
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
const BEFORE = "0097_dividend_amount_convention";
const TARGET = "0098_account_statement_balances";

function scratchDbName() {
  const base = new URL(
    process.env.TEST_DATABASE_URL ?? "postgres://x/x",
  ).pathname.replace(/^\//, "");
  return `${base}_statement_balances_0098`;
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

async function rows(sql, params) {
  return /** @type {pg.Client} */ (db).query(sql, params).then((r) => r.rows);
}

async function scalar(sql, params) {
  const result = await rows(sql, params);
  return result[0] ? Object.values(result[0])[0] : undefined;
}

describe.skipIf(!hasTestDatabase())(
  "migration 0098 account statement balances",
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
        `INSERT INTO accounts
           (id, name, display_name, currency, statement_balance, statement_balance_date)
         VALUES
           (1, '0098 EUR account', 'EUR account', 'EUR', 123.4567, '2026-08-31'),
           (2, '0098 USD account', 'USD account', 'USD', -45.6789, '2026-09-01'),
           (3, '0098 no balance', 'No balance', 'GBP', NULL, NULL)`,
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

    it("upgrades, preserves the declared projection on downgrade, and re-upgrades", async () => {
      await alembic("upgrade", TARGET);

      expect(await scalar("SELECT version_num FROM alembic_version")).toBe(
        TARGET,
      );
      expect(
        await rows(`
          SELECT account_id, currency, balance::text, balance_date::text
            FROM account_statement_balances
           ORDER BY account_id, currency`),
      ).toEqual([
        {
          account_id: 1,
          currency: "EUR",
          balance: "123.4567",
          balance_date: "2026-08-31",
        },
        {
          account_id: 2,
          currency: "USD",
          balance: "-45.6789",
          balance_date: "2026-09-01",
        },
      ]);
      expect(
        await rows(`
          SELECT conname
            FROM pg_constraint
           WHERE conrelid = 'account_statement_balances'::regclass
             AND contype <> 'n'
           ORDER BY conname`),
      ).toEqual([
        { conname: "chk_account_statement_balances_currency_iso" },
        { conname: "fk_account_statement_balances_account" },
        { conname: "pk_account_statement_balances" },
      ]);
      await expect(
        db.query(
          `INSERT INTO account_statement_balances
             (account_id, currency, balance, balance_date)
           VALUES (1, 'usd', 1, '2026-09-02')`,
        ),
      ).rejects.toMatchObject({ code: "23514" });

      // The side table supports multiple native currencies and cascades with
      // its owner while the compatibility scalar remains deliberately stale.
      await db.query(
        `INSERT INTO account_statement_balances
           (account_id, currency, balance, balance_date)
         VALUES (1, 'USD', 88.0001, '2026-09-02'),
                (3, 'USD', 10.0000, '2026-09-03')`,
      );
      await db.query(
        `UPDATE account_statement_balances
            SET balance = 222.2222, balance_date = '2026-09-04'
          WHERE account_id = 1 AND currency = 'EUR'`,
      );
      await db.query(
        `INSERT INTO accounts (id, name, display_name, currency)
         VALUES (4, '0098 cascade', 'Cascade', 'EUR')`,
      );
      await db.query(
        `INSERT INTO account_statement_balances
           (account_id, currency, balance, balance_date)
         VALUES (4, 'EUR', 1, '2026-09-04')`,
      );
      await db.query("DELETE FROM accounts WHERE id = 4");
      expect(
        Number(
          await scalar(
            "SELECT count(*) FROM account_statement_balances WHERE account_id = 4",
          ),
        ),
      ).toBe(0);

      await alembic("downgrade", BEFORE);

      expect(
        await scalar("SELECT to_regclass('public.account_statement_balances')"),
      ).toBeNull();
      expect(
        await rows(`
          SELECT id, statement_balance::text, statement_balance_date::text
            FROM accounts
           WHERE id IN (1, 2, 3)
           ORDER BY id`),
      ).toEqual([
        {
          id: 1,
          statement_balance: "222.2222",
          statement_balance_date: "2026-09-04",
        },
        {
          id: 2,
          statement_balance: "-45.6789",
          statement_balance_date: "2026-09-01",
        },
        {
          id: 3,
          statement_balance: null,
          statement_balance_date: null,
        },
      ]);

      // Re-upgrade recreates the table from the only representation available
      // before 0098. Foreign USD rows for the EUR/GBP accounts are therefore
      // intentionally absent, while declared-currency values survive exactly.
      await alembic("upgrade", TARGET);
      expect(
        await rows(`
          SELECT account_id, currency, balance::text, balance_date::text
            FROM account_statement_balances
           ORDER BY account_id, currency`),
      ).toEqual([
        {
          account_id: 1,
          currency: "EUR",
          balance: "222.2222",
          balance_date: "2026-09-04",
        },
        {
          account_id: 2,
          currency: "USD",
          balance: "-45.6789",
          balance_date: "2026-09-01",
        },
      ]);
    }, 180_000);
  },
);
