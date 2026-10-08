import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { installFreshBaseline } from "../src/database/freshBaseline.ts";
import { hasTestDatabase } from "./setup/db.ts";

const run = promisify(execFile);
const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const previous = "0121_portfolio_asset_transfers";
const target = "0122_portfolio_import_duplicate_repair";
const scratchName = `vision_repairs_0122_${process.pid}`;
const scratchUrl = () => {
  const url = new URL(process.env.TEST_DATABASE_URL);
  url.pathname = `/${scratchName}`;
  return url.toString();
};
let db;
const migrate = (...args) =>
  run(
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

describe.skipIf(
  !hasTestDatabase() || process.env.VISION_TEST_DB_ISOLATED !== "1",
)("migration 0122 reviewed duplicate repair receipts", () => {
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
    await migrate("upgrade", previous);
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

  it("upgrades, downgrades and re-upgrades without changing any existing financial row", async () => {
    const investment = (
      await db.query(
        "INSERT INTO investments(name,symbol,asset_class,currency) VALUES ('Repair migration canary','REP0122','stock','EUR') RETURNING id",
      )
    ).rows[0].id;
    const transaction = (
      await db.query(
        "INSERT INTO portfolio_transactions(investment_id,type,date,amount,units,currency,note) VALUES ($1,'buy','2026-01-01',100,1,'EUR','Original migration canary') RETURNING to_jsonb(portfolio_transactions) AS data",
        [investment],
      )
    ).rows[0].data;
    await migrate("upgrade", target);
    expect(
      (
        await db.query(
          "SELECT to_regclass('portfolio_import_duplicate_repair_journal') AS name",
        )
      ).rows[0].name,
    ).toBeTruthy();
    await migrate("downgrade", previous);
    expect(
      (
        await db.query(
          "SELECT to_regclass('portfolio_import_duplicate_repair_journal') AS name",
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

  it("keeps active repairs and their provenance until a valid inverse receipt permits downgrade", async () => {
    const batch = (
      await db.query(
        "INSERT INTO portfolio_import_batches(adapter_name,status) VALUES ('synthetic','complete') RETURNING id",
      )
    ).rows[0].id;
    const row = (
      await db.query(
        "INSERT INTO portfolio_import_staging_rows(batch_id,row_index,status,raw_data) VALUES ($1,0,'duplicate','Synthetic repair lifecycle source') RETURNING id",
        [batch],
      )
    ).rows[0].id;
    const before = {
      legacy: { id: 1, updated_at: "before" },
      imported: { id: 2 },
      originalBatch: { rows_imported: 1 },
      originalStaging: [{ id: row, status: "committed", updated_at: "before" }],
    };
    const after = {
      legacy: { id: 1, updated_at: "after" },
      imported: null,
      originalBatch: { rows_imported: 0 },
      originalStaging: [{ id: row, status: "duplicate", updated_at: "after" }],
    };
    const receipt = (
      await db.query(
        "INSERT INTO portfolio_import_duplicate_repair_journal(batch_id,staging_row_id,original_import_batch_id,legacy_transaction_id,imported_transaction_id,action,policy,before_data,after_data) VALUES($1,$2,$1,1,2,'repair','prefer_source',$3,$4) RETURNING id",
        [batch, row, JSON.stringify(before), JSON.stringify(after)],
      )
    ).rows[0].id;
    await expect(
      db.query(
        "UPDATE portfolio_import_duplicate_repair_journal SET policy='preserve_existing' WHERE id=$1",
        [receipt],
      ),
    ).rejects.toThrow("immutable");
    await expect(
      db.query("DELETE FROM portfolio_import_batches WHERE id=$1", [batch]),
    ).rejects.toThrow(/foreign key constraint/);
    await expect(migrate("downgrade", previous)).rejects.toMatchObject({
      stderr: expect.stringContaining(
        "Restore active portfolio duplicate repairs before downgrade",
      ),
    });
    expect(
      (await db.query("SELECT version_num FROM alembic_version")).rows[0]
        .version_num,
    ).toBe(target);
    await expect(
      db.query(
        "INSERT INTO portfolio_import_duplicate_repair_journal(batch_id,staging_row_id,original_import_batch_id,legacy_transaction_id,imported_transaction_id,action,policy,before_data,after_data,previous_entry_id) VALUES($1,$2,$1,1,2,'restore','prefer_source',$3,$4,$5)",
        [
          batch,
          row,
          JSON.stringify(after),
          JSON.stringify({ ...before, imported: null }),
          receipt,
        ],
      ),
    ).rejects.toThrow("Invalid portfolio duplicate repair restoration receipt");
    const restored = {
      ...before,
      legacy: { ...before.legacy, updated_at: "restored" },
      originalStaging: [
        { ...before.originalStaging[0], updated_at: "restored" },
      ],
    };
    await db.query(
      "INSERT INTO portfolio_import_duplicate_repair_journal(batch_id,staging_row_id,original_import_batch_id,legacy_transaction_id,imported_transaction_id,action,policy,before_data,after_data,previous_entry_id) VALUES($1,$2,$1,1,2,'restore','prefer_source',$3,$4,$5)",
      [batch, row, JSON.stringify(after), JSON.stringify(restored), receipt],
    );
    await migrate("downgrade", previous);
    await migrate("upgrade", target);
    expect(
      (
        await db.query(
          "SELECT COUNT(*)::integer AS n FROM portfolio_import_duplicate_repair_journal",
        )
      ).rows[0].n,
    ).toBe(0);
  }, 180000);
});
