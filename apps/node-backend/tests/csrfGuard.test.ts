import { describe, it, expect, vi } from 'vitest';
import { createCsrfGuard, loopbackOrigins } from '../src/middleware/csrfGuard.ts';
import { ForbiddenError } from '../src/middleware/errorHandler.ts';
import type { ExpressRequest, ExpressResponse } from '../src/types/express.ts';
import { partial } from './helpers/partial.ts';
import type { DeepPartial } from './helpers/partial.ts';
import { must } from "./helpers/must.ts";

const ALLOWED = ['http://localhost:3002', 'http://localhost:5173'];
const guard = createCsrfGuard(() => ALLOWED);

function run(req: DeepPartial<ExpressRequest>) {
  const next = vi.fn<(error?: unknown) => void>();
  guard(partial<ExpressRequest>({ headers: {}, ...req }), partial<ExpressResponse>({}), next);
  return next;
}

describe('csrfGuard', () => {
  it('blocks cross-site and same-site requests of every method, GET included', () => {
    for (const method of ['GET', 'HEAD', 'OPTIONS', 'POST']) {
      for (const site of ['cross-site', 'same-site']) {
        const next = run({ method, headers: { 'sec-fetch-site': site, origin: 'https://evil.com' } });
        expect(must(next.mock.calls[0], "next.mock.calls[0]")[0], `${method} ${site}`).toBeInstanceOf(ForbiddenError);
      }
    }
  });

  it('allows same-origin and user-initiated (none) GETs', () => {
    for (const site of ['same-origin', 'none']) {
      const next = run({ method: 'GET', headers: { 'sec-fetch-site': site } });
      expect(next).toHaveBeenCalledWith();
    }
  });

  it('blocks a GET with a foreign Origin and no Sec-Fetch-Site, allows one without Origin', () => {
    expect(must(run({ method: 'GET', headers: { origin: 'https://evil.com' } }).mock.calls[0], "run({ method: 'GET', headers: { origin: 'https://evil.com...")[0]).toBeInstanceOf(ForbiddenError);
    expect(run({ method: 'GET', headers: {} })).toHaveBeenCalledWith();
  });

  it('allows same-origin and user-initiated (none) state-changing requests via Sec-Fetch-Site', () => {
    for (const site of ['same-origin', 'none']) {
      const next = run({ method: 'POST', headers: { 'sec-fetch-site': site } });
      expect(next).toHaveBeenCalledWith();
    }
  });

  it('blocks cross-site and same-site state-changing requests via Sec-Fetch-Site', () => {
    for (const site of ['cross-site', 'same-site']) {
      const next = run({ method: 'POST', headers: { 'sec-fetch-site': site, origin: 'https://evil.com' } });
      const err = must(next.mock.calls[0], "next.mock.calls[0]")[0];
      expect(err, site).toBeInstanceOf(ForbiddenError);
    }
  });

  it('blocks the classic CSRF shape (cross-site POST to a destructive route)', () => {
    const next = run({
      method: 'POST',
      url: '/api/admin/database/reset',
      headers: { 'sec-fetch-site': 'cross-site', origin: 'https://evil.example' },
    });
    expect(must(next.mock.calls[0], "next.mock.calls[0]")[0]).toBeInstanceOf(ForbiddenError);
  });

  describe('Sec-Fetch-Site absent (older browsers / non-browser clients)', () => {
    it('allows when no Origin header (curl / server-to-server / Electron main)', () => {
      const next = run({ method: 'POST', headers: {} });
      expect(next).toHaveBeenCalledWith();
    });

    it('allows an allowlisted Origin', () => {
      const next = run({ method: 'POST', headers: { origin: 'http://localhost:5173' } });
      expect(next).toHaveBeenCalledWith();
    });

    it('blocks a non-allowlisted Origin', () => {
      const next = run({ method: 'POST', headers: { origin: 'https://evil.com' } });
      expect(must(next.mock.calls[0], "next.mock.calls[0]")[0]).toBeInstanceOf(ForbiddenError);
    });
  });

  it('does not accept a repeated Origin header', () => {
    const next = run({ method: 'POST', headers: { origin: ['http://localhost:5173', 'http://localhost:5173'] } });
    expect(must(next.mock.calls[0], "next.mock.calls[0]")[0]).toBeInstanceOf(ForbiddenError);
  });
});

describe('loopbackOrigins', () => {
  it('lists every loopback spelling of the backend port', () => {
    expect(loopbackOrigins(3002)).toEqual([
      'http://localhost:3002',
      'http://127.0.0.1:3002',
      'http://[::1]:3002',
    ]);
  });

  it('adds the Vite dev server origins only when asked', () => {
    const origins = loopbackOrigins(3002, { includeDevServer: true });
    expect(origins).toContain('http://127.0.0.1:8080');
    expect(origins).toContain('http://localhost:8080');
    expect(loopbackOrigins(3002)).not.toContain('http://127.0.0.1:8080');
  });

  it('feeds the guard: a foreign loopback port or LAN origin is rejected', () => {
    const loopbackGuard = createCsrfGuard(() => loopbackOrigins(3002));
    for (const origin of ['http://localhost:3000', 'http://192.168.1.5:3002', 'https://localhost:3002']) {
      const next = vi.fn();
      loopbackGuard(
        partial<ExpressRequest>({ method: 'POST', headers: { origin } }),
        partial<ExpressResponse>({}),
        next,
      );
      expect(must(next.mock.calls[0], "next.mock.calls[0]")[0], origin).toBeInstanceOf(ForbiddenError);
    }
  });
});
