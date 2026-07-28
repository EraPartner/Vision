/**
 * Aggregation route tests.
 *
 * Focused on the cashflow-forecast-rolling window guard, which must emit the
 * canonical unified-envelope error (ValidationError → code VALIDATION_ERROR)
 * rather than the old hand-rolled { code: 'BAD_REQUEST' } body.
 *
 * Runs against the REAL router mounted on a throwaway Express app (see
 * tests/helpers/routeApp.js).
 */
import { describe, it, expect, vi } from 'vitest';
import { routeAgent, errEnvelope } from '../helpers/routeApp.js';

// The real parseIntClamped caps days_back/days_forward at 365 each, so their sum
// can never exceed 730 and the guard is otherwise unreachable. Bypass the clamp
// (identity) so 400 + 400 = 800 actually reaches the guard — the line under test.
vi.mock('../../src/lib/pagination.js', () => ({
  parseIntClamped: (raw) => Number(raw),
  parsePagination: () => ({ limit: 50, offset: 0 }),
}));

const { default: aggregationsRouter } = await import('../../src/routes/aggregations.js');

const api = routeAgent(aggregationsRouter, { mountPath: '/api/aggregations' });

describe('Aggregation Routes — cashflow-forecast-rolling window guard', () => {
  it('answers a canonical 400 VALIDATION_ERROR envelope when the window exceeds 730 days', async () => {
    const res = await api
      .get('/api/aggregations/cashflow-forecast-rolling?days_back=400&days_forward=400')
      .expect(400);

    expect(res.body).toEqual(errEnvelope({
      code: 'VALIDATION_ERROR',
      message: 'days_back + days_forward must be <= 730',
    }));
  });
});
