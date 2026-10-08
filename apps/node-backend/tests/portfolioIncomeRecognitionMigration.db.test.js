import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { installFreshBaseline } from "../src/database/freshBaseline.ts";
import { hasTestDatabase } from "./setup/db.ts";
const run = promisify(execFile);
const repo = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const before = "0123_portfolio_asset_adjustments",
  target = "0124_portfolio_income_recognition";
const name = `vision_income_0124_${process.pid}`;
const url = () => {
  const value = new URL(process.env.TEST_DATABASE_URL);
  value.pathname = `/${name}`;
  return value.toString();
};
let db;
let investment;
let oldJournal;
let oldImage;
let oldTxn;
let batch;
let source;
const migrate = (...args) =>
  run(
    process.env.ALEMBIC_BIN || "alembic",
    ["-c", path.join(repo, "config/alembic.ini"), ...args],
    {
      cwd: repo,
      env: {
        ...process.env,
        DATABASE_URL: url(),
        DATABASE_URL_MIGRATIONS: url(),
      },
      timeout: 120000,
    },
  );
const oldSnapshot = `jsonb_build_object('id',t.id,'investment_id',t.investment_id,'type',t.type,'date',to_char(t.date,'YYYY-MM-DD'),'amount',t.amount::text,'units',t.units::text,'price_per_unit',t.price_per_unit::text,'fees',t.fees::text,'taxes',t.taxes::text,'currency',t.currency,'fx_rate_to_eur',t.fx_rate_to_eur::text,'account_id',t.account_id,'note',t.note,'dividend_amount_convention',t.dividend_amount_convention,'is_recurring',t.is_recurring,'recurrence_interval',t.recurrence_interval,'recurrence_end_date',to_char(t.recurrence_end_date,'YYYY-MM-DD'),'import_batch_id',t.import_batch_id::text,'source_record_hash',t.source_record_hash,'dedup_fingerprint',t.dedup_fingerprint,'dedup_fingerprint_version',t.dedup_fingerprint_version)`;
describe.skipIf(
  !hasTestDatabase() || process.env.VISION_TEST_DB_ISOLATED !== "1",
)("migration 0124 durable income", () => {
  beforeAll(async () => {
    const admin = new pg.Client({
      connectionString: process.env.TEST_DATABASE_URL,
    });
    await admin.connect();
    await admin.query(
      `CREATE DATABASE ${name} WITH TEMPLATE template0 ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C'`,
    );
    await admin.end();
    await installFreshBaseline({ repoRoot: repo, connectionString: url() });
    await migrate("upgrade", before);
    db = new pg.Client({ connectionString: url() });
    await db.connect();
    investment = (
      await db.query(
        "INSERT INTO investments(name,symbol,asset_class,currency) VALUES('Income migration canary','INCOME','metals','EUR') RETURNING id",
      )
    ).rows[0].id;
    oldTxn = (
      await db.query(
        "INSERT INTO portfolio_transactions(investment_id,type,date,amount,units,price_per_unit,fees,taxes,currency,note) VALUES($1,'gift','2026-01-01',0,2,0,0,0,'EUR','Legacy note') RETURNING id",
        [investment],
      )
    ).rows[0].id;
    oldImage = (
      await db.query(
        `SELECT ${oldSnapshot} AS data FROM portfolio_transactions t WHERE id=$1`,
        [oldTxn],
      )
    ).rows[0].data;
    batch = (
      await db.query(
        "INSERT INTO portfolio_import_batches(adapter_name,status,custom_config) VALUES('kinesis_transaction_history','awaiting_review',$1) RETURNING id",
        [
          JSON.stringify({
            format: "kinesis_transaction_history",
            yield_basis_policy: "zero",
            kinesis_source_context: { source_file_hash: "f".repeat(64) },
          }),
        ],
      )
    ).rows[0].id;
    source = (
      await db.query(
        "INSERT INTO portfolio_import_staging_rows(batch_id,row_index,status,raw_data,type,route) VALUES($1,0,'duplicate','Synthetic legacy source','gift','portfolio') RETURNING id",
        [batch],
      )
    ).rows[0].id;
    await db.query(
      "INSERT INTO portfolio_import_reconciliation_journal(batch_id,staging_row_id,transaction_id,action,policy,before_data,after_data) VALUES($1,$2,$3,'adopt','preserve_existing',$4,$4)",
      [batch, source, oldTxn, JSON.stringify(oldImage)],
    );
    oldJournal = (
      await db.query(
        "SELECT to_jsonb(r) AS data FROM portfolio_import_reconciliation_journal r",
      )
    ).rows;
  }, 180000);
  afterAll(async () => {
    if (db) await db.end();
    const admin = new pg.Client({
      connectionString: process.env.TEST_DATABASE_URL,
    });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin.end();
  });
  it("adds only default standard role and empty journal; old receipt images remain byte-equivalent", async () => {
    await migrate("upgrade", target);
    expect(
      (
        await db.query(
          "SELECT portfolio_income_transaction_snapshot(t) AS data,income_recognition_role FROM portfolio_transactions t WHERE id=$1",
          [oldTxn],
        )
      ).rows[0],
    ).toEqual({ data: oldImage, income_recognition_role: "standard" });
    expect(
      (
        await db.query(
          "SELECT COUNT(*)::int AS n FROM portfolio_import_income_recognition_journal",
        )
      ).rows[0].n,
    ).toBe(0);
    expect(
      (
        await db.query(
          "SELECT to_jsonb(r) AS data FROM portfolio_import_reconciliation_journal r",
        )
      ).rows,
    ).toEqual(oldJournal);
    const cas = await db.query(
      "UPDATE portfolio_transactions t SET note=note WHERE id=$1 AND portfolio_income_transaction_snapshot(t)=normalize_portfolio_income_snapshot($2) RETURNING id",
      [
        oldTxn,
        JSON.stringify({ ...oldImage, income_recognition_role: "standard" }),
      ],
    );
    expect(cas.rows).toHaveLength(1);
    await migrate("downgrade", before);
    expect(
      (
        await db.query(
          `SELECT ${oldSnapshot} AS data FROM portfolio_transactions t WHERE id=$1`,
          [oldTxn],
        )
      ).rows[0].data,
    ).toEqual(oldImage);
    await migrate("upgrade", target);
  }, 180000);
  it("rejects unknown/non-dividend roles and missing durable pairing", async () => {
    await expect(
      db.query(
        "UPDATE portfolio_transactions SET income_recognition_role='unknown' WHERE id=$1",
        [oldTxn],
      ),
    ).rejects.toThrow(/ck_portfolio_income/);
    await expect(
      db.query(
        "UPDATE portfolio_transactions SET income_recognition_role='included_in_units' WHERE id=$1",
        [oldTxn],
      ),
    ).rejects.toThrow(/ck_portfolio_income/);
    await expect(
      db.query(
        "INSERT INTO portfolio_transactions(investment_id,type,date,amount,currency,income_recognition_role) VALUES($1,'dividend','2026-01-01',1,'EUR','included_in_units')",
        [investment],
      ),
    ).rejects.toThrow(/proved active pair/);
  });
  it("guards active downgrade and unit/income mutation, then restores and deletes income without a permanent history foreign key", async () => {
    const incomeSource = (
      await db.query(
        "INSERT INTO portfolio_import_staging_rows(batch_id,row_index,status,raw_data,type,route) VALUES($1,1,'matched','Synthetic paired income','dividend','portfolio') RETURNING id",
        [batch],
      )
    ).rows[0].id;
    await db.query("BEGIN");
    const income = (
      await db.query(
        "INSERT INTO portfolio_transactions(investment_id,type,date,amount,fees,taxes,currency,income_recognition_role) VALUES($1,'dividend','2026-01-01',1,0,0,'EUR','included_in_units') RETURNING id",
        [investment],
      )
    ).rows[0].id;
    const journal = (
      await db.query(
        `INSERT INTO portfolio_import_income_recognition_journal(batch_id,staging_row_id,unit_staging_row_id,income_transaction_id,unit_transaction_id,action,income_data,unit_data,proof_data) SELECT $1,$2,$3,i.id,u.id,'record',portfolio_income_transaction_snapshot(i),portfolio_income_transaction_snapshot(u),$4 FROM portfolio_transactions i,portfolio_transactions u WHERE i.id=$5 AND u.id=$6 RETURNING id`,
        [
          batch,
          incomeSource,
          source,
          JSON.stringify({ sourceFileHash: "f".repeat(64) }),
          income,
          oldTxn,
        ],
      )
    ).rows[0].id;
    await db.query("COMMIT");
    await expect(migrate("downgrade", before)).rejects.toMatchObject({
      stderr: expect.stringContaining(
        "Roll back included income and active pair receipts",
      ),
    });
    expect(
      (await db.query("SELECT version_num FROM alembic_version")).rows[0]
        .version_num,
    ).toBe(target);
    await expect(
      db.query(
        "UPDATE portfolio_transactions SET date='2026-01-02' WHERE id=$1",
        [oldTxn],
      ),
    ).rejects.toThrow(/paired income/);
    await expect(
      db.query("DELETE FROM portfolio_transactions WHERE id=$1", [income]),
    ).rejects.toThrow(/paired income/);
    await expect(
      db.query(
        "UPDATE portfolio_import_income_recognition_journal SET proof_data=proof_data",
      ),
    ).rejects.toThrow(/immutable/);
    await db.query("BEGIN");
    await db.query(
      "INSERT INTO portfolio_import_income_recognition_journal(batch_id,staging_row_id,unit_staging_row_id,income_transaction_id,unit_transaction_id,action,previous_entry_id,income_data,unit_data,proof_data) SELECT batch_id,staging_row_id,unit_staging_row_id,income_transaction_id,unit_transaction_id,'restore',id,income_data,unit_data,proof_data FROM portfolio_import_income_recognition_journal WHERE id=$1",
      [journal],
    );
    await db.query("DELETE FROM portfolio_transactions WHERE id=$1", [income]);
    await db.query("COMMIT");
    await migrate("downgrade", before);
    expect(
      (
        await db.query(
          "SELECT to_regclass('portfolio_import_income_recognition_journal') AS name",
        )
      ).rows[0].name,
    ).toBeNull();
    expect(
      (
        await db.query(
          "SELECT to_jsonb(r) AS data FROM portfolio_import_reconciliation_journal r",
        )
      ).rows,
    ).toEqual(oldJournal);
    await migrate("upgrade", target);
  }, 180000);
});
