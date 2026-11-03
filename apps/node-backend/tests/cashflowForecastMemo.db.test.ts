/**
 * The month forecast reuses a payload only while its inputs are unchanged.
 * Real database (SQLite): a ledger write between two requests with the dashboard's
 * non-default MC params must show up in the second answer.
 */
import { afterAll, afterEach, describe, expect, it } from "vitest";
import {
  closeTestPool,
  getTestPool,
} from "./setup/db.ts";
import { closePool } from "../src/database/connection.ts";
import { computeCashflowForecast } from "../src/services/calculations/forecast/index.ts";
import { todayAppDateString } from "../src/lib/timezone.ts";
import { firstRow, must } from "./helpers/must.ts";

const USER = `forecast-memo-${process.pid}`;
const DASHBOARD = {
  userId: USER,
  mcPaths: 500,
  mcPercentiles: [25, 75],
  includeBacktest: true,
};

describe(
  "cash-flow forecast payload reuse (real DB)",
  () => {
    const accounts: number[] = [];
    const recipients: number[] = [];
    afterEach(async () => {
      const pool = must(getTestPool(), "getTestPool()");
      await pool.query(
        "DELETE FROM transactions WHERE account_id IN (SELECT value FROM json_each($1))",
        [accounts],
      );
      await pool.query("DELETE FROM accounts WHERE id IN (SELECT value FROM json_each($1))", [
        accounts.splice(0),
      ]);
      await pool.query("DELETE FROM recipients WHERE id IN (SELECT value FROM json_each($1))", [
        recipients.splice(0),
      ]);
      await pool.query(
        "DELETE FROM cashflow_forecast_accuracy WHERE user_id = $1",
        [USER],
      );
    });
    afterAll(async () => {
      await closeTestPool();
      await closePool();
    });

    it("recomputes after a ledger change and matches a fresh compute", async () => {
      const pool = must(getTestPool(), "getTestPool()");
      const accountId = firstRow(
        await pool.query<{ id: number }>(
          "INSERT INTO accounts (name) VALUES ($1) RETURNING id",
          [`forecast-memo-${crypto.randomUUID()}`],
        ),
      ).id;
      accounts.push(accountId);
      const recipientName = `forecast-memo-${crypto.randomUUID()}`;
      const recipientId = firstRow(
        await pool.query<{ id: number }>(
          "INSERT INTO recipients (name, normalized_name) VALUES ($1, $1) RETURNING id",
          [recipientName],
        ),
      ).id;
      recipients.push(recipientId);
      const transactionId = firstRow(
        await pool.query<{ id: number }>(
          "INSERT INTO transactions (date, amount, currency, account_id, recipient_id) VALUES (ts_date($1), vision_numeric('-40', 18, 4), 'EUR', $2, $3) RETURNING id",
          [todayAppDateString(), accountId, recipientId],
        ),
      ).id;

      // The first backtest of the month records accuracy rows that feed the
      // next compute's ensemble weights; settle them before comparing.
      await computeCashflowForecast(DASHBOARD);
      const before = await computeCashflowForecast(DASHBOARD);
      const repeated = await computeCashflowForecast(DASHBOARD);
      expect(repeated.data).toEqual(before.data);

      await pool.query("UPDATE transactions SET amount = vision_numeric('-90', 18, 4) WHERE id = $1", [
        transactionId,
      ]);
      const after = await computeCashflowForecast(DASHBOARD);
      expect(after.data.actual).not.toEqual(before.data.actual);

      const fresh = await computeCashflowForecast({
        ...DASHBOARD,
        _forceCache: true,
      });
      expect(after.data).toEqual(fresh.data);
    });
  },
);
