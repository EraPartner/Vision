import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/config/config.js', () => ({
  default: { isDevelopment: () => false },
}));

import {
  adminMutateLimiter,
  adminRateLimiter,
  importRateLimiter,
  rateLimiter,
  __ipMatchesRule as ipMatchesRule,
} from '../src/middleware/rateLimiter.js';
import { RateLimitedError } from '../src/middleware/errorHandler.js';

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

// rateLimiter is unit-tested as a plain middleware function (req, res, next)
// — a minimal res stub is enough; there is no router/HTTP path to exercise.
function createResponse() {
  const res = { json: vi.fn(), status: vi.fn(), setHeader: vi.fn() };
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
    expect(next.mock.calls[0][0]).toBeUndefined();
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

    expect(blockedNext).toHaveBeenCalledTimes(1);
    expect(blockedNext.mock.calls[0][0]).toBeInstanceOf(RateLimitedError);
    expect(blockedRes.status).not.toHaveBeenCalled();
    expect(blockedRes.json).not.toHaveBeenCalled();
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
    expect(next.mock.calls[0][0]).toBeUndefined();
  });

  it('falls back to remoteAddress when req.ip is unavailable', () => {
    const now = 5_000_000;
    vi.spyOn(Date, 'now').mockReturnValue(now);

    const limiter = rateLimiter({ windowMs: 1_000, maxRequests: 1, keyPrefix: 'test-remote-address' });
    const req = createRequest({ remoteAddress: '10.10.10.10' });

    limiter(req, createResponse(), vi.fn());

    const blockedNext = vi.fn();
    limiter(req, createResponse(), blockedNext);

    expect(blockedNext).toHaveBeenCalledTimes(1);
    expect(blockedNext.mock.calls[0][0]).toBeInstanceOf(RateLimitedError);
  });

  it('uses unknown fallback key when IP fields are missing', () => {
    const now = 6_000_000;
    vi.spyOn(Date, 'now').mockReturnValue(now);

    const limiter = rateLimiter({ windowMs: 1_000, maxRequests: 1, keyPrefix: 'test-unknown-ip' });
    const req = createRequest();

    limiter(req, createResponse(), vi.fn());

    const blockedNext = vi.fn();
    limiter(req, createResponse(), blockedNext);

    expect(blockedNext).toHaveBeenCalledTimes(1);
    expect(blockedNext.mock.calls[0][0]).toBeInstanceOf(RateLimitedError);
  });

  it('adminRateLimiter allows high-volume read traffic (500/min)', () => {
    const now = 7_000_000;
    vi.spyOn(Date, 'now').mockReturnValue(now);

    const req = createRequest({ ip: '10.0.0.10' });
    const next = vi.fn();

    for (let i = 0; i < 50; i += 1) {
      adminRateLimiter(req, createResponse(), next);
    }

    expect(next).toHaveBeenCalledTimes(50);
    expect(next.mock.calls.every(call => call[0] === undefined)).toBe(true);
  });

  it('adminMutateLimiter blocks destructive operations above 30/min', () => {
    const now = 7_500_000;
    vi.spyOn(Date, 'now').mockReturnValue(now);

    const req = createRequest({ ip: '10.0.0.13' });
    const next = vi.fn();

    for (let i = 0; i < 30; i += 1) {
      adminMutateLimiter(req, createResponse(), next);
    }

    const blockedRes = createResponse();
    const blockedNext = vi.fn();
    adminMutateLimiter(req, blockedRes, blockedNext);

    expect(next).toHaveBeenCalledTimes(30);
    expect(blockedNext).toHaveBeenCalledTimes(1);
    expect(blockedNext.mock.calls[0][0]).toBeInstanceOf(RateLimitedError);
    expect(blockedRes.status).not.toHaveBeenCalled();
  });

  it('enforces import rate limit threshold (20/min)', () => {
    const now = 8_000_000;
    vi.spyOn(Date, 'now').mockReturnValue(now);

    const req = createRequest({ ip: '10.0.0.11' });
    const next = vi.fn();

    for (let i = 0; i < 20; i += 1) {
      importRateLimiter(req, createResponse(), next);
    }

    const blockedRes = createResponse();
    const blockedNext = vi.fn();
    importRateLimiter(req, blockedRes, blockedNext);

    expect(next).toHaveBeenCalledTimes(20);
    expect(blockedNext).toHaveBeenCalledTimes(1);
    expect(blockedNext.mock.calls[0][0]).toBeInstanceOf(RateLimitedError);
    expect(blockedRes.status).not.toHaveBeenCalled();
  });

  it('ignores X-Forwarded-For when no trusted proxy is configured (socket-keyed)', () => {
    // Default settings mock has no security.trustedProxies → XFF must not mint a
    // fresh bucket. Two requests from the same socket but different spoofed XFF
    // share one bucket, so the second trips the 1/min limit.
    const now = 9_000_000;
    vi.spyOn(Date, 'now').mockReturnValue(now);

    const limiter = rateLimiter({ windowMs: 1_000, maxRequests: 1, keyPrefix: 'test-xff-untrusted' });
    const make = (xff) => ({ socket: { remoteAddress: '203.0.113.9' }, headers: { 'x-forwarded-for': xff } });

    limiter(make('1.1.1.1'), createResponse(), vi.fn());
    const blockedNext = vi.fn();
    limiter(make('2.2.2.2'), createResponse(), blockedNext);

    expect(blockedNext).toHaveBeenCalledTimes(1);
    expect(blockedNext.mock.calls[0][0]).toBeInstanceOf(RateLimitedError);
  });

  it('ipMatchesRule matches exact IPs and IPv4 CIDR ranges', () => {
    expect(ipMatchesRule('172.18.0.1', '172.18.0.1')).toBe(true);
    expect(ipMatchesRule('172.18.0.5', '172.18.0.0/16')).toBe(true);
    expect(ipMatchesRule('172.19.0.5', '172.18.0.0/16')).toBe(false);
    expect(ipMatchesRule('10.0.0.7', '10.0.0.0/8')).toBe(true);
    expect(ipMatchesRule('11.0.0.7', '10.0.0.0/8')).toBe(false);
    expect(ipMatchesRule('192.168.1.1', '0.0.0.0/0')).toBe(true);
    expect(ipMatchesRule('::1', '::1')).toBe(true);
    expect(ipMatchesRule('192.168.1.1', '192.168.1.0/33')).toBe(false); // invalid mask
    expect(ipMatchesRule('not-an-ip', '10.0.0.0/8')).toBe(false);
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
