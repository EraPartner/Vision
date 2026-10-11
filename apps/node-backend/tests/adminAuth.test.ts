import { describe, it, expect, vi } from 'vitest';
import {
  createAdminAuthMiddleware,
  __extractAdminBearerToken as extractAdminBearerToken,
  isLoopbackHost,
} from '../src/middleware/adminAuth.ts';
import { UnauthorizedError } from '../src/middleware/errorHandler.ts';
import type { ExpressRequest, ExpressResponse } from '../src/types/express.ts';
import { partial } from './helpers/partial.ts';

const mkReq = (
  overrides: { ip?: string; headers?: Record<string, string> } = {},
) => partial<ExpressRequest>({ headers: {}, socket: {}, ...overrides });
const mkRes = () => partial<ExpressResponse>({});

describe('isLoopbackHost', () => {
  it('accepts localhost and the 127/8 block', () => {
    expect(isLoopbackHost('localhost')).toBe(true);
    expect(isLoopbackHost('LOCALHOST')).toBe(true);
    expect(isLoopbackHost('127.0.0.1')).toBe(true);
    expect(isLoopbackHost('127.10.20.30')).toBe(true);
    expect(isLoopbackHost('::1')).toBe(true);
    expect(isLoopbackHost('[::1]')).toBe(true);
    expect(isLoopbackHost('::ffff:127.0.0.1')).toBe(true);
  });

  it('rejects wildcard, LAN, and empty binds', () => {
    expect(isLoopbackHost('0.0.0.0')).toBe(false);
    expect(isLoopbackHost('::')).toBe(false);
    expect(isLoopbackHost('192.168.1.10')).toBe(false);
    expect(isLoopbackHost('example.com')).toBe(false);
    expect(isLoopbackHost('')).toBe(false);
    expect(isLoopbackHost(undefined)).toBe(false);
  });
});

describe('extractAdminBearerToken', () => {
  it('parses Bearer header', () => {
    expect(extractAdminBearerToken('Bearer abc123')).toBe('abc123');
  });
  it('case-insensitive scheme', () => {
    expect(extractAdminBearerToken('bearer xyz')).toBe('xyz');
  });
  it('returns undefined for missing/non-string', () => {
    expect(extractAdminBearerToken(undefined)).toBeUndefined();
    expect(extractAdminBearerToken(null)).toBeUndefined();
    expect(extractAdminBearerToken(123)).toBeUndefined();
  });
  it('returns undefined for non-Bearer scheme', () => {
    expect(extractAdminBearerToken('Basic abc')).toBeUndefined();
  });
});

describe('createAdminAuthMiddleware — token unset', () => {
  const mw = createAdminAuthMiddleware(() => '');

  // With no token configured, admin is open regardless of source IP — the
  // loopback port binding + CSRF guard are the protection now, not an IP check.
  it('allows the request irrespective of source IP', () => {
    for (const ip of ['127.0.0.1', '172.17.0.1', '192.168.1.50', '8.8.8.8']) {
      const next = vi.fn();
      mw(mkReq({ ip }), mkRes(), next);
      expect(next).toHaveBeenCalledWith();
    }
  });
});

describe('createAdminAuthMiddleware — token set', () => {
  const mw = createAdminAuthMiddleware(() => 'sekret');

  it('allows valid Bearer token from any IP', () => {
    const next = vi.fn();
    mw(mkReq({ ip: '8.8.8.8', headers: { authorization: 'Bearer sekret' } }), mkRes(), next);
    expect(next).toHaveBeenCalledWith();
  });

  it('rejects missing token even from loopback', () => {
    const next = vi.fn();
    mw(mkReq({ ip: '127.0.0.1' }), mkRes(), next);
    const err = next.mock.calls[0]![0];
    expect(err).toBeInstanceOf(UnauthorizedError);
    expect(err.message).toBe('Unauthorized');
  });

  it('rejects mismatched token', () => {
    const next = vi.fn();
    mw(mkReq({ ip: '127.0.0.1', headers: { authorization: 'Bearer wrong' } }), mkRes(), next);
    const err = next.mock.calls[0]![0];
    expect(err).toBeInstanceOf(UnauthorizedError);
  });

  it('rejects token of different length without throwing (timing-safe compare)', () => {
    const next = vi.fn();
    mw(mkReq({ headers: { authorization: 'Bearer shorter' } }), mkRes(), next);
    const err = next.mock.calls[0]![0];
    expect(err).toBeInstanceOf(UnauthorizedError);
  });
});
