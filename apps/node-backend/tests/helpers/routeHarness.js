/**
 * Shared route-test harness — LEGACY. Prefer `./routeApp.js` for new work.
 *
 * Backend route tests mock `express` so that `Router()` returns a stub whose
 * verb methods record the (last) registered handler under a `${method}:${path}`
 * key. This module centralizes that scaffold plus the `res` stub used to invoke
 * the recorded handlers.
 *
 * KNOWN GAPS (why `routeApp.js` exists): only the LAST handler registered per
 * verb+path is kept, so every guard registered before it (`validateIdParam`,
 * per-route rate limiters, multer, a router's trailing error middleware) is
 * dropped from the tested path; handlers are invoked with hand-built request
 * objects that skipped Express query/body parsing; and the ADR-026 envelope and
 * the centralized error handler have to be hand-replayed per suite, so status
 * codes and envelope shape are asserted against an approximation rather than
 * production. `routeApp.js` mounts the real router on a throwaway `express()`
 * app wired like `src/main.js` and drives it with supertest instead. Suites
 * already migrated: routes/transactions*.test.js, routes/plannedTransactions,
 * routes/importValidationPins.
 *
 * Usage:
 *   import { createMockRouter, createMockResponse } from '../helpers/routeHarness.js';
 *   const { router: mockRouter, handlers: routeHandlers } = createMockRouter();
 *   vi.mock('express', () => ({
 *     default: { Router: () => mockRouter },
 *     Router: () => mockRouter,
 *   }));
 *   // ... await import('../../src/routes/<x>.js');
 *   const res = createMockResponse();
 *   await routeHandlers['get:/'](req, res);
 */
import { vi } from 'vitest';

/**
 * Create an express Router stub. Verb methods (get/post/put/patch/delete)
 * record the final argument (the route handler) under `${method}:${path}`.
 * `use` records middleware into a `use` array while remaining a spy.
 *
 * @returns {{ router: object, handlers: Record<string, any> }}
 */
export function createMockRouter() {
  const handlers = {};
  const record = (method) =>
    vi.fn((path, ...args) => {
      handlers[`${method}:${path}`] = args[args.length - 1];
    });
  const router = {
    get: record('get'),
    post: record('post'),
    put: record('put'),
    patch: record('patch'),
    delete: record('delete'),
    use: vi.fn((...args) => {
      handlers.use = handlers.use || [];
      handlers.use.push(args[args.length - 1]);
    }),
  };
  return { router, handlers };
}

/**
 * Create a stub Express response. Always provides `json`/`status`/`send` spies,
 * a chainable `status`, and the `ok(data, meta)` envelope helper. Additional
 * response members (setHeader, end, write, headersSent, ...) can be supplied via
 * `extra`.
 *
 * @param {Record<string, any>} [extra] Extra response members to merge in.
 * @returns {object}
 */
export function createMockResponse(extra = {}) {
  const res = { json: vi.fn(), status: vi.fn(), send: vi.fn(), ...extra };
  res.status.mockReturnValue(res);
  res.ok = (data, meta) => {
    const body = { ok: true, data };
    if (meta) body.meta = meta;
    return res.json(body);
  };
  return res;
}
