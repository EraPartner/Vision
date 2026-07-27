/**
 * Phase-1 aggregation-layer smoke tests.
 *
 * Validates that the aggregation artifacts the migration chain is supposed to
 * leave behind actually exist (agg tables, their triggers, the trgm index) and
 * that the orchestrator's public surface is stable.
 *
 * DB-backed cases gate on TEST_DATABASE_URL per Phase 0 fixture contract.
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

import { afterAll, describe, expect, it } from 'vitest';
import { closeTestPool, getTestPool, hasTestDatabase } from '../setup/db.js';
import {
  TRIGGER_MAINTAINED_TABLES,
  default as aggregationRefresh,
} from '../../src/services/aggregationRefresh.js';

afterAll(async () => {
  await closeTestPool();
});

describe('services/aggregationRefresh — module surface', () => {
  it('exports refreshAggregations and scheduleAggregationRefresh', () => {
    expect(typeof aggregationRefresh.refreshAggregations).toBe('function');
    expect(typeof aggregationRefresh.scheduleAggregationRefresh).toBe('function');
  });

  it('documents the trigger-maintained tables as frozen', () => {
    expect(Object.isFrozen(TRIGGER_MAINTAINED_TABLES)).toBe(true);
    expect(TRIGGER_MAINTAINED_TABLES).toEqual([
      'agg_split_outstanding',
    ]);
  });
});

describe.skipIf(!hasTestDatabase())(
  'services/aggregationRefresh — aggregation-layer schema artifacts',
  () => {
    it('leaves no materialized view behind for the app to refresh', async () => {
      // 0038 dropped mv_recipient_monthly and 0082 dropped mv_bank_balances,
      // both as unread views whose per-mutation refresh was pure write
      // amplification. The refresh set is now empty by design; a new MV
      // appearing here means someone reintroduced that cost without wiring a
      // reader, which is the exact regression those migrations exist to prevent.
      const pool = getTestPool();
      const mvs = await pool.query('SELECT matviewname FROM pg_matviews');
      expect(mvs.rows.map((r) => r.matviewname)).toEqual([]);
    });

    // agg_recipient_totals was dropped in 0080_drop_agg_recipient_totals; its
    // sole reader (recipientRepository existence probe) now hits transactions
    // directly, so there is no table/trigger to assert here anymore.

    it('creates agg_split_outstanding with triggers on splits and payments', async () => {
      const pool = getTestPool();
      const table = await pool.query(
        `SELECT 1 FROM information_schema.tables
         WHERE table_name = 'agg_split_outstanding'`,
      );
      expect(table.rowCount).toBe(1);

      // Assert the trigger sits on the expected table, not just that a name
      // exists somewhere — a trigger on the wrong relation keeps the aggregate
      // stale while still satisfying a name-only probe.
      const triggers = await pool.query(
        `SELECT c.relname AS table_name, t.tgname
           FROM pg_trigger t
           JOIN pg_class c ON c.oid = t.tgrelid
          WHERE NOT t.tgisinternal
            AND t.tgname IN ('trg_split_outstanding_sync', 'trg_split_payment_outstanding_sync')
          ORDER BY t.tgname`,
      );
      expect(triggers.rows).toEqual([
        { table_name: 'transaction_splits', tgname: 'trg_split_outstanding_sync' },
        { table_name: 'split_payments', tgname: 'trg_split_payment_outstanding_sync' },
      ]);
    });

    it('creates a pg_trgm GIN index on recipients.name', async () => {
      const pool = getTestPool();
      const idx = await pool.query(
        `SELECT indexdef FROM pg_indexes
         WHERE tablename = 'recipients'
           AND indexname = 'idx_recipients_name_trgm'`,
      );
      expect(idx.rowCount).toBe(1);
      expect(idx.rows[0].indexdef).toMatch(/USING gin \(name gin_trgm_ops\)/);
    });

    it('refreshAggregations completes without error against a migrated DB', async () => {
      // Only meaningful when the app connection points at the same DB —
      // guarded by hasTestDatabase and kept fast with concurrency.
      await expect(aggregationRefresh.refreshAggregations()).resolves.not.toThrow();
    });
  },
);
