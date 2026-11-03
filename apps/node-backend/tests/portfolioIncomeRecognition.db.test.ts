/**
 * Durable income recognition on the migrated schema: the receipt snapshot
 * function keeps the pre-income-role image byte-equivalent, the role CHECKs
 * and the active-pair guard hold, and in-kind income no longer needs a
 * receipt (ADR-236).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  closeTestPool,
  getTestPool,
  hasTestDatabase,
  resetTestDatabase,
} from "./setup/db.ts";
import type { TestPool } from "./setup/db.ts";
import { withTransaction } from "../src/database/connection.ts";
import { portfolioIncomeTransactionSnapshotSql } from "../src/database/sqlite/schemaFunctions.ts";
import { must } from "./helpers/must.ts";

/** A row from an ad-hoc SQL read: column values are narrowed where used. */
type DbRow = Record<string, unknown>;
interface IdRow {
  id: number;
}
/** BIGINT ids arrive from the driver as strings. */
interface BigIdRow {
  id: string;
}

// Each test file has its own copy of the migrated template, so this file's
// database is the isolated scratch database the PostgreSQL suite created;
// resetTestDatabase() starts it from the pristine schema with empty journals.
let db: TestPool | undefined;
let investment: unknown;
let oldJournal: unknown[];
let oldImage: Record<string, unknown>;
let oldTxn: unknown;
let batch: unknown;
let source: unknown;
/** The snapshot of `alias`, as the schema's snapshot function computes it. */
const snapshot = portfolioIncomeTransactionSnapshotSql;
/**
 * The pre-income-role receipt image, built independently of the snapshot
 * function: the PostgreSQL suite's jsonb_build_object, as json_object.
 */
const oldSnapshot = `vision_jsonb(json_object('id',t.id,'investment_id',t.investment_id,'type',t.type,'date',to_char(t.date,'YYYY-MM-DD'),'amount',t.amount,'units',t.units,'price_per_unit',t.price_per_unit,'fees',t.fees,'taxes',t.taxes,'currency',t.currency,'fx_rate_to_eur',t.fx_rate_to_eur,'account_id',t.account_id,'note',t.note,'dividend_amount_convention',t.dividend_amount_convention,'is_recurring',json(iif(t.is_recurring,'true','false')),'recurrence_interval',t.recurrence_interval,'recurrence_end_date',to_char(t.recurrence_end_date,'YYYY-MM-DD'),'import_batch_id',CAST(t.import_batch_id AS TEXT),'source_record_hash',t.source_record_hash,'dedup_fingerprint',t.dedup_fingerprint,'dedup_fingerprint_version',t.dedup_fingerprint_version))`;
/** Every reconciliation journal row, as the driver reads it (PostgreSQL: to_jsonb(r)). */
const JOURNAL_ROWS =
  "SELECT * FROM portfolio_import_reconciliation_journal ORDER BY id";
describe.skipIf(!hasTestDatabase())(
  "durable portfolio income recognition",
  () => {
    beforeAll(async () => {
      await resetTestDatabase();
      db = getTestPool();
      investment = must((
        await db.query<IdRow>(
          "INSERT INTO investments(name,symbol,asset_class,currency) VALUES('Income migration canary','INCOME','metals','EUR') RETURNING id",
        )
      ).rows[0], "query row").id;
      oldTxn = must((
        await db.query<IdRow>(
          "INSERT INTO portfolio_transactions(investment_id,type,date,amount,units,price_per_unit,fees,taxes,currency,note) VALUES($1,'gift','2026-01-01','0.0000','2.00000000','0.000000','0.0000','0.0000','EUR','Legacy note') RETURNING id",
          [investment],
        )
      ).rows[0], "query row").id;
      oldImage = must((
        await db.query<{ data: Record<string, unknown> }>(
          `SELECT ${oldSnapshot} AS "data::json" FROM portfolio_transactions t WHERE id=$1`,
          [oldTxn],
        )
      ).rows[0], "query row").data;
      batch = must((
        await db.query<BigIdRow>(
          "INSERT INTO portfolio_import_batches(adapter_name,status,custom_config) VALUES('kinesis_transaction_history','awaiting_review',vision_jsonb($1)) RETURNING id",
          [
            JSON.stringify({
              format: "kinesis_transaction_history",
              yield_basis_policy: "zero",
              kinesis_source_context: { source_file_hash: "f".repeat(64) },
            }),
          ],
        )
      ).rows[0], "query row").id;
      source = must((
        await db.query<BigIdRow>(
          "INSERT INTO portfolio_import_staging_rows(batch_id,row_index,status,raw_data,type,route) VALUES($1,0,'duplicate','Synthetic legacy source','gift','portfolio') RETURNING id",
          [batch],
        )
      ).rows[0], "query row").id;
      await db.query(
        "INSERT INTO portfolio_import_reconciliation_journal(batch_id,staging_row_id,transaction_id,action,policy,before_data,after_data) VALUES($1,$2,$3,'adopt','preserve_existing',vision_jsonb($4),vision_jsonb($4))",
        [batch, source, oldTxn, JSON.stringify(oldImage)],
      );
      oldJournal = (await db.query<DbRow>(JOURNAL_ROWS)).rows;
      expect(oldJournal).toHaveLength(1);
    }, 180000);
    afterAll(async () => {
      await closeTestPool();
    });
    it("defaults to the standard role and keeps existing receipt images byte-equivalent", async () => {
      expect(
        (
          await must(db, "db").query<DbRow>(
            `SELECT ${snapshot("t")} AS "data::json",income_recognition_role FROM portfolio_transactions t WHERE id=$1`,
            [oldTxn],
          )
        ).rows[0],
      ).toEqual({ data: oldImage, income_recognition_role: "standard" });
      // Byte-equivalent: the canonical jsonb text of both images is equal.
      expect(
        (
          await must(db, "db").query<DbRow>(
            `SELECT ${snapshot("t")} = ${oldSnapshot} AS "same::bool" FROM portfolio_transactions t WHERE id=$1`,
            [oldTxn],
          )
        ).rows[0],
      ).toEqual({ same: true });
      expect(
        must((
          await must(db, "db").query<DbRow>(
            "SELECT COUNT(*) AS n FROM portfolio_import_income_recognition_journal",
          )
        ).rows[0], "query row").n,
      ).toBe(0);
      expect(
        (await must(db, "db").query<DbRow>(JOURNAL_ROWS)).rows,
      ).toEqual(oldJournal);
      const cas = await must(db, "db").query<IdRow>(
        `UPDATE portfolio_transactions SET note=note WHERE id=$1 AND ${snapshot("portfolio_transactions")}=normalize_portfolio_income_snapshot($2) RETURNING id`,
        [
          oldTxn,
          JSON.stringify({ ...oldImage, income_recognition_role: "standard" }),
        ],
      );
      expect(cas.rows).toHaveLength(1);
    });
    it("rejects unknown/non-dividend roles and accepts in-kind income without a receipt", async () => {
      await expect(
        must(db, "db").query<DbRow>(
          "UPDATE portfolio_transactions SET income_recognition_role='unknown' WHERE id=$1",
          [oldTxn],
        ),
      ).rejects.toThrow(/chk_portfolio_income/);
      await expect(
        must(db, "db").query<DbRow>(
          "UPDATE portfolio_transactions SET income_recognition_role='included_in_units' WHERE id=$1",
          [oldTxn],
        ),
      ).rejects.toThrow(/chk_portfolio_income/);
      const unpaired = must((
        await must(db, "db").query<IdRow>(
          "INSERT INTO portfolio_transactions(investment_id,type,date,amount,currency,income_recognition_role) VALUES($1,'dividend','2026-01-01','1.0000','EUR','included_in_units') RETURNING id",
          [investment],
        )
      ).rows[0], "query row").id;
      await must(db, "db").query("DELETE FROM portfolio_transactions WHERE id=$1", [
        unpaired,
      ]);
    });
    it("guards unit/income mutation, then restores and deletes income without a permanent history foreign key", async () => {
      const incomeSource = must((
        await must(db, "db").query<BigIdRow>(
          "INSERT INTO portfolio_import_staging_rows(batch_id,row_index,status,raw_data,type,route) VALUES($1,1,'matched','Synthetic paired income','dividend','portfolio') RETURNING id",
          [batch],
        )
      ).rows[0], "query row").id;
      // One writer transaction: the income row and its receipt land together.
      const { income, journal } = await withTransaction(async (client) => {
        const income = must((
          await client.query<IdRow>(
            "INSERT INTO portfolio_transactions(investment_id,type,date,amount,fees,taxes,currency,income_recognition_role) VALUES($1,'dividend','2026-01-01','1.0000','0.0000','0.0000','EUR','included_in_units') RETURNING id",
            [investment],
          )
        ).rows[0], "query row").id;
        const journal = must((
          await client.query<BigIdRow>(
            `INSERT INTO portfolio_import_income_recognition_journal(batch_id,staging_row_id,unit_staging_row_id,income_transaction_id,unit_transaction_id,action,income_data,unit_data,proof_data) SELECT $1,$2,$3,i.id,u.id,'record',${snapshot("i")},${snapshot("u")},vision_jsonb($4) FROM portfolio_transactions i,portfolio_transactions u WHERE i.id=$5 AND u.id=$6 RETURNING id`,
            [
              batch,
              incomeSource,
              source,
              JSON.stringify({ sourceFileHash: "f".repeat(64) }),
              income,
              oldTxn,
            ],
          )
        ).rows[0], "query row").id;
        return { income, journal };
      });
      await expect(
        must(db, "db").query<DbRow>(
          "UPDATE portfolio_transactions SET date='2026-01-02' WHERE id=$1",
          [oldTxn],
        ),
      ).rejects.toThrow(/paired income/);
      await expect(
        must(db, "db").query<DbRow>("DELETE FROM portfolio_transactions WHERE id=$1", [income]),
      ).rejects.toThrow(/paired income/);
      await withTransaction(async (client) => {
        await client.query(
          "INSERT INTO portfolio_import_income_recognition_journal(batch_id,staging_row_id,unit_staging_row_id,income_transaction_id,unit_transaction_id,action,previous_entry_id,income_data,unit_data,proof_data) SELECT batch_id,staging_row_id,unit_staging_row_id,income_transaction_id,unit_transaction_id,'restore',id,income_data,unit_data,proof_data FROM portfolio_import_income_recognition_journal WHERE id=$1",
          [journal],
        );
        await client.query("DELETE FROM portfolio_transactions WHERE id=$1", [
          income,
        ]);
      });
      expect(
        must((
          await must(db, "db").query<DbRow>(
            "SELECT COUNT(*) AS n FROM portfolio_transactions WHERE id=$1",
            [income],
          )
        ).rows[0], "query row").n,
      ).toBe(0);
      expect(
        (await must(db, "db").query<DbRow>(JOURNAL_ROWS)).rows,
      ).toEqual(oldJournal);
    });
  },
);
