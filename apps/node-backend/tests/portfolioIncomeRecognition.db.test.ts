/**
 * Durable income recognition on the migrated schema: the receipt snapshot
 * function keeps the pre-income-role image byte-equivalent, the role CHECKs
 * and the active-pair guard hold, and in-kind income no longer needs a
 * receipt (ADR-236).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import type { Client } from "pg";
import { hasTestDatabase } from "./setup/db.ts";
import {
  createMigratedDatabase,
  hasIsolatedTestDatabase,
} from "./setup/migratedDatabase.ts";
import type { DisposableDatabase } from "./setup/migratedDatabase.ts";
import { must } from "./helpers/must.ts";

/** A row from an ad-hoc SQL read: column values are narrowed where used. */
type DbRow = Record<string, unknown>;
interface IdRow {
  id: number;
}
/** BIGINT ids arrive from node-postgres as strings. */
interface BigIdRow {
  id: string;
}

let scratch: DisposableDatabase | undefined;
let db: Client | undefined;
let investment: unknown;
let oldJournal: unknown[];
let oldImage: Record<string, unknown>;
let oldTxn: unknown;
let batch: unknown;
let source: unknown;
const oldSnapshot = `jsonb_build_object('id',t.id,'investment_id',t.investment_id,'type',t.type,'date',to_char(t.date,'YYYY-MM-DD'),'amount',t.amount::text,'units',t.units::text,'price_per_unit',t.price_per_unit::text,'fees',t.fees::text,'taxes',t.taxes::text,'currency',t.currency,'fx_rate_to_eur',t.fx_rate_to_eur::text,'account_id',t.account_id,'note',t.note,'dividend_amount_convention',t.dividend_amount_convention,'is_recurring',t.is_recurring,'recurrence_interval',t.recurrence_interval,'recurrence_end_date',to_char(t.recurrence_end_date,'YYYY-MM-DD'),'import_batch_id',t.import_batch_id::text,'source_record_hash',t.source_record_hash,'dedup_fingerprint',t.dedup_fingerprint,'dedup_fingerprint_version',t.dedup_fingerprint_version)`;
describe.skipIf(!hasTestDatabase() || !hasIsolatedTestDatabase())(
  "durable portfolio income recognition",
  () => {
    beforeAll(async () => {
      scratch = await createMigratedDatabase("c_income");
      db = new pg.Client({ connectionString: scratch.url });
      await db.connect();
      investment = must((
        await db.query<IdRow>(
          "INSERT INTO investments(name,symbol,asset_class,currency) VALUES('Income migration canary','INCOME','metals','EUR') RETURNING id",
        )
      ).rows[0], "query row").id;
      oldTxn = must((
        await db.query<IdRow>(
          "INSERT INTO portfolio_transactions(investment_id,type,date,amount,units,price_per_unit,fees,taxes,currency,note) VALUES($1,'gift','2026-01-01',0,2,0,0,0,'EUR','Legacy note') RETURNING id",
          [investment],
        )
      ).rows[0], "query row").id;
      oldImage = must((
        await db.query<{ data: Record<string, unknown> }>(
          `SELECT ${oldSnapshot} AS data FROM portfolio_transactions t WHERE id=$1`,
          [oldTxn],
        )
      ).rows[0], "query row").data;
      batch = must((
        await db.query<BigIdRow>(
          "INSERT INTO portfolio_import_batches(adapter_name,status,custom_config) VALUES('kinesis_transaction_history','awaiting_review',$1) RETURNING id",
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
        "INSERT INTO portfolio_import_reconciliation_journal(batch_id,staging_row_id,transaction_id,action,policy,before_data,after_data) VALUES($1,$2,$3,'adopt','preserve_existing',$4,$4)",
        [batch, source, oldTxn, JSON.stringify(oldImage)],
      );
      oldJournal = (
        await db.query<DbRow>(
          "SELECT to_jsonb(r) AS data FROM portfolio_import_reconciliation_journal r",
        )
      ).rows;
    }, 180000);
    afterAll(async () => {
      if (db) await db.end();
      await scratch?.drop();
    });
    it("defaults to the standard role and keeps existing receipt images byte-equivalent", async () => {
      expect(
        (
          await must(db, "db").query<DbRow>(
            "SELECT portfolio_income_transaction_snapshot(t) AS data,income_recognition_role FROM portfolio_transactions t WHERE id=$1",
            [oldTxn],
          )
        ).rows[0],
      ).toEqual({ data: oldImage, income_recognition_role: "standard" });
      expect(
        must((
          await must(db, "db").query<DbRow>(
            "SELECT COUNT(*)::int AS n FROM portfolio_import_income_recognition_journal",
          )
        ).rows[0], "query row").n,
      ).toBe(0);
      expect(
        (
          await must(db, "db").query<DbRow>(
            "SELECT to_jsonb(r) AS data FROM portfolio_import_reconciliation_journal r",
          )
        ).rows,
      ).toEqual(oldJournal);
      const cas = await must(db, "db").query<IdRow>(
        "UPDATE portfolio_transactions t SET note=note WHERE id=$1 AND portfolio_income_transaction_snapshot(t)=normalize_portfolio_income_snapshot($2) RETURNING id",
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
          "INSERT INTO portfolio_transactions(investment_id,type,date,amount,currency,income_recognition_role) VALUES($1,'dividend','2026-01-01',1,'EUR','included_in_units') RETURNING id",
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
      await must(db, "db").query("BEGIN");
      const income = must((
        await must(db, "db").query<IdRow>(
          "INSERT INTO portfolio_transactions(investment_id,type,date,amount,fees,taxes,currency,income_recognition_role) VALUES($1,'dividend','2026-01-01',1,0,0,'EUR','included_in_units') RETURNING id",
          [investment],
        )
      ).rows[0], "query row").id;
      const journal = must((
        await must(db, "db").query<BigIdRow>(
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
      ).rows[0], "query row").id;
      await must(db, "db").query("COMMIT");
      await expect(
        must(db, "db").query<DbRow>(
          "UPDATE portfolio_transactions SET date='2026-01-02' WHERE id=$1",
          [oldTxn],
        ),
      ).rejects.toThrow(/paired income/);
      await expect(
        must(db, "db").query<DbRow>("DELETE FROM portfolio_transactions WHERE id=$1", [income]),
      ).rejects.toThrow(/paired income/);
      await must(db, "db").query("BEGIN");
      await must(db, "db").query(
        "INSERT INTO portfolio_import_income_recognition_journal(batch_id,staging_row_id,unit_staging_row_id,income_transaction_id,unit_transaction_id,action,previous_entry_id,income_data,unit_data,proof_data) SELECT batch_id,staging_row_id,unit_staging_row_id,income_transaction_id,unit_transaction_id,'restore',id,income_data,unit_data,proof_data FROM portfolio_import_income_recognition_journal WHERE id=$1",
        [journal],
      );
      await must(db, "db").query("DELETE FROM portfolio_transactions WHERE id=$1", [
        income,
      ]);
      await must(db, "db").query("COMMIT");
      expect(
        must((
          await must(db, "db").query<DbRow>(
            "SELECT COUNT(*)::int AS n FROM portfolio_transactions WHERE id=$1",
            [income],
          )
        ).rows[0], "query row").n,
      ).toBe(0);
      expect(
        (
          await must(db, "db").query<DbRow>(
            "SELECT to_jsonb(r) AS data FROM portfolio_import_reconciliation_journal r",
          )
        ).rows,
      ).toEqual(oldJournal);
    });
  },
);
