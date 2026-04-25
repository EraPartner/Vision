import { describe, it, expect, vi } from 'vitest';
import {
  createAdminAuthMiddleware,
  isLocalNetworkRequest,
  isLoopbackRequest,
  extractAdminBearerToken,
} from '../src/middleware/adminAuth.js';
import { UnauthorizedError } from '../src/middleware/errorHandler.js';

const mkReq = (overrides = {}) => ({ headers: {}, socket: {}, ...overrides });

describe('isLocalNetworkRequest', () => {
  // Loopback
  it('accepts loopback IPv4', () => {
    expect(isLocalNetworkRequest({ ip: '127.0.0.1', socket: {} })).toBe(true);
  });
  it('accepts loopback IPv6', () => {
    expect(isLocalNetworkRequest({ ip: '::1', socket: {} })).toBe(true);
  });
  it('accepts IPv4-mapped loopback ::ffff:127.0.0.1', () => {
    expect(isLocalNetworkRequest({ ip: '::ffff:127.0.0.1', socket: {} })).toBe(true);
  });
  it('accepts loopback via socket.remoteAddress when ip missing', () => {
    expect(isLocalNetworkRequest({ socket: { remoteAddress: '127.0.0.1' } })).toBe(true);
  });

  // RFC 1918 private ranges (Docker bridge, LAN)
  it('accepts 10.x.x.x (Docker/LAN)', () => {
    expect(isLocalNetworkRequest({ ip: '10.0.0.5', socket: {} })).toBe(true);
  });
  it('accepts 172.17.x.x (Docker default bridge)', () => {
    expect(isLocalNetworkRequest({ ip: '172.17.0.1', socket: {} })).toBe(true);
  });
  it('accepts 172.16.x.x (bottom of range)', () => {
    expect(isLocalNetworkRequest({ ip: '172.16.0.1', socket: {} })).toBe(true);
  });
  it('accepts 172.31.x.x (top of range)', () => {
    expect(isLocalNetworkRequest({ ip: '172.31.255.254', socket: {} })).toBe(true);
  });
  it('rejects 172.32.x.x (just outside range)', () => {
    expect(isLocalNetworkRequest({ ip: '172.32.0.1', socket: {} })).toBe(false);
  });
  it('accepts 192.168.x.x', () => {
    expect(isLocalNetworkRequest({ ip: '192.168.1.100', socket: {} })).toBe(true);
  });

  // IPv4-mapped private
  it('accepts ::ffff:172.17.0.1', () => {
    expect(isLocalNetworkRequest({ ip: '::ffff:172.17.0.1', socket: {} })).toBe(true);
  });
  it('accepts ::ffff:192.168.1.1', () => {
    expect(isLocalNetworkRequest({ ip: '::ffff:192.168.1.1', socket: {} })).toBe(true);
  });

  // IPv6 ULA
  it('accepts fd00:: (IPv6 ULA)', () => {
    expect(isLocalNetworkRequest({ ip: 'fd00::1', socket: {} })).toBe(true);
  });
  it('accepts fc00:: (IPv6 ULA)', () => {
    expect(isLocalNetworkRequest({ ip: 'fc00::1', socket: {} })).toBe(true);
  });

  // Public IPs — must be rejected
  it('rejects public IPv4', () => {
    expect(isLocalNetworkRequest({ ip: '8.8.8.8', socket: {} })).toBe(false);
  });
  it('rejects public IPv6', () => {
    expect(isLocalNetworkRequest({ ip: '2001:db8::1', socket: {} })).toBe(false);
  });
  it('rejects empty req', () => {
    expect(isLocalNetworkRequest({})).toBe(false);
    expect(isLocalNetworkRequest(null)).toBe(false);
  });
});

describe('isLoopbackRequest (alias)', () => {
  it('is same function as isLocalNetworkRequest', () => {
    expect(isLoopbackRequest).toBe(isLocalNetworkRequest);
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

  it('allows loopback request', () => {
    const next = vi.fn();
    mw(mkReq({ ip: '127.0.0.1' }), {}, next);
    expect(next).toHaveBeenCalledWith();
  });

  it('allows Docker bridge IP (172.17.0.1)', () => {
    const next = vi.fn();
    mw(mkReq({ ip: '172.17.0.1' }), {}, next);
    expect(next).toHaveBeenCalledWith();
  });

  it('allows private LAN IP (192.168.x.x)', () => {
    const next = vi.fn();
    mw(mkReq({ ip: '192.168.1.50' }), {}, next);
    expect(next).toHaveBeenCalledWith();
  });

  it('rejects public IP with UnauthorizedError', () => {
    const next = vi.fn();
    mw(mkReq({ ip: '8.8.8.8' }), {}, next);
    expect(next).toHaveBeenCalledTimes(1);
    const err = next.mock.calls[0][0];
    expect(err).toBeInstanceOf(UnauthorizedError);
    expect(err.message).toMatch(/ADMIN_AUTH_TOKEN/);
  });
});

describe('createAdminAuthMiddleware — token set', () => {
  const mw = createAdminAuthMiddleware(() => 'sekret');

  it('allows valid Bearer token from any IP', () => {
    const next = vi.fn();
    mw(mkReq({ ip: '8.8.8.8', headers: { authorization: 'Bearer sekret' } }), {}, next);
    expect(next).toHaveBeenCalledWith();
  });

  it('rejects missing token even from loopback', () => {
    const next = vi.fn();
    mw(mkReq({ ip: '127.0.0.1' }), {}, next);
    const err = next.mock.calls[0][0];
    expect(err).toBeInstanceOf(UnauthorizedError);
    expect(err.message).toBe('Unauthorized');
  });

  it('rejects mismatched token', () => {
    const next = vi.fn();
    mw(mkReq({ ip: '127.0.0.1', headers: { authorization: 'Bearer wrong' } }), {}, next);
    const err = next.mock.calls[0][0];
    expect(err).toBeInstanceOf(UnauthorizedError);
  });
});
