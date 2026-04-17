/**
 * Phase-1 aggregation-layer smoke tests.
 *
 * Validates that the migration artifacts introduced in alembic 0026 exist
 * (MV, agg tables, triggers, trgm index) and that the orchestrator's
 * public surface is stable.
 *
 * DB-backed cases gate on TEST_DATABASE_URL per Phase 0 fixture contract.
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
      'agg_recipient_totals',
      'agg_split_outstanding',
    ]);
  });
});

describe.skipIf(!hasTestDatabase())(
  'services/aggregationRefresh — migration 0026 artifacts',
  () => {
    it('creates mv_recipient_monthly with a unique index', async () => {
      const pool = getTestPool();
      const mv = await pool.query(
        `SELECT 1 FROM pg_matviews WHERE matviewname = 'mv_recipient_monthly'`,
      );
      expect(mv.rowCount).toBe(1);

      const idx = await pool.query(
        `SELECT 1 FROM pg_indexes
         WHERE tablename = 'mv_recipient_monthly'
           AND indexdef ILIKE '%UNIQUE%'`,
      );
      expect(idx.rowCount).toBeGreaterThan(0);
    });

    it('creates agg_recipient_totals with trigger on transactions', async () => {
      const pool = getTestPool();
      const table = await pool.query(
        `SELECT 1 FROM information_schema.tables
         WHERE table_name = 'agg_recipient_totals'`,
      );
      expect(table.rowCount).toBe(1);

      const trg = await pool.query(
        `SELECT 1 FROM pg_trigger
         WHERE tgname = 'trg_agg_recipient_totals_sync'
           AND NOT tgisinternal`,
      );
      expect(trg.rowCount).toBe(1);
    });

    it('creates agg_split_outstanding with triggers on splits and payments', async () => {
      const pool = getTestPool();
      const table = await pool.query(
        `SELECT 1 FROM information_schema.tables
         WHERE table_name = 'agg_split_outstanding'`,
      );
      expect(table.rowCount).toBe(1);

      const triggers = await pool.query(
        `SELECT tgname FROM pg_trigger
         WHERE tgname IN (
           'trg_agg_split_outstanding_split',
           'trg_agg_split_outstanding_payment'
         ) AND NOT tgisinternal
         ORDER BY tgname`,
      );
      expect(triggers.rowCount).toBe(2);
    });

    it('creates pg_trgm GIN index on recipients.normalized_name', async () => {
      const pool = getTestPool();
      const idx = await pool.query(
        `SELECT 1 FROM pg_indexes
         WHERE tablename = 'recipients'
           AND indexname = 'idx_recipients_normalized_name_trgm'`,
      );
      expect(idx.rowCount).toBe(1);
    });

    it('refreshAggregations completes without error against a migrated DB', async () => {
      // Only meaningful when the app connection points at the same DB —
      // guarded by hasTestDatabase and kept fast with concurrency.
      await expect(aggregationRefresh.refreshAggregations()).resolves.not.toThrow();
    });
  },
);
