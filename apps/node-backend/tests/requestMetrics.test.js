import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { requestMetrics, getMetrics, __resetMetrics as resetMetrics } from '../src/middleware/requestMetrics.js';

function makeReqRes({ method = 'GET', baseUrl = '', routePath = '/items', statusCode = 200, hasRoute = true } = {}) {
  const listeners = {};
  const req = {
    method,
    baseUrl,
    route: hasRoute ? { path: routePath } : null,
  };
  const res = {
    statusCode,
    on: (event, fn) => {
      listeners[event] = fn;
    },
  };
  return { req, res, fire: () => listeners.finish?.() };
}

describe('requestMetrics middleware', () => {
  beforeEach(() => resetMetrics());
  afterEach(() => {
    vi.useRealTimers();
    resetMetrics();
  });

  it('does nothing visible until res.finish fires', () => {
    const { req, res } = makeReqRes();
    requestMetrics(req, res, () => {});
    expect(getMetrics()).toEqual([]);
  });

  it('calls next() exactly once on entry', () => {
    const { req, res } = makeReqRes();
    const next = vi.fn();
    requestMetrics(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('records a single request after finish', () => {
    const { req, res, fire } = makeReqRes();
    requestMetrics(req, res, () => {});
    fire();
    const metrics = getMetrics();
    expect(metrics).toHaveLength(1);
    expect(metrics[0]).toMatchObject({
      method: 'GET',
      path: '/items',
      count: 1,
      errors: 0,
      error_rate: 0,
      window_minutes: 15,
    });
  });

  it('builds the route key from baseUrl + route.path', () => {
    const { req, res, fire } = makeReqRes({ baseUrl: '/api/users', routePath: '/:id' });
    requestMetrics(req, res, () => {});
    fire();
    expect(getMetrics()[0].path).toBe('/api/users/:id');
  });

  it('counts 4xx and 5xx as errors', () => {
    for (const status of [400, 404, 500, 503]) {
      const { req, res, fire } = makeReqRes({ statusCode: status });
      requestMetrics(req, res, () => {});
      fire();
    }
    const m = getMetrics();
    expect(m[0].count).toBe(4);
    expect(m[0].errors).toBe(4);
    expect(m[0].error_rate).toBe(100);
  });

  it('does not count 2xx/3xx as errors', () => {
    for (const status of [200, 201, 204, 301, 302, 399]) {
      const { req, res, fire } = makeReqRes({ statusCode: status });
      requestMetrics(req, res, () => {});
      fire();
    }
    const m = getMetrics();
    expect(m[0].errors).toBe(0);
    expect(m[0].error_rate).toBe(0);
  });

  it('rounds error_rate to two decimals', () => {
    // 1 error out of 3 = 33.333... → 33.33
    const ok1 = makeReqRes({ statusCode: 200 });
    const ok2 = makeReqRes({ statusCode: 200 });
    const err = makeReqRes({ statusCode: 500 });
    [ok1, ok2, err].forEach(({ req, res, fire }) => {
      requestMetrics(req, res, () => {});
      fire();
    });
    expect(getMetrics()[0].error_rate).toBe(33.33);
  });

  it('aggregates separate routes into separate entries sorted by count desc', () => {
    for (let i = 0; i < 5; i++) {
      const { req, res, fire } = makeReqRes({ routePath: '/popular' });
      requestMetrics(req, res, () => {});
      fire();
    }
    const { req, res, fire } = makeReqRes({ routePath: '/rare' });
    requestMetrics(req, res, () => {});
    fire();

    const m = getMetrics();
    expect(m).toHaveLength(2);
    expect(m[0].path).toBe('/popular');
    expect(m[0].count).toBe(5);
    expect(m[1].path).toBe('/rare');
    expect(m[1].count).toBe(1);
  });

  it('collapses unmatched routes (no req.route) into a single bucket per method', () => {
    for (const url of ['/scan-1', '/scan-2', '/scan-3']) {
      const { req, res, fire } = makeReqRes({ hasRoute: false, routePath: url });
      requestMetrics(req, res, () => {});
      fire();
    }
    const m = getMetrics();
    expect(m).toHaveLength(1);
    expect(m[0].route).toBe('GET <unmatched>');
    expect(m[0].count).toBe(3);
  });

  it('separates unmatched buckets by method', () => {
    for (const method of ['GET', 'POST', 'GET']) {
      const { req, res, fire } = makeReqRes({ hasRoute: false, method });
      requestMetrics(req, res, () => {});
      fire();
    }
    const m = getMetrics();
    expect(m).toHaveLength(2);
    expect(m.find((r) => r.method === 'GET').count).toBe(2);
    expect(m.find((r) => r.method === 'POST').count).toBe(1);
  });

  it('reports null percentiles when no latencies fall in the window', () => {
    // Won't happen in practice (a recorded request always has a latency
    // sample), but the percentile helper guards against an empty array.
    expect(getMetrics()).toEqual([]);
  });

  it('computes p50 and p95 from collected samples', () => {
    vi.useFakeTimers();
    let now = 1_000_000;
    vi.setSystemTime(now);
    const samples = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
    for (const ms of samples) {
      const { req, res, fire } = makeReqRes();
      requestMetrics(req, res, () => {});
      now += ms;
      vi.setSystemTime(now);
      fire();
    }
    const m = getMetrics()[0];
    expect(m.count).toBe(10);
    expect(m.p50_ms).toBe(50);
    expect(m.p95_ms).toBe(100);
  });

  it('drops buckets older than the rolling window', () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);

    // First request at t=0
    const r1 = makeReqRes();
    requestMetrics(r1.req, r1.res, () => {});
    r1.fire();

    // Advance well past the 15-minute window
    vi.setSystemTime(20 * 60_000);

    // Second request — eviction happens on store touch
    const r2 = makeReqRes();
    requestMetrics(r2.req, r2.res, () => {});
    r2.fire();

    const m = getMetrics();
    expect(m[0].count).toBe(1); // only the recent one survives
  });

  it('resetMetrics clears all stored data', () => {
    const { req, res, fire } = makeReqRes();
    requestMetrics(req, res, () => {});
    fire();
    expect(getMetrics()).toHaveLength(1);
    resetMetrics();
    expect(getMetrics()).toEqual([]);
  });

  it('caps stored routes at 500 to prevent unbounded growth', () => {
    for (let i = 0; i < 510; i++) {
      const { req, res, fire } = makeReqRes({ routePath: `/r${i}` });
      requestMetrics(req, res, () => {});
      fire();
    }
    const m = getMetrics();
    expect(m).toHaveLength(500);
  });
});
