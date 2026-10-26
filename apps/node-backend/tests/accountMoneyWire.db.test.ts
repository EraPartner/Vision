/**
 * Statement-balance and reconcile money fields at the HTTP boundary, against
 * real PostgreSQL.
 *
 * Regression: PUT /api/accounts/:id/statement-balances/:currency returned
 * `balance` and POST /api/accounts/:id/reconcile returned `transaction.amount`
 * as NUMERIC decimal strings ("120.50"), while the API's convention (and the
 * frontend types) send money as JSON numbers.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  acquireDbSuiteLock,
  closeTestPool,
  getTestPool,
  hasTestDatabase,
  releaseDbSuiteLock,
} from "./setup/db.ts";
import { closePool } from "../src/database/connection.ts";
import accountsRouter from "../src/routes/accounts.ts";
import { routeAgent } from "./helpers/routeApp.ts";
import { bodyAt } from "./helpers/responseBody.ts";
import { must } from "./helpers/must.ts";

const describeDb = hasTestDatabase() ? describe : describe.skip;
const MARK = `account_money_wire_${process.pid}`;

describeDb("account statement and reconcile money are numbers (real DB)", () => {
  const api = routeAgent(accountsRouter, { mountPath: "/api/accounts" });
  let accountId: number;

  beforeAll(async () => {
    await acquireDbSuiteLock();
    const pool = must(getTestPool(), "getTestPool()");
    const { rows: accounts } = await pool.query<{ id: number }>(
      `INSERT INTO accounts (name, display_name, currency)
       VALUES ($1, $1, 'EUR') RETURNING id`,
      [MARK],
    );
    accountId = must(accounts[0], "row").id;
    const { rows: recipients } = await pool.query<{ id: number }>(
      `INSERT INTO recipients (name, normalized_name) VALUES ($1, $1) RETURNING id`,
      [MARK],
    );
    await pool.query(
      `INSERT INTO transactions (date, amount, memo, currency, account_id, recipient_id)
       VALUES ('2026-09-01', 100, $1, 'EUR', $2, $3)`,
      [MARK, accountId, must(recipients[0], "row").id],
    );
  });

  afterAll(async () => {
    try {
      const pool = getTestPool();
      if (pool) {
        await pool.query("DELETE FROM transactions WHERE account_id = $1", [
          accountId,
        ]);
        await pool.query(
          "DELETE FROM account_statement_balances WHERE account_id = $1",
          [accountId],
        );
        await pool.query("DELETE FROM accounts WHERE id = $1", [accountId]);
        await pool.query("DELETE FROM recipients WHERE normalized_name = $1", [
          MARK,
        ]);
      }
    } finally {
      await releaseDbSuiteLock();
      await closeTestPool();
      await closePool();
    }
  });

  it("returns the stored statement balance as a number", async () => {
    const res = await api
      .put(`/api/accounts/${accountId}/statement-balances/EUR`)
      .send({ balance: 120.5, date: "2026-09-02" });

    expect(res.status).toBe(200);
    expect(bodyAt(res, "data")).toMatchObject({
      account_id: accountId,
      currency: "EUR",
      balance: 120.5,
      balance_date: "2026-09-02",
    });
  });

  it("returns the reconcile adjustment amount as a number", async () => {
    const res = await api
      .post(`/api/accounts/${accountId}/reconcile`)
      .send({ mode: "adjustment" });

    expect(res.status).toBe(200);
    expect(bodyAt(res, "data", "transaction", "amount")).toBe(20.5);
    expect(bodyAt(res, "data", "statement_balance")).toBe(120.5);
  });
});
