/**
 * Phase-1 aggregation-layer smoke tests.
 *
 * Validates that the aggregation artifacts the migration chain is supposed to
 * leave behind actually exist (agg tables, their triggers, the trgm index) and
 * that the orchestrator's public surface is stable.
 *
 * DB-backed cases run against this file's own SQLite copy of the migrated
 * template (ADR-263).
 *
 * NB: the DB-backed block below was written against the pre-squash chain and had
 * NEVER executed — TEST_DATABASE_URL was set nowhere, so it skipped in CI and
 * locally alike. Wiring the Postgres service into CI ran it for the first time
 * and three of its four cases failed against a real migrated database, because
 * they asserted artifacts the current chain no longer produces:
 *   - `mv_recipient_monthly` was added in 0035 and DROPPED in 0038 (unread view,
 *     pure write amplification) — asserting its presence is now backwards.
 *   - the agg_split_outstanding triggers are named `trg_split_outstanding_sync` /
 *     `trg_split_payment_outstanding_sync` (0019), not `trg_agg_*`.
 *   - the recipients trgm index is `idx_recipients_name_trgm` on `name` (0001),
 *     not `idx_recipients_normalized_name_trgm` on `normalized_name`.
 * The assertions below are re-derived from the schema the chain actually builds.
 */

import { afterAll, describe, expect, it } from "vitest";
import { closeTestPool, getTestPool } from "../setup/db.ts";
import {
  __TRIGGER_MAINTAINED_TABLES as TRIGGER_MAINTAINED_TABLES,
  default as aggregationRefresh,
} from "../../src/services/aggregationRefresh.ts";
import { createMaterializedViews } from "../../src/services/materializedViewService.ts";

afterAll(async () => {
  await closeTestPool();
});

describe("services/aggregationRefresh — module surface", () => {
  it("exports refreshAggregations and scheduleAggregationRefresh", () => {
    expect(typeof aggregationRefresh.refreshAggregations).toBe("function");
    expect(typeof aggregationRefresh.scheduleAggregationRefresh).toBe(
      "function",
    );
  });

  it("documents the trigger-maintained tables as frozen", () => {
    expect(Object.isFrozen(TRIGGER_MAINTAINED_TABLES)).toBe(true);
    expect(TRIGGER_MAINTAINED_TABLES).toEqual(["agg_split_outstanding"]);
  });
});

describe("services/aggregationRefresh — aggregation-layer schema artifacts", () => {
  afterAll(async () => {
    // The refresh test below fills the materialized-view tables; leave them
    // empty again, as the migrated template has them.
    const pool = getTestPool();
    await pool.query("DELETE FROM mv_monthly_summary");
    await pool.query("DELETE FROM mv_category_totals");
  });

  it("leaves no materialized view behind for the app to refresh", async () => {
    // 0038 dropped mv_recipient_monthly and 0082 dropped mv_bank_balances,
    // both as unread views whose per-mutation refresh was pure write
    // amplification. On SQLite (ADR-263) the only mv_* relations are the two
    // tables materializedViewService refills; a new one appearing here means
    // someone reintroduced that cost without wiring a reader, which is the
    // exact regression those migrations exist to prevent.
    const pool = getTestPool();
    const mvs = await pool.query<{ name: string; type: string }>(
      `SELECT name, type FROM sqlite_master
        WHERE type IN ('table', 'view') AND name LIKE 'mv\\_%' ESCAPE '\\'
        ORDER BY name`,
    );
    expect(mvs.rows).toEqual([
      { name: "mv_category_totals", type: "table" },
      { name: "mv_monthly_summary", type: "table" },
    ]);
  });

  // agg_recipient_totals was dropped in 0080_drop_agg_recipient_totals; its
  // sole reader (recipientRepository existence probe) now hits transactions
  // directly, so there is no table/trigger to assert here anymore.

  it("creates agg_split_outstanding with triggers on splits and payments", async () => {
    const pool = getTestPool();
    const table = await pool.query(
      `SELECT 1 FROM sqlite_master
        WHERE type = 'table' AND name = 'agg_split_outstanding'`,
    );
    expect(table.rows).toHaveLength(1);

    // Assert the trigger sits on the expected table, not just that a name
    // exists somewhere — a trigger on the wrong relation keeps the aggregate
    // stale while still satisfying a name-only probe. SQLite triggers fire on
    // one event each, so PostgreSQL's INSERT OR UPDATE OR DELETE trigger is
    // three triggers named <trigger>__<event>.
    const triggers = await pool.query(
      `SELECT tbl_name AS table_name, name AS tgname
         FROM sqlite_master
        WHERE type = 'trigger'
          AND (name LIKE 'trg_split_outstanding_sync%'
               OR name LIKE 'trg_split_payment_outstanding_sync%')
        ORDER BY name`,
    );
    expect(triggers.rows).toEqual([
      { table_name: "transaction_splits", tgname: "trg_split_outstanding_sync__delete" },
      { table_name: "transaction_splits", tgname: "trg_split_outstanding_sync__insert" },
      { table_name: "transaction_splits", tgname: "trg_split_outstanding_sync__update" },
      { table_name: "split_payments", tgname: "trg_split_payment_outstanding_sync__delete" },
      { table_name: "split_payments", tgname: "trg_split_payment_outstanding_sync__insert" },
      { table_name: "split_payments", tgname: "trg_split_payment_outstanding_sync__update" },
    ]);
  });

  // PostgreSQL served recipient fuzzy matching from a pg_trgm GIN index
  // (idx_recipients_name_trgm). SQLite has no trigram index (ADR-263: the
  // baseline does not carry the GIN indexes over); the matcher scans with
  // Vision's similarity(), which must score exactly as pg_trgm did.
  it("scores trigram similarity like pg_trgm in place of the GIN index", async () => {
    const pool = getTestPool();
    const idx = await pool.query(
      `SELECT 1 FROM sqlite_master
        WHERE type = 'index' AND name = 'idx_recipients_name_trgm'`,
    );
    expect(idx.rows).toHaveLength(0);
    const sim = await pool.query<{ exact: number; partial: number; none: number }>(
      `SELECT similarity('word', 'word') AS exact,
              similarity('word', 'two words') AS partial,
              similarity('abc', 'xyz') AS none`,
    );
    // pg_trgm documents similarity('word', 'two words') = 0.36363637 (4/11 as
    // a float4, read back as node-postgres parsed float4 text).
    expect(sim.rows[0]).toEqual({ exact: 1, partial: 0.36363637, none: 0 });
  });

  it("refreshAggregations completes without error against a migrated DB", async () => {
    // The materialized-view tables start empty in the template; fill them
    // first, as the post-listen warmup does.
    await createMaterializedViews();
    await expect(
      aggregationRefresh.refreshAggregations(),
    ).resolves.not.toThrow();
  });
});
