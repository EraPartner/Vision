/**
 * /api/aggregations/cashflow-forecast-accuracy contract test.
 *
 * The accuracyStore hands the route uniform camelCase records
 * (AccuracyRecord — same shape on the DB and in-memory paths); the wire
 * response stays snake_case per the existing API contract. Pins both sides
 * of that boundary.
 */
import { describe, it, expect, vi } from 'vitest';
import { routeAgent } from '../helpers/routeApp.js';

vi.mock('../../src/services/calculations/forecast/accuracyStore.js', () => ({
  getAllAccuracyHistory: vi.fn(async () => [
    { userId: 'u1', methodId: 'ewma', asOfMonth: '2026-02', mae: 50.1, rmse: 66.0, mape: 0.09, sampleDays: 60, recordedAt: '2026-03-01T02:00:00.000Z' },
    { userId: 'u1', methodId: 'ewma', asOfMonth: '2026-03', mae: 45.2, rmse: 60.3, mape: 0.08, sampleDays: 90, recordedAt: '2026-04-01T02:00:00.000Z' },
    { userId: 'u1', methodId: 'simple_avg', asOfMonth: '2026-03', mae: 120.4, rmse: 180.7, mape: 0.21, sampleDays: 90, recordedAt: '2026-04-01T02:00:00.000Z' },
  ]),
  isAccuracyTableHealthy: vi.fn(() => true),
}));

const { default: aggregationsRouter } = await import('../../src/routes/aggregations.js');

const api = routeAgent(aggregationsRouter, { mountPath: '/api/aggregations' });

describe('GET /api/aggregations/cashflow-forecast-accuracy', () => {
  it('groups camelCase store records into the snake_case wire shape', async () => {
    const res = await api
      .get('/api/aggregations/cashflow-forecast-accuracy')
      .set('x-actor', 'u1')
      .expect(200);

    expect(res.body.ok).toBe(true);
    const { methods, limit_months } = res.body.data.data;
    expect(limit_months).toBe(24);
    expect(methods).toHaveLength(2);

    const ewma = methods.find((m) => m.method_id === 'ewma');
    expect(ewma).toEqual({
      method_id: 'ewma',
      as_of_month: '2026-03',
      mae: 45.2,
      rmse: 60.3,
      mape: 0.08,
      sample_days: 90,
      history: [
        { month: '2026-03', mae: 45.2, rmse: 60.3, mape: 0.08, sample_days: 90 },
        { month: '2026-02', mae: 50.1, rmse: 66.0, mape: 0.09, sample_days: 60 },
      ],
    });

    const simple = methods.find((m) => m.method_id === 'simple_avg');
    expect(simple.sample_days).toBe(90);
    expect(simple.as_of_month).toBe('2026-03');
  });
});
