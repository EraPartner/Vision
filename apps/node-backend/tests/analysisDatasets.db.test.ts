/** Real-database (SQLite) acceptance for the versioned analysis views. */
import { afterAll, afterEach, describe, expect, it } from "vitest";
import {
  closeTestPool,
  getTestPool,
} from "./setup/db.ts";
import { closePool } from "../src/database/connection.ts";
import {
  closeAnalysisPool,
  executeAnalysisSql,
} from "../src/services/analysisExecutor.ts";
import { getMonthlyFinancialSummary } from "../src/repositories/infoRepositoryMonthly.ts";
import { firstRow, must } from "./helpers/must.ts";

describe(
  "versioned analysis datasets (real DB)",
  () => {
    afterEach(async () => {
      const pool = must(getTestPool(), "getTestPool()");
      await pool.query(
        "DELETE FROM user_settings WHERE key = 'includeTransfers'",
      );
      await pool.query("DELETE FROM portfolio_transactions");
      await pool.query("DELETE FROM investments");
      await pool.query("DELETE FROM transactions");
      await pool.query("DELETE FROM account_statement_balances");
      await pool.query("DELETE FROM accounts");
      await pool.query("DELETE FROM recipients");
    });

    afterAll(async () => {
      await closeAnalysisPool();
      await closeTestPool();
      await closePool();
    });

    // ADR-263: the PostgreSQL version also asserted that PUBLIC had no USAGE on
    // the vision_analysis schema and no SELECT on its views. SQLite has no
    // roles; the guarantee that replaced the grants is that analysis SQL runs
    // in the sandbox over copies of the declared views only, so the last part
    // of this test reads the views through the executor and shows that a base
    // table is not reachable from there.
    it("creates queryable typed views with stable grains, reachable only through the analysis sandbox", async () => {
      const pool = must(getTestPool(), "getTestPool()");
      const { rows: accountRows } = await pool.query<{ id: number }>(
        `INSERT INTO accounts (name, display_name, currency)
         VALUES ('Analysis DB Account', 'Analysis DB Account', 'EUR')
         RETURNING id`,
      );
      const accountId = must(accountRows[0], "row").id;
      await pool.query(
        `INSERT INTO account_statement_balances
           (account_id, currency, balance, balance_date)
         VALUES ($1, 'EUR', vision_numeric('25', 18, 4), '2026-01-31'),
                ($1, 'USD', vision_numeric('30', 18, 4), '2026-01-31')`,
        [accountId],
      );
      const { rows: recipientRows } = await pool.query<{ id: number }>(
        `INSERT INTO recipients (name, normalized_name)
         VALUES ('Analysis DB Recipient', 'analysis db recipient')
         RETURNING id`,
      );
      const recipientId = must(recipientRows[0], "row").id;
      await pool.query(
        `INSERT INTO transactions
           (date, account_id, recipient_id, amount, currency, memo, is_transfer)
         VALUES
           ('2026-01-02', $1, $2, vision_numeric('-100', 18, 4), 'EUR', 'ANALYSIS EXPENSE', 0),
           ('2026-01-03', $1, $2, vision_numeric('25', 18, 4), 'EUR', 'ANALYSIS REFUND', 0),
           ('2026-01-04', $1, $2, vision_numeric('-50', 18, 4), 'EUR', 'ANALYSIS TRANSFER OUT', 1),
           ('2026-01-04', $1, $2, vision_numeric('50', 18, 4), 'EUR', 'ANALYSIS TRANSFER IN', 1)`,
        [accountId, recipientId],
      );
      const { rows: investmentRows } = await pool.query<{ id: number }>(
        `INSERT INTO investments (name, symbol, asset_class, currency)
         VALUES ('Analysis DB Asset', 'ADB', 'stock', 'EUR') RETURNING id`,
      );
      await pool.query(
        `INSERT INTO portfolio_transactions
           (investment_id, account_id, type, date, amount, units,
            price_per_unit, fees, taxes, currency)
         VALUES ($1, $2, 'buy', '2026-01-05', vision_numeric('100', 18, 4),
                 vision_numeric('1', 18, 8), vision_numeric('100', 18, 6),
                 vision_numeric('0', 18, 4), vision_numeric('0', 18, 4), 'EUR')`,
        [must(investmentRows[0], "row").id, accountId],
      );

      // statement_balances is an expression column with no declared type; the
      // alias hint reads it as the parsed JSON array node-postgres returned.
      const [transactions, accounts, holdings, cashFlows] = await Promise.all([
        pool.query<{ transaction_id: unknown }>("SELECT * FROM vision_analysis_transactions_v1"),
        pool.query<{ account_id: unknown; statement_balances: unknown[] }>(
          `SELECT *, statement_balances AS "statement_balances::json" FROM vision_analysis_accounts_v1`,
        ),
        pool.query<{ event_id: unknown }>("SELECT * FROM vision_analysis_holding_events_v1"),
        pool.query<{ cash_flow_id: unknown }>("SELECT * FROM vision_analysis_cash_flows_v1"),
      ]);
      expect(transactions.rows).toHaveLength(4);
      expect(accounts.rows).toHaveLength(1);
      expect(must(accounts.rows[0], "row").statement_balances).toHaveLength(2);
      expect(holdings.rows).toHaveLength(1);
      expect(cashFlows.rows).toHaveLength(4);
      expect(
        new Set(transactions.rows.map((row) => row.transaction_id)).size,
      ).toBe(4);
      expect(new Set(accounts.rows.map((row) => row.account_id)).size).toBe(1);
      expect(new Set(holdings.rows.map((row) => row.event_id)).size).toBe(1);
      expect(new Set(cashFlows.rows.map((row) => row.cash_flow_id)).size).toBe(
        4,
      );

      // The views' declared column types (PostgreSQL's integer, date,
      // numeric, boolean) and the values they read as. statement_balances is
      // computed, so SQLite declares no type for it; it must be a JSON array.
      const declared = async (view: string, column: string) =>
        firstRow(
          await pool.query<{ type: string }>(
            "SELECT type FROM pragma_table_info($1) WHERE name = $2",
            [view, column],
          ),
        ).type;
      expect({
        transaction_id: await declared("vision_analysis_transactions_v1", "transaction_id"),
        transaction_date: await declared("vision_analysis_transactions_v1", "transaction_date"),
        amount: await declared("vision_analysis_transactions_v1", "amount"),
        statement_balances: await declared("vision_analysis_accounts_v1", "statement_balances"),
        event_date: await declared("vision_analysis_holding_events_v1", "event_date"),
        is_transfer: await declared("vision_analysis_cash_flows_v1", "is_transfer"),
      }).toEqual({
        transaction_id: "INTEGER",
        transaction_date: "DATE_TEXT",
        amount: "DECIMAL_TEXT(18,4)",
        statement_balances: "",
        event_date: "DATE_TEXT",
        is_transfer: "BOOLEAN",
      });
      const expense = must(
        transactions.rows.find(
          (row) => (row as { memo?: unknown }).memo === "ANALYSIS EXPENSE",
        ),
        "expense row",
      ) as Record<string, unknown>;
      expect(typeof expense.transaction_id).toBe("number");
      expect(expense.transaction_date).toEqual(new Date(2026, 0, 2));
      expect(expense.amount).toBe("-100.0000");
      expect(expense.is_transfer).toBe(false);
      expect(must(accounts.rows[0], "row").statement_balances).toEqual([
        { balance: 25, currency: "EUR", balance_date: "2026-01-31" },
        { balance: 30, currency: "USD", balance_date: "2026-01-31" },
      ]);
      expect(
        (must(holdings.rows[0], "row") as Record<string, unknown>).event_date,
      ).toEqual(new Date(2026, 0, 5));
      const { rows: jsonCheck } = await pool.query<{ valid: number; kind: string }>(
        `SELECT json_valid(statement_balances) AS valid,
                json_type(statement_balances) AS kind
           FROM vision_analysis_accounts_v1`,
      );
      expect(jsonCheck).toEqual([{ valid: 1, kind: "array" }]);

      // Analysis SQL reads the views only through the sandbox, which holds
      // copies of the declared views and nothing else.
      const viaSandbox = await executeAnalysisSql({
        requestId: "analysis-datasets-views",
        sql: `SELECT (SELECT count(*) FROM vision_analysis.transactions_v1) AS transactions,
                     (SELECT count(*) FROM vision_analysis.accounts_v1) AS accounts,
                     (SELECT count(*) FROM vision_analysis.holding_events_v1) AS holdings,
                     (SELECT count(*) FROM vision_analysis.cash_flows_v1) AS cash_flows`,
        datasetIds: ["transactions", "accounts", "holdings", "cash-flows"],
      });
      expect(viaSandbox.rows).toEqual([
        { transactions: 4, accounts: 1, holdings: 1, cash_flows: 4 },
      ]);
      const baseTable = await executeAnalysisSql({
        requestId: "analysis-datasets-base",
        sql: "SELECT count(*) AS n FROM vision_analysis.accounts_v1 a, transactions t",
        datasetIds: ["accounts"],
      }).then(
        () => null,
        (error: unknown) => error as Error,
      );
      expect(baseTable?.message).toMatch(/no such table: transactions/);
    });

    it("reconciles transfer-safe cash-flow totals with the monthly report query", async () => {
      const pool = must(getTestPool(), "getTestPool()");
      await pool.query(
        `INSERT INTO user_settings (key, value)
         VALUES ('includeTransfers', vision_jsonb('false'))
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      );
      const { rows: accountRows } = await pool.query<{ id: number }>(
        `INSERT INTO accounts (name, display_name, currency)
         VALUES ('Analysis Reconcile', 'Analysis Reconcile', 'EUR') RETURNING id`,
      );
      const { rows: recipientRows } = await pool.query<{ id: number }>(
        `INSERT INTO recipients (name, normalized_name)
         VALUES ('Analysis Reconcile Recipient', 'analysis reconcile recipient')
         RETURNING id`,
      );
      await pool.query(
        `INSERT INTO transactions
           (date, account_id, recipient_id, amount, currency, is_transfer)
         VALUES ('2026-01-02', $1, $2, vision_numeric('-100', 18, 4), 'EUR', 0),
                ('2026-01-03', $1, $2, vision_numeric('25', 18, 4), 'EUR', 0),
                ('2026-01-04', $1, $2, vision_numeric('-50', 18, 4), 'EUR', 1),
                ('2026-01-04', $1, $2, vision_numeric('50', 18, 4), 'EUR', 1)`,
        [must(accountRows[0], "row").id, must(recipientRows[0], "row").id],
      );
      const { rows: viewRows } = await pool.query<{ spending: string; positive_flow: string }>(
        `SELECT dec_sum(spending_amount) AS spending,
                dec_sum(positive_flow_amount) AS positive_flow
           FROM vision_analysis_cash_flows_v1
          WHERE cash_flow_date BETWEEN '2026-01-01' AND '2026-01-31'`,
      );
      const report = await getMonthlyFinancialSummary(
        [],
        "EUR",
        [],
        false,
        "2026-01-01",
        "2026-01-31",
      );
      const january = report.months.find(
        ({ year, month }) => year === 2026 && month === 1,
      );
      expect(Number(firstRow({ rows: viewRows }).spending)).toBe(-must(january, "january").total_spending);
      expect(Number(firstRow({ rows: viewRows }).positive_flow)).toBe(must(january, "january").total_income);
      expect(january).toMatchObject({
        total_spending: -100,
        total_income: 25,
        transaction_count: 2,
      });
    });
  },
);
