import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { installFreshBaseline } from "../src/database/freshBaseline.ts";
import { hasTestDatabase } from "./setup/db.ts";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const before = "0119_squashed_baseline";
const target = "0120_portfolio_import_reconciliation";
const scratchName = `vision_receipts_0120_${process.pid}`;
const scratchUrl = () => {
  const url = new URL(process.env.TEST_DATABASE_URL!);
  url.pathname = `/${scratchName}`;
  return url.toString();
};
let db: pg.Client;
const migrate = (...args: string[]) =>
  execFileAsync(
    process.env.ALEMBIC_BIN || "alembic",
    ["-c", path.join(repoRoot, "config/alembic.ini"), ...args],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        DATABASE_URL: scratchUrl(),
        DATABASE_URL_MIGRATIONS: scratchUrl(),
      },
      timeout: 120000,
    },
  );

// This lifecycle mutates only a fresh scratch DB inside the disposable harness.
describe.skipIf(
  !hasTestDatabase() || process.env.VISION_TEST_DB_ISOLATED !== "1",
)("migration 0120 adoption receipts", () => {
  beforeAll(async () => {
    const admin = new pg.Client({
      connectionString: process.env.TEST_DATABASE_URL,
    });
    await admin.connect();
    await admin.query(
      `CREATE DATABASE ${scratchName} WITH TEMPLATE template0 ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C'`,
    );
    await admin.end();
    await installFreshBaseline({ repoRoot, connectionString: scratchUrl() });
    db = new pg.Client({ connectionString: scratchUrl() });
    await db.connect();
  }, 180000);
  afterAll(async () => {
    if (db) await db.end();
    const admin = new pg.Client({
      connectionString: process.env.TEST_DATABASE_URL,
    });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${scratchName} WITH (FORCE)`);
    await admin.end();
  });

  it("upgrades, downgrades and re-upgrades without changing existing financial rows", async () => {
    const investment = (
      await db.query(
        "INSERT INTO investments(name,symbol,asset_class,currency) VALUES ('Migration canary','MIGCANARY','stock','EUR') RETURNING id",
      )
    ).rows[0].id;
    const transaction = (
      await db.query(
        "INSERT INTO portfolio_transactions(investment_id,type,date,amount,units,price_per_unit,currency,note) VALUES ($1,'buy','2026-01-01',100,1,100,'EUR','Retain this original record') RETURNING to_jsonb(portfolio_transactions) AS data",
        [investment],
      )
    ).rows[0].data;
    await migrate("upgrade", target);
    expect(
      (
        await db.query(
          "SELECT to_regclass('portfolio_import_reconciliation_journal') AS name",
        )
      ).rows[0].name,
    ).toBeTruthy();
    await migrate("downgrade", before);
    expect(
      (
        await db.query(
          "SELECT to_regclass('portfolio_import_reconciliation_journal') AS name",
        )
      ).rows[0].name,
    ).toBeNull();
    expect(
      (
        await db.query(
          "SELECT to_jsonb(pt) AS data FROM portfolio_transactions pt WHERE id=$1",
          [transaction.id],
        )
      ).rows[0].data,
    ).toEqual(transaction);
    await migrate("upgrade", target);
  }, 180000);

  it("refuses active adoption downgrade atomically and permits it after an append-only restoration", async () => {
    const batch = (
      await db.query(
        "INSERT INTO portfolio_import_batches(adapter_name,status) VALUES ('synthetic','complete') RETURNING id",
      )
    ).rows[0].id;
    const row = (
      await db.query(
        "INSERT INTO portfolio_import_staging_rows(batch_id,row_index,status,raw_data) VALUES ($1,0,'duplicate','Synthetic migration source') RETURNING id",
        [batch],
      )
    ).rows[0].id;
    const receipt = (
      await db.query(
        "INSERT INTO portfolio_import_reconciliation_journal(batch_id,staging_row_id,transaction_id,action,policy,before_data,after_data) VALUES ($1,$2,1,'adopt','exact','{}','{}') RETURNING id",
        [batch, row],
      )
    ).rows[0].id;
    await expect(migrate("downgrade", before)).rejects.toMatchObject({
      stderr: expect.stringContaining(
        "Restore active portfolio import adoptions before downgrade",
      ),
    });
    expect(
      (await db.query("SELECT version_num FROM alembic_version")).rows[0]
        .version_num,
    ).toBe(target);
    expect(
      (
        await db.query(
          "SELECT COUNT(*)::integer AS n FROM portfolio_import_reconciliation_journal",
        )
      ).rows[0].n,
    ).toBe(1);
    await db.query(
      "INSERT INTO portfolio_import_reconciliation_journal(batch_id,staging_row_id,transaction_id,action,policy,before_data,after_data,previous_entry_id) VALUES ($1,$2,1,'restore','exact','{}','{}',$3)",
      [batch, row, receipt],
    );
    await migrate("downgrade", before);
    expect(
      (
        await db.query(
          "SELECT to_regclass('portfolio_import_reconciliation_journal') AS name",
        )
      ).rows[0].name,
    ).toBeNull();
  }, 180000);
});
