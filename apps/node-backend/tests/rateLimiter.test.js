import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  adminRateLimiter,
  importRateLimiter,
  rateLimiter,
} from '../src/middleware/rateLimiter.js';

function createRequest({ ip, remoteAddress } = {}) {
  const req = {};
  if (ip !== undefined) {
    req.ip = ip;
  }
  if (remoteAddress !== undefined) {
    req.connection = { remoteAddress };
  }
  return req;
}

function createResponse() {
  const res = {
    json: vi.fn(),
    setHeader: vi.fn(),
    status: vi.fn(),
  };
  res.status.mockReturnValue(res);
  return res;
}

describe('rateLimiter middleware', () => {
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('allows requests under the configured limit and sets headers', () => {
    const now = 2_000_000;
    vi.spyOn(Date, 'now').mockReturnValue(now);

    const limiter = rateLimiter({ windowMs: 1_000, maxRequests: 2, keyPrefix: 'test-allow' });
    const req = createRequest({ ip: '10.0.0.1' });
    const res = createResponse();
    const next = vi.fn();

    limiter(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.setHeader).toHaveBeenCalledWith('X-RateLimit-Limit', 2);
    expect(res.setHeader).toHaveBeenCalledWith('X-RateLimit-Remaining', 1);
    expect(res.setHeader).toHaveBeenCalledWith('X-RateLimit-Reset', Math.ceil((now + 1_000) / 1_000));
    expect(res.status).not.toHaveBeenCalled();
  });

  it('returns 429 when the request count exceeds the configured limit', () => {
    const now = 3_000_000;
    vi.spyOn(Date, 'now').mockReturnValue(now);

    const limiter = rateLimiter({ windowMs: 1_000, maxRequests: 1, keyPrefix: 'test-over-limit' });
    const req = createRequest({ ip: '10.0.0.2' });

    limiter(req, createResponse(), vi.fn());

    const blockedRes = createResponse();
    const blockedNext = vi.fn();
    limiter(req, blockedRes, blockedNext);

    expect(blockedNext).not.toHaveBeenCalled();
    expect(blockedRes.status).toHaveBeenCalledWith(429);
    expect(blockedRes.json).toHaveBeenCalledWith({
      detail: 'Too many requests. Please try again later.',
      retry_after: 1,
    });
  });

  it('resets request count after the configured time window', () => {
    let now = 4_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);

    const limiter = rateLimiter({ windowMs: 1_000, maxRequests: 1, keyPrefix: 'test-window-reset' });
    const req = createRequest({ ip: '10.0.0.3' });

    limiter(req, createResponse(), vi.fn());

    now += 1_001;
    const next = vi.fn();
    limiter(req, createResponse(), next);

    expect(next).toHaveBeenCalledTimes(1);
  });

  it('falls back to remoteAddress when req.ip is unavailable', () => {
    const now = 5_000_000;
    vi.spyOn(Date, 'now').mockReturnValue(now);

    const limiter = rateLimiter({ windowMs: 1_000, maxRequests: 1, keyPrefix: 'test-remote-address' });
    const req = createRequest({ remoteAddress: '10.10.10.10' });

    limiter(req, createResponse(), vi.fn());

    const blockedRes = createResponse();
    limiter(req, blockedRes, vi.fn());

    expect(blockedRes.status).toHaveBeenCalledWith(429);
  });

  it('uses unknown fallback key when IP fields are missing', () => {
    const now = 6_000_000;
    vi.spyOn(Date, 'now').mockReturnValue(now);

    const limiter = rateLimiter({ windowMs: 1_000, maxRequests: 1, keyPrefix: 'test-unknown-ip' });
    const req = createRequest();

    limiter(req, createResponse(), vi.fn());

    const blockedRes = createResponse();
    limiter(req, blockedRes, vi.fn());

    expect(blockedRes.status).toHaveBeenCalledWith(429);
  });

  it('enforces stricter admin rate limit', () => {
    const now = 7_000_000;
    vi.spyOn(Date, 'now').mockReturnValue(now);

    const req = createRequest({ ip: '10.0.0.10' });
    const next = vi.fn();

    for (let i = 0; i < 10; i += 1) {
      adminRateLimiter(req, createResponse(), next);
    }

    const blockedRes = createResponse();
    const blockedNext = vi.fn();
    adminRateLimiter(req, blockedRes, blockedNext);

    expect(next).toHaveBeenCalledTimes(10);
    expect(blockedNext).not.toHaveBeenCalled();
    expect(blockedRes.status).toHaveBeenCalledWith(429);
  });

  it('enforces import rate limit threshold', () => {
    const now = 8_000_000;
    vi.spyOn(Date, 'now').mockReturnValue(now);

    const req = createRequest({ ip: '10.0.0.11' });
    const next = vi.fn();

    for (let i = 0; i < 5; i += 1) {
      importRateLimiter(req, createResponse(), next);
    }

    const blockedRes = createResponse();
    const blockedNext = vi.fn();
    importRateLimiter(req, blockedRes, blockedNext);

    expect(next).toHaveBeenCalledTimes(5);
    expect(blockedNext).not.toHaveBeenCalled();
    expect(blockedRes.status).toHaveBeenCalledWith(429);
  });

  it('cleans up stale entries on the interval sweep', async () => {
    vi.useFakeTimers();
    vi.resetModules();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));

    const { rateLimiter: isolatedRateLimiter } = await import('../src/middleware/rateLimiter.js');
    const limiter = isolatedRateLimiter({ windowMs: 120_000, maxRequests: 1, keyPrefix: 'cleanup-sweep' });
    const req = createRequest({ ip: '10.0.0.12' });

    limiter(req, createResponse(), vi.fn());

    vi.setSystemTime(new Date('2026-01-01T00:01:01.000Z'));
    await vi.advanceTimersByTimeAsync(60_000);

    const res = createResponse();
    const next = vi.fn();
    limiter(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });
});
