/**
 * Schema contracts of the migrated database that used to be pinned only by
 * tests of individual (now squashed) migrations. Each case asserts current
 * behaviour on the real SQLite schema built by db/migrations (ADR-263).
 *
 * Isolation: data-touching cases run in a transaction that is rolled back,
 * with a savepoint around every statement that is expected to fail.
 */

import { describe, expect, it } from "vitest";
import type { DbClient } from "../src/database/connection.ts";
import { expectSqlError, getTestPool, inRollbackTransaction } from "./setup/db.ts";
import type { DbRow } from "./setup/db.ts";
import {
  columns,
  column,
  constraintNames,
  foreignKeys,
  objectNames,
  objectSql,
  objectType,
  triggers,
} from "./helpers/sqliteCatalog.ts";
import { must } from "./helpers/must.ts";
import type {
  AccountId,
  InvestmentId,
  PortfolioTransactionId,
} from "@vision/types/brands";

const pool = getTestPool();

async function inRollback(run: (client: DbClient) => Promise<void>) {
  await inRollbackTransaction(run);
}

async function failsWith(
  client: DbClient,
  text: string,
  params: unknown[],
  code: string,
) {
  await expectSqlError(client, text, params, code);
}

describe("migrated schema contracts", () => {
  it("has no audit history tables or functions after migration 0004", async () => {
    for (const name of [
      "audit_chain_head",
      "audit_chain_entries",
      "audit_chain_checkpoints",
      "db_editor_audit",
      "split_audit",
      "portfolio_retag_audit",
    ]) {
      expect(await objectType(name), name).toBeNull();
    }
    const functions = await pool.query(
      "SELECT name FROM pragma_function_list WHERE name LIKE 'audit_chain%'",
    );
    expect(functions.rows).toEqual([]);
  });

  it("keeps per-currency statement balances constrained and owned by their account", async () => {
    expect(await constraintNames("account_statement_balances")).toEqual([
      "chk_account_statement_balances_currency_iso",
      "fk_account_statement_balances_account",
      "pk_account_statement_balances",
    ]);
    expect(await foreignKeys("account_statement_balances")).toEqual([
      { table: "accounts", from: "account_id", to: "id", on_update: "NO ACTION", on_delete: "CASCADE" },
    ]);

    await inRollback(async (client) => {
      const account = must(
        (
          await client.query<{ id: AccountId }>(
            `INSERT INTO accounts (name, display_name, currency)
           VALUES ('Schema contract account', 'Schema contract', 'EUR')
           RETURNING id`,
          )
        ).rows[0],
        "inserted account",
      ).id;
      await client.query(
        `INSERT INTO account_statement_balances
           (account_id, currency, balance, balance_date)
         VALUES ($1, 'EUR', vision_numeric('123.4567', 18, 4), '2026-08-31'),
                ($1, 'USD', vision_numeric('-45.6789', 18, 4), '2026-09-01')`,
        [account],
      );
      await failsWith(
        client,
        `INSERT INTO account_statement_balances
           (account_id, currency, balance, balance_date)
         VALUES ($1, 'gbp', vision_numeric('1', 18, 4), '2026-09-02')`,
        [account],
        "23514",
      );
      expect(
        (
          await client.query<DbRow>(
            `SELECT currency, balance FROM account_statement_balances
              WHERE account_id = $1 ORDER BY currency`,
            [account],
          )
        ).rows,
      ).toEqual([
        { currency: "EUR", balance: "123.4567" },
        { currency: "USD", balance: "-45.6789" },
      ]);
      await client.query("DELETE FROM accounts WHERE id = $1", [account]);
      expect(
        must(
          (
            await client.query<DbRow>(
              "SELECT count(*) AS n FROM account_statement_balances WHERE account_id = $1",
              [account],
            )
          ).rows[0],
          "count row",
        ).n,
      ).toBe(0);
    });
  });

  it("stores portfolio recurrence as constrained text with the 'biweekly' spelling", async () => {
    expect((await column("portfolio_transactions", "recurrence_interval"))?.type).toBe("TEXT");

    await inRollback(async (client) => {
      const investment = must(
        (
          await client.query<{ id: InvestmentId }>(
            `INSERT INTO investments (name, symbol, asset_class, currency)
           VALUES ('Schema contract recurrence', 'SCREC', 'stock', 'EUR')
           RETURNING id`,
          )
        ).rows[0],
        "inserted investment",
      ).id;
      const transaction = must(
        (
          await client.query<{ id: PortfolioTransactionId }>(
            `INSERT INTO portfolio_transactions
             (investment_id, type, date, amount, units, price_per_unit, currency,
              is_recurring, recurrence_interval)
           VALUES ($1, 'buy', '2026-01-01', vision_numeric('100', 18, 4), vision_numeric('1', 18, 8),
                   vision_numeric('100', 18, 6), 'EUR', 1, 'biweekly')
           RETURNING id`,
            [investment],
          )
        ).rows[0],
        "inserted portfolio transaction",
      ).id;
      await failsWith(
        client,
        "UPDATE portfolio_transactions SET recurrence_interval = 'bi-weekly' WHERE id = $1",
        [transaction],
        "23514",
      );
    });
  });

  it("keeps cash-flow cache keys as DATE columns", async () => {
    const keys: Array<[string, string]> = [
      ["cashflow_forecast_accuracy", "as_of_month"],
      ["cashflow_forecast_mc", "month"],
      ["cashflow_forecast_mc_rolling", "today_iso"],
    ];
    for (const [table, name] of keys) {
      expect((await column(table, name))?.type, `${table}.${name}`).toBe("DATE_TEXT");
    }
  });

  it("maintains updated_at on every listed mutable table", async () => {
    const tables = [
      "exchange_rates",
      "user_settings",
      "ai_conversations",
      "provider_health",
      "investment_ticker_prefs",
      "import_staging_rows",
      "portfolio_import_staging_rows",
    ];
    for (const table of tables) {
      const touch = (await triggers(table)).filter(
        (trigger) =>
          /^CREATE TRIGGER \w+\s+AFTER UPDATE ON/iu.test(trigger.sql) &&
          trigger.sql.includes("SET updated_at = now()"),
      );
      expect(touch, table).toHaveLength(1);
      const updatedAt = must(await column(table, "updated_at"), `${table}.updated_at`);
      expect(updatedAt, table).toMatchObject({ type: "TIMESTAMPTZ_TEXT", notnull: 1, dflt_value: "now()" });
    }

    await inRollback(async (client) => {
      await client.query(
        `INSERT INTO user_settings (key, value, updated_at)
         VALUES ('schema_contract_probe', vision_jsonb('1'), vision_ts('2000-01-01T00:00:00Z'))`,
      );
      await client.query(
        "UPDATE user_settings SET value = vision_jsonb('2') WHERE key = 'schema_contract_probe'",
      );
      const row = await client.query<DbRow>(
        `SELECT updated_at > vision_ts('2000-01-02T00:00:00Z') AS "touched::bool"
           FROM user_settings WHERE key = 'schema_contract_probe'`,
      );
      expect(must(row.rows[0], "row.rows[0]").touched).toBe(true);
    });
  });

  it("links saved-chart memberships to their entities with cascading foreign keys", async () => {
    const keys: DbRow[] = [];
    for (const table of ["saved_chart_categories", "saved_chart_recipients", "saved_chart_tags"]) {
      for (const key of await foreignKeys(table)) {
        keys.push({ table_name: table, referenced: key.table, on_delete: key.on_delete });
      }
    }
    expect(keys).toEqual([
      { table_name: "saved_chart_categories", referenced: "categories", on_delete: "CASCADE" },
      { table_name: "saved_chart_categories", referenced: "saved_charts", on_delete: "CASCADE" },
      { table_name: "saved_chart_recipients", referenced: "recipients", on_delete: "CASCADE" },
      { table_name: "saved_chart_recipients", referenced: "saved_charts", on_delete: "CASCADE" },
      { table_name: "saved_chart_tags", referenced: "saved_charts", on_delete: "CASCADE" },
      { table_name: "saved_chart_tags", referenced: "tags", on_delete: "CASCADE" },
    ]);
    const arrays = (await columns("saved_charts")).filter((entry) =>
      ["category_ids", "recipient_ids", "tag_ids"].includes(entry.name),
    );
    expect(arrays).toEqual([]);
  });

  it("keeps insight dismissals tied to their category and recipient", async () => {
    expect(await constraintNames("insight_dismissals")).toEqual(
      expect.arrayContaining([
        "fk_insight_dismissals_category_id",
        "fk_insight_dismissals_recipient_id",
      ]),
    );
    expect((await foreignKeys("insight_dismissals")).map((key) => key.table)).toEqual(
      expect.arrayContaining(["categories", "recipients"]),
    );
    for (const table of ["insight_digest_state", "insight_cash_projections"]) {
      expect(await objectType(table), table).toBe("table");
    }
  });

  it("has retired the daily cash-flow view", async () => {
    // PostgreSQL's pg_stat_statements extension has no SQLite counterpart and
    // is no longer part of the schema (ADR-263).
    expect(await objectType("mv_cashflow_daily")).toBeNull();
  });

  it("exposes analysis datasets only as views without secret or raw-import surfaces", async () => {
    // PostgreSQL enforced this with security-barrier views readable only by
    // the analysis role. The SQLite analysis sandbox copies these views into
    // an in-memory database (ADR-263), so the views themselves are the whole
    // surface: they must not read provider_api_keys or expose raw import data.
    const views = await objectNames("view", "vision_analysis_%");
    expect(views).toEqual(
      expect.arrayContaining([
        "vision_analysis_accounts_v1",
        "vision_analysis_cash_flows_v1",
        "vision_analysis_holding_events_v1",
        "vision_analysis_transactions_v1",
      ]),
    );
    expect(await objectNames("table", "vision_analysis%")).toEqual([]);
    for (const view of views) {
      expect(await objectSql(view), view).not.toMatch(/\bprovider_api_keys\b/u);
      const exposed = (await columns(view))
        .map((entry) => entry.name)
        .filter((name) => ["raw_csv_line", "dedup_fingerprint", "tx_hash"].includes(name));
      expect(exposed, view).toEqual([]);
    }
  });
});
