/**
 * Aggregation route tests.
 *
 * Focused on the cashflow-forecast-rolling window guard, which must emit the
 * canonical unified-envelope error (ValidationError → code VALIDATION_ERROR)
 * rather than the old hand-rolled { code: 'BAD_REQUEST' } body.
 */
import { describe, it, expect, vi } from 'vitest';
import { createMockRouter, createMockResponse } from '../helpers/routeHarness.js';

const { router: mockRouter, handlers: routeHandlers } = createMockRouter();

vi.mock('express', () => ({
  default: { Router: () => mockRouter },
  Router: () => mockRouter,
}));

// The real parseIntClamped caps days_back/days_forward at 365 each, so their sum
// can never exceed 730 and the guard is otherwise unreachable. Bypass the clamp
// (identity) so 400 + 400 = 800 actually reaches the guard — the line under test.
vi.mock('../../src/lib/pagination.js', () => ({
  parseIntClamped: (raw) => Number(raw),
  parsePagination: () => ({ limit: 50, offset: 0 }),
}));

import { ValidationError } from '../../src/middleware/errorHandler.js';
await import('../../src/routes/aggregations.js');

describe('Aggregation Routes — cashflow-forecast-rolling window guard', () => {
  it('throws a canonical ValidationError (code VALIDATION_ERROR) when the window exceeds 730 days', async () => {
    const req = { query: { days_back: '400', days_forward: '400' }, get: () => undefined };
    const res = createMockResponse();

    await expect(routeHandlers['get:/cashflow-forecast-rolling'](req, res))
      .rejects.toBeInstanceOf(ValidationError);

    const err = await routeHandlers['get:/cashflow-forecast-rolling'](req, res)
      .then(() => null, (e) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect(err.code).toBe('VALIDATION_ERROR');
    expect(err.status).toBe(400);
  });
});
