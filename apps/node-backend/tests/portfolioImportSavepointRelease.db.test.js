import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import pg from "pg";
import {
  acquireDbSuiteLock,
  releaseDbSuiteLock,
  closeTestPool,
  getTestPool,
  hasTestDatabase,
} from "./setup/db.js";
import { closePool } from "../src/database/connection.js";
import { commitBatch } from "../src/services/portfolioImportPipeline/commit.js";
const pool = getTestPool();
describe.skipIf(!hasTestDatabase())("real failed-row savepoint release", () => {
  beforeAll(async () => {
    expect(process.env.DATABASE_URL).toBe(process.env.TEST_DATABASE_URL);
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
    let accountId, investmentId, batchId, querySpy;
    const broker = "VISION SAVEPOINT RELEASE TEST";
    try {
      await pool.query(`ALTER TABLE portfolio_transactions ADD CONSTRAINT vision_test_trade_savepoint_failure
        CHECK (note IS DISTINCT FROM 'VISION_TEST_FAIL_TRADE') NOT VALID`);
      await pool.query(`ALTER TABLE transactions ADD CONSTRAINT vision_test_cash_savepoint_failure
        CHECK (memo IS DISTINCT FROM 'VISION_TEST_FAIL_CASH') NOT VALID`);
      accountId = (
        await pool.query(
          `INSERT INTO accounts(name,display_name,institution) VALUES($1,$1,$1) RETURNING id`,
          [broker],
        )
      ).rows[0].id;
      investmentId = (
        await pool.query(`INSERT INTO investments(name,symbol,asset_class,currency)
        VALUES('Savepoint Test Stock','SVPT','stock','EUR') RETURNING id`)
      ).rows[0].id;
      batchId = Number(
        (
          await pool.query(
            `INSERT INTO portfolio_import_batches(adapter_name,status,rows_total,account_id,is_brokerage,default_asset_class)
        VALUES('generic','awaiting_review',4,$1,true,'stock') RETURNING id`,
            [accountId],
          )
        ).rows[0].id,
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
            (
              await pool.query(
                `INSERT INTO portfolio_import_staging_rows
          (batch_id,row_index,status,tx_date,type_raw,type,route,units,price_per_unit,amount,currency,note,resolved_investment_id)
          VALUES($1,$2,'matched',$3,$4::text,CASE WHEN $5 = 'portfolio' THEN $4::text::portfolio_txn_type ELSE NULL END,$5,$6,$7,$8,'EUR',$9,$10) RETURNING id`,
                [
                  batchId,
                  i,
                  `2026-02-0${i + 1}`,
                  trade ? "buy" : "deposit",
                  trade ? "portfolio" : "cash",
                  trade ? 3 : null,
                  trade ? 100 : null,
                  trade ? 300 : i === 2 ? 10 : 20,
                  notes[i],
                  trade ? investmentId : null,
                ],
              )
            ).rows[0].id,
          ),
        );
      }
      querySpy = vi.spyOn(pg.Client.prototype, "query");
      expect(await commitBatch({ batchId })).toEqual({
        imported: 2,
        duplicates: 0,
        errors: 2,
      });
      const calls = querySpy.mock.calls.map(([statement, params]) => ({
        sql: typeof statement === "string" ? statement : statement.text,
        params,
      }));
      for (const id of [stagedIds[0], stagedIds[2]]) {
        const rollback = calls.findIndex(
          ({ sql }) => sql === `ROLLBACK TO SAVEPOINT sp_prow_${id}`,
        );
        expect(rollback).toBeGreaterThanOrEqual(0);
        expect(calls[rollback + 1].sql).toBe(`RELEASE SAVEPOINT sp_prow_${id}`);
        expect(
          calls.findIndex(
            ({ sql, params }) =>
              sql.includes("UPDATE portfolio_import_staging_rows") &&
              Number(params?.[0]) === id &&
              params?.[1] === "error",
          ),
        ).toBeGreaterThan(rollback + 1);
      }
      const staged = (
        await pool.query(
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
      expect(staged[0].error_message).toContain(
        "vision_test_trade_savepoint_failure",
      );
      expect(staged[2].error_message).toContain(
        "vision_test_cash_savepoint_failure",
      );
      expect(staged[0].committed_txn_id).toBeNull();
      expect(staged[2].committed_txn_id).toBeNull();
      expect(
        (
          await pool.query(
            "SELECT note FROM portfolio_transactions WHERE import_batch_id=$1",
            [batchId],
          )
        ).rows,
      ).toEqual([{ note: "SAVEPOINT GOOD TRADE" }]);
      expect(
        (
          await pool.query(
            "SELECT memo,amount::float8 AS amount FROM transactions WHERE account_id=$1",
            [accountId],
          )
        ).rows,
      ).toEqual([{ memo: "SAVEPOINT GOOD CASH", amount: 20 }]);
      expect(
        (
          await pool.query(
            "SELECT rows_imported,rows_error,rows_duplicate FROM portfolio_import_batches WHERE id=$1",
            [batchId],
          )
        ).rows[0],
      ).toMatchObject({ rows_imported: 2, rows_error: 2, rows_duplicate: 0 });
    } finally {
      querySpy?.mockRestore();
      await pool.query(
        "ALTER TABLE portfolio_transactions DROP CONSTRAINT IF EXISTS vision_test_trade_savepoint_failure",
      );
      await pool.query(
        "ALTER TABLE transactions DROP CONSTRAINT IF EXISTS vision_test_cash_savepoint_failure",
      );
      if (batchId) {
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
      if (investmentId)
        await pool.query("DELETE FROM investments WHERE id=$1", [investmentId]);
      if (accountId)
        await pool.query("DELETE FROM accounts WHERE id=$1", [accountId]);
      await pool.query("DELETE FROM recipients WHERE name=$1", [broker]);
    }
  });
});
