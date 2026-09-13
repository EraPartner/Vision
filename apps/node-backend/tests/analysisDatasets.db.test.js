/** Real-PostgreSQL acceptance for the versioned analysis views. */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  acquireDbSuiteLock,
  closeTestPool,
  getTestPool,
  hasTestDatabase,
  releaseDbSuiteLock,
} from "./setup/db.js";
import { closePool } from "../src/database/connection.js";
import { getMonthlyFinancialSummary } from "../src/repositories/infoRepositoryMonthly.js";

describe.skipIf(!hasTestDatabase())(
  "versioned analysis datasets (real DB)",
  () => {
    beforeAll(async () => {
      expect(
        process.env.DATABASE_URL,
        "DATABASE_URL must equal TEST_DATABASE_URL for this suite",
      ).toBe(process.env.TEST_DATABASE_URL);
      await acquireDbSuiteLock();
    }, 180_000);

    afterEach(async () => {
      const pool = getTestPool();
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
      await releaseDbSuiteLock();
      await closeTestPool();
      await closePool();
    });

    it("creates queryable typed views with stable grains and denied PUBLIC access", async () => {
      const pool = getTestPool();
      const { rows: accountRows } = await pool.query(
        `INSERT INTO accounts (name, display_name, currency)
         VALUES ('Analysis DB Account', 'Analysis DB Account', 'EUR')
         RETURNING id`,
      );
      const accountId = accountRows[0].id;
      await pool.query(
        `INSERT INTO account_statement_balances
           (account_id, currency, balance, balance_date)
         VALUES ($1, 'EUR', 25, '2026-01-31'),
                ($1, 'USD', 30, '2026-01-31')`,
        [accountId],
      );
      const { rows: recipientRows } = await pool.query(
        `INSERT INTO recipients (name, normalized_name)
         VALUES ('Analysis DB Recipient', 'analysis db recipient')
         RETURNING id`,
      );
      const recipientId = recipientRows[0].id;
      await pool.query(
        `INSERT INTO transactions
           (date, account_id, recipient_id, amount, currency, memo, is_transfer)
         VALUES
           ('2026-01-02', $1, $2, -100, 'EUR', 'ANALYSIS EXPENSE', false),
           ('2026-01-03', $1, $2,   25, 'EUR', 'ANALYSIS REFUND', false),
           ('2026-01-04', $1, $2,  -50, 'EUR', 'ANALYSIS TRANSFER OUT', true),
           ('2026-01-04', $1, $2,   50, 'EUR', 'ANALYSIS TRANSFER IN', true)`,
        [accountId, recipientId],
      );
      const { rows: investmentRows } = await pool.query(
        `INSERT INTO investments (name, symbol, asset_class, currency)
         VALUES ('Analysis DB Asset', 'ADB', 'stock', 'EUR') RETURNING id`,
      );
      await pool.query(
        `INSERT INTO portfolio_transactions
           (investment_id, account_id, type, date, amount, units,
            price_per_unit, fees, taxes, currency)
         VALUES ($1, $2, 'buy', '2026-01-05', 100, 1, 100, 0, 0, 'EUR')`,
        [investmentRows[0].id, accountId],
      );

      const [transactions, accounts, holdings, cashFlows] = await Promise.all([
        pool.query("SELECT * FROM vision_analysis.transactions_v1"),
        pool.query("SELECT * FROM vision_analysis.accounts_v1"),
        pool.query("SELECT * FROM vision_analysis.holding_events_v1"),
        pool.query("SELECT * FROM vision_analysis.cash_flows_v1"),
      ]);
      expect(transactions.rows).toHaveLength(4);
      expect(accounts.rows).toHaveLength(1);
      expect(accounts.rows[0].statement_balances).toHaveLength(2);
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

      const { rows: types } = await pool.query(
        `SELECT pg_typeof(t.transaction_id)::text AS transaction_id,
                pg_typeof(t.transaction_date)::text AS transaction_date,
                pg_typeof(t.amount)::text AS amount,
                pg_typeof(a.statement_balances)::text AS statement_balances,
                pg_typeof(h.event_date)::text AS event_date,
                pg_typeof(c.is_transfer)::text AS is_transfer
           FROM vision_analysis.transactions_v1 t
           CROSS JOIN vision_analysis.accounts_v1 a
           CROSS JOIN vision_analysis.holding_events_v1 h
           CROSS JOIN vision_analysis.cash_flows_v1 c
          LIMIT 1`,
      );
      expect(types[0]).toEqual({
        transaction_id: "integer",
        transaction_date: "date",
        amount: "numeric",
        statement_balances: "jsonb",
        event_date: "date",
        is_transfer: "boolean",
      });

      const { rows: privileges } = await pool.query(
        `SELECT
           EXISTS (
             SELECT 1
               FROM pg_namespace n
               CROSS JOIN LATERAL aclexplode(
                 COALESCE(n.nspacl, acldefault('n', n.nspowner))
               ) acl
              WHERE n.nspname = 'vision_analysis'
                AND acl.grantee = 0
                AND acl.privilege_type = 'USAGE'
           ) AS schema_usage,
           EXISTS (
             SELECT 1
               FROM pg_class c
               JOIN pg_namespace n ON n.oid = c.relnamespace
               CROSS JOIN LATERAL aclexplode(
                 COALESCE(c.relacl, acldefault('r', c.relowner))
               ) acl
              WHERE n.nspname = 'vision_analysis'
                AND c.relname IN (
                  'transactions_v1', 'accounts_v1',
                  'holding_events_v1', 'cash_flows_v1'
                )
                AND acl.grantee = 0
                AND acl.privilege_type = 'SELECT'
           ) AS any_view_select`,
      );
      expect(privileges[0]).toEqual({
        schema_usage: false,
        any_view_select: false,
      });
    });

    it("reconciles transfer-safe cash-flow totals with the monthly report query", async () => {
      const pool = getTestPool();
      await pool.query(
        `INSERT INTO user_settings (key, value)
         VALUES ('includeTransfers', 'false'::jsonb)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      );
      const { rows: accountRows } = await pool.query(
        `INSERT INTO accounts (name, display_name, currency)
         VALUES ('Analysis Reconcile', 'Analysis Reconcile', 'EUR') RETURNING id`,
      );
      const { rows: recipientRows } = await pool.query(
        `INSERT INTO recipients (name, normalized_name)
         VALUES ('Analysis Reconcile Recipient', 'analysis reconcile recipient')
         RETURNING id`,
      );
      await pool.query(
        `INSERT INTO transactions
           (date, account_id, recipient_id, amount, currency, is_transfer)
         VALUES ('2026-01-02', $1, $2, -100, 'EUR', false),
                ('2026-01-03', $1, $2,   25, 'EUR', false),
                ('2026-01-04', $1, $2,  -50, 'EUR', true),
                ('2026-01-04', $1, $2,   50, 'EUR', true)`,
        [accountRows[0].id, recipientRows[0].id],
      );
      const { rows: viewRows } = await pool.query(
        `SELECT sum(spending_amount)::numeric AS spending,
                sum(positive_flow_amount)::numeric AS positive_flow
           FROM vision_analysis.cash_flows_v1
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
      expect(Number(viewRows[0].spending)).toBe(january.total_spending);
      expect(Number(viewRows[0].positive_flow)).toBe(january.total_income);
      expect(january).toMatchObject({
        total_spending: 100,
        total_income: 25,
        transaction_count: 2,
      });
    });
  },
);
