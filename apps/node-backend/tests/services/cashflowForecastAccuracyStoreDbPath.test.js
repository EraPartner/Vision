/**
 * Pins the accuracyStore DB-path normalization: repository rows come off
 * Postgres snake_case (method_id/sample_days), the store must hand consumers
 * camelCase (methodId/sampleDays). Regression guard for the bug where
 * ensemble.computeWeights filtered on `r.methodId`, dropped every persisted
 * row, and silently equal-weighted whenever Postgres was up.
 */

import { describe, expect, it, vi } from 'vitest';
import * as ensemble from '../../src/services/calculations/forecast/methods/ensemble.js';
import {
  getAccuracyHistory,
  getLatestAccuracyByMethod,
  getAllAccuracyHistory,
} from '../../src/services/calculations/forecast/accuracyStore.js';

const dbRows = vi.hoisted(() => [
  {
    user_id: 'u1', method_id: 'simple_avg', as_of_month: '2026-03',
    mae: 120.4, rmse: 180.7, mape: 0.21, sample_days: 90,
    recorded_at: new Date('2026-04-01T02:00:00Z'),
  },
  {
    user_id: 'u1', method_id: 'ewma', as_of_month: '2026-03',
    mae: 45.2, rmse: 60.3, mape: 0.08, sample_days: 90,
    recorded_at: new Date('2026-04-01T02:00:00Z'),
  },
  {
    user_id: 'u1', method_id: 'holt_winters', as_of_month: '2026-03',
    mae: 70.9, rmse: 95.1, mape: 0.13, sample_days: 90,
    recorded_at: new Date('2026-04-01T02:00:00Z'),
  },
]);

vi.mock('../../src/repositories/cashflowForecastAccuracyRepository.js', () => ({
  default: {
    upsert: vi.fn(async () => {}),
    getHistory: vi.fn(async ({ methodId }) => dbRows.filter((r) => r.method_id === methodId)),
    getLatestByMethod: vi.fn(async () => dbRows),
    getAllHistory: vi.fn(async () => dbRows),
  },
}));

describe('accuracyStore DB path returns camelCase records', () => {
  it('getLatestAccuracyByMethod normalizes snake_case repository rows', async () => {
    const rows = await getLatestAccuracyByMethod({ userId: 'u1' });
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.methodId).toBeDefined();
      expect(row.sampleDays).toBe(90);
      expect(row.asOfMonth).toBe('2026-03');
      expect(typeof row.recordedAt).toBe('string');
      expect(row).not.toHaveProperty('method_id');
      expect(row).not.toHaveProperty('sample_days');
      expect(row).not.toHaveProperty('as_of_month');
    }
  });

  it('getAccuracyHistory normalizes snake_case repository rows', async () => {
    const rows = await getAccuracyHistory({ userId: 'u1', methodId: 'ewma' });
    expect(rows).toHaveLength(1);
    expect(rows[0].methodId).toBe('ewma');
    expect(rows[0].rmse).toBe(60.3);
    expect(rows[0]).not.toHaveProperty('method_id');
  });

  it('getAllAccuracyHistory normalizes snake_case repository rows', async () => {
    const rows = await getAllAccuracyHistory({ userId: 'u1' });
    expect(rows.map((r) => r.methodId)).toEqual(['simple_avg', 'ewma', 'holt_winters']);
    expect(rows.every((r) => r.sampleDays === 90)).toBe(true);
  });

  it('computeWeights produces non-equal, accuracy-driven weights from DB-origin rows', async () => {
    const rows = await getLatestAccuracyByMethod({ userId: 'u1' });
    const methodIds = ['simple_avg', 'ewma', 'holt_winters'];
    const weights = ensemble.computeWeights(rows, methodIds);

    // Pre-fix, snake_case rows made this map empty → equal-weight fallback.
    expect(weights.size).toBe(3);

    const values = methodIds.map((id) => weights.get(id));
    for (const v of values) expect(Number.isFinite(v)).toBe(true);
    expect(values.reduce((s, v) => s + v, 0)).toBeCloseTo(1, 6);

    // Weights track backtest accuracy: lower RMSE → higher weight.
    expect(weights.get('ewma')).toBeGreaterThan(weights.get('holt_winters'));
    expect(weights.get('holt_winters')).toBeGreaterThan(weights.get('simple_avg'));

    // And they are decisively non-equal — equal weighting (1/3 each) would fail.
    expect(Math.max(...values) - Math.min(...values)).toBeGreaterThan(0.1);
  });
});
