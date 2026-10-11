import { describe, it, expect, vi } from 'vitest';
import { createCsrfGuard } from '../src/middleware/csrfGuard.ts';
import { ForbiddenError } from '../src/middleware/errorHandler.ts';
import type { ExpressRequest, ExpressResponse } from '../src/types/express.ts';
import { partial } from './helpers/partial.ts';
import type { DeepPartial } from './helpers/partial.ts';

const ALLOWED = ['http://localhost:3002', 'http://localhost:5173'];
const guard = createCsrfGuard(() => ALLOWED);

function run(req: DeepPartial<ExpressRequest>) {
  const next = vi.fn();
  guard(partial<ExpressRequest>({ headers: {}, ...req }), partial<ExpressResponse>({}), next);
  return next;
}

describe('csrfGuard', () => {
  it('never blocks safe methods, even cross-site', () => {
    for (const method of ['GET', 'HEAD', 'OPTIONS']) {
      const next = run({ method, headers: { 'sec-fetch-site': 'cross-site', origin: 'https://evil.com' } });
      expect(next).toHaveBeenCalledWith();
    }
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
      const err = next.mock.calls[0]![0];
      expect(err, site).toBeInstanceOf(ForbiddenError);
    }
  });

  it('blocks the classic CSRF shape (cross-site POST to a destructive route)', () => {
    const next = run({
      method: 'POST',
      url: '/api/admin/database/reset',
      headers: { 'sec-fetch-site': 'cross-site', origin: 'https://evil.example' },
    });
    expect(next.mock.calls[0]![0]).toBeInstanceOf(ForbiddenError);
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
      expect(next.mock.calls[0]![0]).toBeInstanceOf(ForbiddenError);
    });
  });

  it('allows any Origin when the allowlist is wildcard', () => {
    const wildcard = createCsrfGuard(() => '*');
    const next = vi.fn();
    wildcard(
      partial<ExpressRequest>({ method: 'POST', headers: { origin: 'https://anything.example' } }),
      partial<ExpressResponse>({}),
      next,
    );
    expect(next).toHaveBeenCalledWith();
  });
});
