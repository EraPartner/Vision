import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { MockInstance } from "vitest";
import { StatementSync } from "node:sqlite";
import {
  acquireDbSuiteLock,
  releaseDbSuiteLock,
  closeTestPool,
  getTestPool,
  hasTestDatabase,
} from "./setup/db.ts";
import { closePool } from "../src/database/connection.ts";
import { commitBatch } from "../src/services/portfolioImportPipeline/commit.ts";
import { must } from "./helpers/must.ts";
import type { TestPool } from "./setup/db.ts";

/** A row from an ad-hoc SQL read: column values are narrowed where used. */
type DbRow = Record<string, unknown>;
interface IdRow {
  id: number;
}
/** BIGINT ids arrive from the driver as strings. */
interface BigIdRow {
  id: string;
}
let pool: TestPool;
/**
 * Every statement the driver runs, savepoints included, executes through a
 * prepared StatementSync; `sourceSQL` is the statement's text.
 */
type StatementRun = (this: StatementSync, ...params: unknown[]) => unknown;

/**
 * A trigger standing in for PostgreSQL's `ADD CONSTRAINT ... CHECK ... NOT
 * VALID`: SQLite cannot add a CHECK to an existing table. The driver
 * translates its RAISE into SQLSTATE 23514 naming the constraint, as the
 * CHECK failure did.
 */
function failingInsertTrigger(
  name: string,
  table: string,
  column: string,
  value: string,
): string {
  return `CREATE TRIGGER ${name} BEFORE INSERT ON ${table}
    WHEN NEW.${column} = '${value}'
    BEGIN
      SELECT RAISE(ABORT, 'vision:23514:${name}:new row for relation "${table}" violates check constraint "${name}"');
    END`;
}
describe.skipIf(!hasTestDatabase())("real failed-row savepoint release", () => {
  beforeAll(() => {
    pool = must(getTestPool(), "test pool");
  });
  beforeAll(async () => {
    await acquireDbSuiteLock();
  }, 180000);
  afterAll(async () => {
    try {
      await releaseDbSuiteLock();
    } finally {
      try {
        await closeTestPool();
      } finally {
        await closePool();
      }
    }
  });
  it("releases failed trade and cash savepoints before staging errors, then commits siblings", async () => {
    let accountId: number | undefined;
    let investmentId: number | undefined;
    let batchId: number | undefined;
    let runSpy: MockInstance<StatementRun> | undefined;
    let allSpy: MockInstance<StatementRun> | undefined;
    const broker = "VISION SAVEPOINT RELEASE TEST";
    try {
      await pool.query(
        failingInsertTrigger(
          "vision_test_trade_savepoint_failure",
          "portfolio_transactions",
          "note",
          "VISION_TEST_FAIL_TRADE",
        ),
      );
      await pool.query(
        failingInsertTrigger(
          "vision_test_cash_savepoint_failure",
          "transactions",
          "memo",
          "VISION_TEST_FAIL_CASH",
        ),
      );
      accountId = must((
        await pool.query<IdRow>(
          `INSERT INTO accounts(name,display_name,institution) VALUES($1,$1,$1) RETURNING id`,
          [broker],
        )
      ).rows[0], "query row").id;
      investmentId = must((
        await pool.query<IdRow>(`INSERT INTO investments(name,symbol,asset_class,currency)
        VALUES('Savepoint Test Stock','SVPT','stock','EUR') RETURNING id`)
      ).rows[0], "query row").id;
      batchId = Number(
        must((
          await pool.query<BigIdRow>(
            `INSERT INTO portfolio_import_batches(adapter_name,status,rows_total,account_id,is_brokerage,default_asset_class)
        VALUES('generic','awaiting_review',4,$1,true,'stock') RETURNING id`,
            [accountId],
          )
        ).rows[0], "query row").id,
      );
      const stagedIds = [];
      const notes = [
        "VISION_TEST_FAIL_TRADE",
        "SAVEPOINT GOOD TRADE",
        "VISION_TEST_FAIL_CASH",
        "SAVEPOINT GOOD CASH",
      ];
      for (let i = 0; i < 4; i++) {
        const trade = i < 2;
        stagedIds.push(
          Number(
            must((
              await pool.query<BigIdRow>(
                `INSERT INTO portfolio_import_staging_rows
          (batch_id,row_index,status,tx_date,type_raw,type,route,units,price_per_unit,amount,currency,note,resolved_investment_id)
          VALUES($1,$2,'matched',$3,$4,CASE WHEN $5 = 'portfolio' THEN $4 ELSE NULL END,$5,
            vision_numeric($6,18,8),vision_numeric($7,18,6),vision_numeric($8,18,4),'EUR',$9,$10) RETURNING id`,
                [
                  batchId,
                  i,
                  `2026-02-0${i + 1}`,
                  trade ? "buy" : "deposit",
                  trade ? "portfolio" : "cash",
                  trade ? "3" : null,
                  trade ? "100" : null,
                  trade ? "300" : i === 2 ? "10" : "20",
                  notes[i],
                  trade ? investmentId : null,
                ],
              )
            ).rows[0], "query row").id,
          ),
        );
      }
      // Statements that return rows run through all(), the rest through run().
      const prototype = StatementSync.prototype as unknown as Record<
        "run" | "all",
        StatementRun
      >;
      runSpy = vi.spyOn(prototype, "run");
      allSpy = vi.spyOn(prototype, "all");
      expect(await commitBatch({ batchId })).toEqual({
        imported: 2,
        duplicates: 0,
        errors: 2,
      });
      const record = (spy: MockInstance<StatementRun>) =>
        spy.mock.calls.map((params, index) => ({
          order: must(spy.mock.invocationCallOrder[index], "call order"),
          sql: must(spy.mock.contexts[index], "statement").sourceSQL,
          params,
        }));
      const calls = [...record(runSpy), ...record(allSpy)].sort(
        (a, b) => a.order - b.order,
      );
      runSpy.mockRestore();
      allSpy.mockRestore();
      for (const id of [stagedIds[0], stagedIds[2]]) {
        const rollback = calls.findIndex(
          ({ sql }) => sql === `ROLLBACK TO SAVEPOINT sp_prow_${id}`,
        );
        expect(rollback).toBeGreaterThanOrEqual(0);
        expect(must(calls[rollback + 1], "calls[rollback + 1]").sql).toBe(`RELEASE SAVEPOINT sp_prow_${id}`);
        expect(
          calls.findIndex(
            ({ sql, params }) =>
              /UPDATE "?portfolio_import_staging_rows"?/i.test(sql) &&
              params.some((value) => Number(value) === id) &&
              params.includes("error"),
          ),
        ).toBeGreaterThan(rollback + 1);
      }
      const staged = (
        await pool.query<DbRow>(
          "SELECT status,error_message,committed_txn_id FROM portfolio_import_staging_rows WHERE batch_id=$1 ORDER BY row_index",
          [batchId],
        )
      ).rows;
      expect(staged.map((r) => r.status)).toEqual([
        "error",
        "committed",
        "error",
        "committed",
      ]);
      expect(must(staged[0], "staged[0]").error_message).toContain(
        "vision_test_trade_savepoint_failure",
      );
      expect(must(staged[2], "staged[2]").error_message).toContain(
        "vision_test_cash_savepoint_failure",
      );
      expect(must(staged[0], "staged[0]").committed_txn_id).toBeNull();
      expect(must(staged[2], "staged[2]").committed_txn_id).toBeNull();
      expect(
        (
          await pool.query<DbRow>(
            "SELECT note FROM portfolio_transactions WHERE import_batch_id=$1",
            [batchId],
          )
        ).rows,
      ).toEqual([{ note: "SAVEPOINT GOOD TRADE" }]);
      expect(
        (
          await pool.query<DbRow>(
            "SELECT memo,amount FROM transactions WHERE account_id=$1",
            [accountId],
          )
        ).rows,
      ).toEqual([{ memo: "SAVEPOINT GOOD CASH", amount: "20.0000" }]);
      expect(
        (
          await pool.query<DbRow>(
            "SELECT rows_imported,rows_error,rows_duplicate FROM portfolio_import_batches WHERE id=$1",
            [batchId],
          )
        ).rows[0],
      ).toMatchObject({ rows_imported: 2, rows_error: 2, rows_duplicate: 0 });
    } finally {
      runSpy?.mockRestore();
      allSpy?.mockRestore();
      await pool.query(
        "DROP TRIGGER IF EXISTS vision_test_trade_savepoint_failure",
      );
      await pool.query(
        "DROP TRIGGER IF EXISTS vision_test_cash_savepoint_failure",
      );
      if (batchId !== undefined) {
        await pool.query(
          "DELETE FROM portfolio_transactions WHERE import_batch_id=$1",
          [batchId],
        );
        await pool.query("DELETE FROM transactions WHERE account_id=$1", [
          accountId,
        ]);
        await pool.query(
          "DELETE FROM portfolio_import_staging_rows WHERE batch_id=$1",
          [batchId],
        );
        await pool.query("DELETE FROM portfolio_import_batches WHERE id=$1", [
          batchId,
        ]);
      }
      if (investmentId !== undefined)
        await pool.query("DELETE FROM investments WHERE id=$1", [investmentId]);
      if (accountId !== undefined)
        await pool.query("DELETE FROM accounts WHERE id=$1", [accountId]);
      await pool.query("DELETE FROM recipients WHERE name=$1", [broker]);
    }
  });
});
