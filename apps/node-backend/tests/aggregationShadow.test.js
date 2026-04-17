/**
 * aggregationShadow middleware tests.
 *
 * Covers:
 *   - diffPayloads flags numeric deltas above threshold and ignores tiny drift
 *   - envelope unwrapping (ignores `meta` block)
 *   - string NUMERIC coercion
 *   - array diffs
 *   - middleware wraps res.json, forwards body unchanged
 *   - divergences are logged as warn
 *   - legacy fetch failures never bubble
 *   - non-GET requests are passed through untouched
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  createAggregationShadow,
  diffPayloads,
} from '../src/middleware/aggregationShadow.js';

function flushMicrotasks() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function mockRes() {
  const res = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res;
}

function mockLogger() {
  return {
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
  };
}

describe('diffPayloads', () => {
  it('returns empty when numeric leaves match', () => {
    const a = { total: 100.0, by_month: [{ month: 1, total: 50 }] };
    const b = { total: 100.0, by_month: [{ month: 1, total: 50 }] };
    expect(diffPayloads(a, b, 0.01)).toEqual([]);
  });

  it('flags a delta above threshold', () => {
    const a = { total: 100.0 };
    const b = { total: 101.5 };
    const d = diffPayloads(a, b, 0.01);
    expect(d).toHaveLength(1);
    expect(d[0].path).toBe('total');
    expect(d[0].delta).toBeCloseTo(1.5);
  });

  it('ignores delta at or below threshold', () => {
    expect(diffPayloads({ x: 100 }, { x: 100.009 }, 0.01)).toEqual([]);
  });

  it('unwraps the { data, meta } envelope on both sides', () => {
    const envelope = { data: { total: 42 }, meta: { computedAt: 'a' } };
    const bare = { data: { total: 42 }, meta: { computedAt: 'b' } };
    expect(diffPayloads(envelope, bare, 0.01)).toEqual([]);
  });

  it('coerces NUMERIC string leaves', () => {
    const a = { total: '100.00' };
    const b = { total: 100 };
    expect(diffPayloads(a, b, 0.01)).toEqual([]);
  });

  it('walks arrays by index', () => {
    const a = { rows: [{ v: 1 }, { v: 2 }] };
    const b = { rows: [{ v: 1 }, { v: 5 }] };
    const d = diffPayloads(a, b, 0.01);
    expect(d).toHaveLength(1);
    expect(d[0].path).toBe('rows[1].v');
  });

  it('flags missing leaf when present side is non-trivial', () => {
    const a = { total: 500 };
    const b = {};
    const d = diffPayloads(a, b, 0.01);
    expect(d).toHaveLength(1);
    expect(d[0].legacy).toBeNull();
    expect(d[0].next).toBe(500);
  });

  it('ignores missing leaf when present side is within threshold', () => {
    const a = { noise: 0.001 };
    const b = {};
    expect(diffPayloads(a, b, 0.01)).toEqual([]);
  });
});

describe('createAggregationShadow middleware', () => {
  let logger;
  let fetchLegacy;

  beforeEach(() => {
    logger = mockLogger();
    fetchLegacy = vi.fn();
  });

  it('passes the response body through unchanged', () => {
    const originalJson = vi.fn().mockReturnValue('original-return');
    const res = { status: vi.fn().mockReturnThis(), json: originalJson };
    const mw = createAggregationShadow({
      fetchLegacy: vi.fn().mockResolvedValue({ total: 100 }),
      logger,
    });
    const req = { method: 'GET', path: '/a', query: {} };
    const next = vi.fn();

    mw(req, res, next);
    expect(next).toHaveBeenCalled();

    const body = { total: 100 };
    const returnValue = res.json(body);
    expect(originalJson).toHaveBeenCalledWith(body);
    expect(returnValue).toBe('original-return');
  });

  it('skips non-GET requests entirely', () => {
    const mw = createAggregationShadow({ fetchLegacy, logger });
    const req = { method: 'POST', path: '/a', query: {} };
    const res = mockRes();
    const originalJson = res.json;
    const next = vi.fn();

    mw(req, res, next);
    expect(res.json).toBe(originalJson);
    expect(next).toHaveBeenCalled();
  });

  it('logs a warn when legacy payload diverges beyond threshold', async () => {
    fetchLegacy.mockResolvedValue({ total: 110 });
    const mw = createAggregationShadow({ fetchLegacy, logger, thresholdCents: 1 });
    const req = { method: 'GET', path: '/a', query: {} };
    const res = mockRes();
    mw(req, res, vi.fn());

    res.json({ total: 100 });
    await flushMicrotasks();

    expect(logger.warn).toHaveBeenCalledWith(
      'aggregation-shadow: divergence detected',
      expect.objectContaining({
        path: '/a',
        count: 1,
        divergences: expect.arrayContaining([
          expect.objectContaining({ path: 'total' }),
        ]),
      }),
    );
  });

  it('stays silent when payloads match within threshold', async () => {
    fetchLegacy.mockResolvedValue({ total: 100.005 });
    const mw = createAggregationShadow({ fetchLegacy, logger, thresholdCents: 1 });
    const req = { method: 'GET', path: '/a', query: {} };
    const res = mockRes();
    mw(req, res, vi.fn());

    res.json({ total: 100 });
    await flushMicrotasks();

    expect(logger.warn).not.toHaveBeenCalledWith(
      'aggregation-shadow: divergence detected',
      expect.anything(),
    );
  });

  it('swallows legacy fetch failures and logs them as warn', async () => {
    fetchLegacy.mockRejectedValue(new Error('db-down'));
    const mw = createAggregationShadow({ fetchLegacy, logger });
    const req = { method: 'GET', path: '/a', query: {} };
    const res = mockRes();
    mw(req, res, vi.fn());

    res.json({ total: 100 });
    await flushMicrotasks();

    expect(logger.warn).toHaveBeenCalledWith(
      'aggregation-shadow: legacy fetch failed',
      expect.objectContaining({ path: '/a', error: 'db-down' }),
    );
  });

  it('rejects construction without fetchLegacy', () => {
    expect(() => createAggregationShadow({ logger: mockLogger() })).toThrow(TypeError);
  });

  it('rejects construction without logger.warn', () => {
    expect(() =>
      createAggregationShadow({ fetchLegacy: vi.fn(), logger: {} }),
    ).toThrow(TypeError);
  });
});
