/**
 * Schema contracts of the migrated database that used to be pinned only by
 * tests of individual (now squashed) migrations. Each case asserts current
 * behaviour on the real PostgreSQL schema built by db/migrations.
 *
 * Isolation: data-touching cases run inside BEGIN … ROLLBACK on a dedicated
 * client, with a savepoint around every statement that is expected to fail.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PoolClient } from "pg";
import {
  acquireDbSuiteLock,
  closeTestPool,
  getTestPool,
  hasTestDatabase,
  releaseDbSuiteLock,
} from "./setup/db.ts";
import { must } from "./helpers/must.ts";
import type {
  AccountId,
  InvestmentId,
  PortfolioTransactionId,
} from "@vision/types/brands";

/** A result row whose columns the test reads without a fixed shape. */
type DbRow = Record<string, unknown>;

const pool = getTestPool();

async function inRollback(run: (client: PoolClient) => Promise<void>) {
  const client = await must(pool, "pool").connect();
  try {
    await client.query("BEGIN");
    await run(client);
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
}

async function failsWith(
  client: PoolClient,
  text: string,
  params: unknown[],
  code: string,
) {
  await client.query("SAVEPOINT expected_failure");
  await expect(client.query<DbRow>(text, params)).rejects.toMatchObject({
    code,
  });
  await client.query("ROLLBACK TO SAVEPOINT expected_failure");
}

describe.skipIf(!hasTestDatabase())("migrated schema contracts", () => {
  beforeAll(acquireDbSuiteLock, 180_000);
  afterAll(async () => {
    await releaseDbSuiteLock();
    await closeTestPool();
  });

  it("has no audit history tables or functions after migration 0004", async () => {
    const relations = await must(pool, "pool").query<DbRow>(
      `SELECT c.relname FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public'
          AND c.relname IN ('audit_chain_head', 'audit_chain_entries',
            'audit_chain_checkpoints', 'db_editor_audit', 'split_audit',
            'portfolio_retag_audit')`,
    );
    expect(relations.rows).toEqual([]);
    const functions = await must(pool, "pool").query<DbRow>(
      `SELECT p.proname FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname LIKE 'audit_chain%'`,
    );
    expect(functions.rows).toEqual([]);
  });

  it("keeps per-currency statement balances constrained and owned by their account", async () => {
    const constraints = await must(pool, "pool").query<DbRow>(
      `SELECT conname FROM pg_constraint
        WHERE conrelid = 'public.account_statement_balances'::regclass
          AND contype <> 'n'
        ORDER BY conname`,
    );
    expect(constraints.rows.map((row) => row.conname)).toEqual([
      "chk_account_statement_balances_currency_iso",
      "fk_account_statement_balances_account",
      "pk_account_statement_balances",
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
        "( await client.query<{ id: AccountId }>( `INSERT I",
      ).id;
      await client.query(
        `INSERT INTO account_statement_balances
           (account_id, currency, balance, balance_date)
         VALUES ($1, 'EUR', 123.4567, '2026-08-31'),
                ($1, 'USD', -45.6789, '2026-09-01')`,
        [account],
      );
      await failsWith(
        client,
        `INSERT INTO account_statement_balances
           (account_id, currency, balance, balance_date)
         VALUES ($1, 'gbp', 1, '2026-09-02')`,
        [account],
        "23514",
      );
      expect(
        (
          await client.query<DbRow>(
            `SELECT currency, balance::text FROM account_statement_balances
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
              "SELECT count(*)::int AS n FROM account_statement_balances WHERE account_id = $1",
              [account],
            )
          ).rows[0],
          '( await client.query<DbRow>( "SELECT count(*)::int',
        ).n,
      ).toBe(0);
    });
  });

  it("stores portfolio recurrence as constrained text with the 'biweekly' spelling", async () => {
    const column = await must(pool, "pool").query<DbRow>(
      `SELECT data_type FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'portfolio_transactions'
          AND column_name = 'recurrence_interval'`,
    );
    expect(column.rows[0]?.data_type).toBe("text");

    await inRollback(async (client) => {
      const investment = must(
        (
          await client.query<{ id: InvestmentId }>(
            `INSERT INTO investments (name, symbol, asset_class, currency)
           VALUES ('Schema contract recurrence', 'SCREC', 'stock', 'EUR')
           RETURNING id`,
          )
        ).rows[0],
        "( await client.query<{ id: InvestmentId }>( `INSER",
      ).id;
      const transaction = must(
        (
          await client.query<{ id: PortfolioTransactionId }>(
            `INSERT INTO portfolio_transactions
             (investment_id, type, date, amount, units, price_per_unit, currency,
              is_recurring, recurrence_interval)
           VALUES ($1, 'buy', '2026-01-01', 100, 1, 100, 'EUR', true, 'biweekly')
           RETURNING id`,
            [investment],
          )
        ).rows[0],
        "( await client.query<{ id: PortfolioTransactionId ",
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
    const columns = await must(pool, "pool").query<DbRow>(
      `SELECT table_name, column_name, data_type
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND (table_name, column_name) IN (
            ('cashflow_forecast_accuracy', 'as_of_month'),
            ('cashflow_forecast_mc', 'month'),
            ('cashflow_forecast_mc_rolling', 'today_iso'))
        ORDER BY table_name`,
    );
    expect(columns.rows).toEqual([
      {
        table_name: "cashflow_forecast_accuracy",
        column_name: "as_of_month",
        data_type: "date",
      },
      {
        table_name: "cashflow_forecast_mc",
        column_name: "month",
        data_type: "date",
      },
      {
        table_name: "cashflow_forecast_mc_rolling",
        column_name: "today_iso",
        data_type: "date",
      },
    ]);
  });

  it("maintains updated_at with the shared trigger on every listed mutable table", async () => {
    const tables = [
      "exchange_rates",
      "user_settings",
      "ai_conversations",
      "provider_health",
      "investment_ticker_prefs",
      "import_staging_rows",
      "portfolio_import_staging_rows",
    ];
    const triggers = await must(pool, "pool").query<DbRow>(
      `SELECT c.relname AS table_name
         FROM pg_trigger t
         JOIN pg_class c ON c.oid = t.tgrelid
         JOIN pg_proc p ON p.oid = t.tgfoid
        WHERE NOT t.tgisinternal
          AND p.proname = 'update_updated_at_column'
          AND c.relname = ANY($1::text[])`,
      [tables],
    );
    expect(triggers.rows.map((row) => row.table_name as string).sort()).toEqual(
      [...tables].sort(),
    );
    const columns = await must(pool, "pool").query<DbRow>(
      `SELECT table_name FROM information_schema.columns
        WHERE table_schema = 'public' AND column_name = 'updated_at'
          AND is_nullable = 'NO' AND column_default ILIKE 'now()%'
          AND table_name = ANY($1::text[])`,
      [tables],
    );
    expect(columns.rows).toHaveLength(tables.length);

    await inRollback(async (client) => {
      await client.query(
        `INSERT INTO user_settings (key, value, updated_at)
         VALUES ('schema_contract_probe', '1'::jsonb, '2000-01-01T00:00:00Z')`,
      );
      await client.query(
        "UPDATE user_settings SET value = '2'::jsonb WHERE key = 'schema_contract_probe'",
      );
      const row = await client.query<DbRow>(
        "SELECT updated_at > '2000-01-02'::timestamptz AS touched FROM user_settings WHERE key = 'schema_contract_probe'",
      );
      expect(must(row.rows[0], "row.rows[0]").touched).toBe(true);
    });
  });

  it("links saved-chart memberships to their entities with cascading foreign keys", async () => {
    const keys = await must(pool, "pool").query<DbRow>(
      `SELECT c.conrelid::regclass::text AS table_name,
              c.confrelid::regclass::text AS referenced,
              c.confdeltype AS on_delete
         FROM pg_constraint c
        WHERE c.contype = 'f'
          AND c.conrelid::regclass::text IN
              ('saved_chart_categories', 'saved_chart_recipients', 'saved_chart_tags')
        ORDER BY 1, 2`,
    );
    expect(keys.rows).toEqual([
      {
        table_name: "saved_chart_categories",
        referenced: "categories",
        on_delete: "c",
      },
      {
        table_name: "saved_chart_categories",
        referenced: "saved_charts",
        on_delete: "c",
      },
      {
        table_name: "saved_chart_recipients",
        referenced: "recipients",
        on_delete: "c",
      },
      {
        table_name: "saved_chart_recipients",
        referenced: "saved_charts",
        on_delete: "c",
      },
      {
        table_name: "saved_chart_tags",
        referenced: "saved_charts",
        on_delete: "c",
      },
      { table_name: "saved_chart_tags", referenced: "tags", on_delete: "c" },
    ]);
    const arrays = await must(pool, "pool").query<DbRow>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'saved_charts'
          AND column_name IN ('category_ids', 'recipient_ids', 'tag_ids')`,
    );
    expect(arrays.rows).toEqual([]);
  });

  it("keeps insight dismissals tied to their category and recipient", async () => {
    const constraints = await must(pool, "pool").query<DbRow>(
      `SELECT conname FROM pg_constraint
        WHERE conrelid = 'public.insight_dismissals'::regclass AND contype = 'f'`,
    );
    expect(constraints.rows.map((row) => row.conname)).toEqual(
      expect.arrayContaining([
        "fk_insight_dismissals_category_id",
        "fk_insight_dismissals_recipient_id",
      ]),
    );
    for (const table of ["insight_digest_state", "insight_cash_projections"]) {
      const exists = await must(pool, "pool").query<DbRow>(
        "SELECT to_regclass($1) AS name",
        [`public.${table}`],
      );
      expect(must(exists.rows[0], "exists.rows[0]").name).toBe(table);
    }
  });

  it("enables pg_stat_statements and has retired the daily cash-flow view", async () => {
    const extension = await must(pool, "pool").query<DbRow>(
      "SELECT 1 FROM pg_extension WHERE extname = 'pg_stat_statements'",
    );
    expect(extension.rows).toHaveLength(1);
    const view = await must(pool, "pool").query<DbRow>(
      "SELECT to_regclass('public.mv_cashflow_daily') AS name",
    );
    expect(must(view.rows[0], "view.rows[0]").name).toBeNull();
  });

  it("exposes analysis datasets only as security-barrier views without secret or admin surfaces", async () => {
    const views = await must(pool, "pool").query<DbRow>(
      `SELECT c.relname,
              coalesce('security_barrier=true' = ANY(c.reloptions), false) AS barrier,
              EXISTS (
                SELECT 1 FROM aclexplode(c.relacl) a WHERE a.grantee = 0
              ) AS public_grant
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'vision_analysis'
        ORDER BY c.relname`,
    );
    expect(views.rows.map((row) => row.relname)).toEqual(
      expect.arrayContaining([
        "accounts_v1",
        "cash_flows_v1",
        "holding_events_v1",
        "transactions_v1",
      ]),
    );
    for (const row of views.rows) {
      expect(
        row,
        typeof row.relname === "string" ? row.relname : undefined,
      ).toMatchObject({
        barrier: true,
        public_grant: false,
      });
    }
    const kinds = await must(pool, "pool").query<DbRow>(
      `SELECT DISTINCT c.relkind FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'vision_analysis'`,
    );
    expect(kinds.rows.map((row) => row.relkind)).toEqual(["v"]);

    const forbiddenTables = await must(pool, "pool").query<DbRow>(
      `SELECT DISTINCT v.relname AS view_name, t.relname AS table_name
         FROM pg_depend d
         JOIN pg_rewrite r ON r.oid = d.objid
         JOIN pg_class v ON v.oid = r.ev_class
         JOIN pg_namespace vn ON vn.oid = v.relnamespace
         JOIN pg_class t ON t.oid = d.refobjid
        WHERE vn.nspname = 'vision_analysis'
          AND t.relname = 'provider_api_keys'`,
    );
    expect(forbiddenTables.rows).toEqual([]);
    const forbiddenColumns = await must(pool, "pool").query<DbRow>(
      `SELECT table_name, column_name FROM information_schema.columns
        WHERE table_schema = 'vision_analysis'
          AND column_name IN ('raw_csv_line', 'dedup_fingerprint', 'tx_hash')`,
    );
    expect(forbiddenColumns.rows).toEqual([]);
  });
});
