/**
 * Regression test for the include_backtest default-drift finding.
 *
 * The two sibling forecast endpoints (cashflow-forecast-methods / -rolling)
 * intentionally default include_backtest differently (methods ON — backtest
 * diagnostics are core to method comparison; rolling OFF — keeps a fast cached
 * path), but they must now parse it through the same shared default-aware helper
 * so the accepted spellings can't diverge per endpoint (methods previously
 * accepted any value via `!== 'false'`, rolling only `=== 'true'`).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMockRouter, createMockResponse } from '../helpers/routeHarness.js';
import { parseBoolQueryParam } from '../../src/routes/info/_queryParams.js';

describe('parseBoolQueryParam — default-aware boolean query param', () => {
  it('returns the provided default when the param is absent/empty', () => {
    expect(parseBoolQueryParam(undefined, true)).toBe(true);
    expect(parseBoolQueryParam(undefined, false)).toBe(false);
    expect(parseBoolQueryParam('', true)).toBe(true);
    expect(parseBoolQueryParam(null, false)).toBe(false);
  });

  it('recognizes the same truthy/falsy spellings regardless of default', () => {
    for (const d of [true, false]) {
      expect(parseBoolQueryParam('true', d)).toBe(true);
      expect(parseBoolQueryParam('1', d)).toBe(true);
      expect(parseBoolQueryParam('TRUE', d)).toBe(true);
      expect(parseBoolQueryParam('false', d)).toBe(false);
      expect(parseBoolQueryParam('0', d)).toBe(false);
    }
    expect(parseBoolQueryParam(true, false)).toBe(true);
    expect(parseBoolQueryParam(1, false)).toBe(true);
    expect(parseBoolQueryParam(0, true)).toBe(false);
  });

  it('falls back to the default for unrecognized values', () => {
    expect(parseBoolQueryParam('yes', true)).toBe(true);
    expect(parseBoolQueryParam('banana', false)).toBe(false);
  });
});

const { router: mockRouter, handlers: routeHandlers } = createMockRouter();

vi.mock('express', () => ({
  default: { Router: () => mockRouter },
  Router: () => mockRouter,
}));

const methodsSpy = vi.fn(async () => ({ data: {}, meta: {} }));
const rollingSpy = vi.fn(async () => ({ data: {}, meta: {} }));

vi.mock('../../src/services/calculations/forecast/index.js', () => ({
  computeCashflowForecast: (...a) => methodsSpy(...a),
  computeCashflowForecastRolling: (...a) => rollingSpy(...a),
}));

await import('../../src/routes/aggregations.js');

const run = async (key, query) => {
  const res = createMockResponse();
  await routeHandlers[key]({ query, get: () => undefined }, res);
};

describe('cashflow-forecast endpoints — include_backtest default drift', () => {
  beforeEach(() => {
    methodsSpy.mockClear();
    rollingSpy.mockClear();
  });

  it('methods defaults include_backtest ON when the param is omitted', async () => {
    await run('get:/cashflow-forecast-methods', {});
    expect(methodsSpy.mock.calls[0][0].includeBacktest).toBe(true);
  });

  it('rolling defaults include_backtest OFF when the param is omitted', async () => {
    await run('get:/cashflow-forecast-rolling', {});
    expect(rollingSpy.mock.calls[0][0].includeBacktest).toBe(false);
  });

  it('both endpoints accept the same spellings (methods "0" → false, rolling "1" → true)', async () => {
    await run('get:/cashflow-forecast-methods', { include_backtest: '0' });
    expect(methodsSpy.mock.calls[0][0].includeBacktest).toBe(false);

    await run('get:/cashflow-forecast-rolling', { include_backtest: '1' });
    expect(rollingSpy.mock.calls[0][0].includeBacktest).toBe(true);
  });

  it('explicit override flips each default', async () => {
    await run('get:/cashflow-forecast-methods', { include_backtest: 'false' });
    expect(methodsSpy.mock.calls[0][0].includeBacktest).toBe(false);

    await run('get:/cashflow-forecast-rolling', { include_backtest: 'true' });
    expect(rollingSpy.mock.calls[0][0].includeBacktest).toBe(true);
  });
});
