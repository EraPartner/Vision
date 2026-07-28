/**
 * Real-Express route-test harness (supertest).
 *
 * The legacy harness (`routeHarness.js`) mocks `express` itself: `Router()`
 * returns a stub that keeps only the LAST handler registered per verb+path, so
 * every guard registered before it (`validateIdParam`, per-route rate limiters,
 * multer, …) is silently dropped, and handlers are invoked with hand-built
 * `{ query: {} }` objects that never went through Express's parsing, the
 * ADR-026 envelope middleware, or the centralized error handler.
 *
 * This module mounts the REAL router on a throwaway `express()` app wired the
 * way `src/main.js` wires the data plane, and hands back a supertest agent.
 * Repositories/services are still mocked per suite — only the HTTP edge is real.
 *
 * ── Fidelity map (what is reproduced, and from where) ──────────────────────
 *   requestId                 main.js:82   `req.id` → envelope `meta.requestId`
 *                                          + the `X-Request-Id` response header
 *   requestMetrics            main.js:85   passive `res.on('finish')` recorder
 *   express.json({limit})     main.js:130  body parsing (1 MB limit, as prod)
 *   csrfGuard                 main.js:315  mounted on the whole `/api` plane
 *   mountRouter(app, path, …) main.js:317+ real router, real middleware chain,
 *                                          real `req.baseUrl` / `req.route`
 *   404 → NotFoundError       main.js:395  unmatched paths funnel through the
 *                                          error handler so the envelope is
 *                                          uniform
 *   createErrorHandler(...)   main.js:401  typed errors → `{ ok:false, error }`
 *
 * ── Deliberately NOT reproduced (and why) ─────────────────────────────────
 *   CORS reflection           main.js:92-127   response headers only; needs the
 *                                              real settings allowlist.
 *   security headers          main.js:133-144  response headers only.
 *   gzip response compression main.js:150-223  wraps `res.write`/`res.end`;
 *                                              would obscure streamed-body and
 *                                              Content-Length assertions.
 *                                              Pass it via `before` if a suite
 *                                              needs it.
 *   request logging           main.js:226-229  noise.
 *   globalRateLimiter and the per-mount limiters
 *                             main.js:307, 323-335
 *                                              module-level counters keyed by
 *                                              IP, shared by every request in a
 *                                              worker — a suite with more tests
 *                                              than the limit would 429 itself.
 *                                              Route-level limiters declared
 *                                              INSIDE a router (e.g.
 *                                              routes/transactions.js:413) are
 *                                              still exercised, because the real
 *                                              router is mounted. Mount an
 *                                              app-level limiter explicitly via
 *                                              `before` when that is the thing
 *                                              under test.
 *   static SPA / health / /api root
 *                             main.js:244-390  not reachable from a router.
 *
 * Usage:
 *   import { routeAgent } from '../helpers/routeApp.js';
 *   // ... vi.mock() the repositories/services this router imports ...
 *   const { default: router } = await import('../../src/routes/transactions.js');
 *   const api = routeAgent(router, { mountPath: '/api/transactions' });
 *
 *   const res = await api.get('/api/transactions/').expect(200);
 *   expect(res.body).toEqual({ ok: true, data: {...}, meta: { requestId: expect.any(String) } });
 */
import express from 'express';
import supertest from 'supertest';

import { requestId } from '../../src/middleware/requestId.js';
import { requestMetrics } from '../../src/middleware/requestMetrics.js';
import { wrapResponse } from '../../src/middleware/envelope.js';
import { createCsrfGuard } from '../../src/middleware/csrfGuard.js';
import { createErrorHandler, NotFoundError } from '../../src/middleware/errorHandler.js';

/**
 * @typedef {object} RouteAppOptions
 * @property {string} [mountPath='/']   Path the router is mounted at. Use the
 *   production path (`/api/transactions`, `/api/planned-transactions`, …) so
 *   `req.baseUrl` and the request paths in the test read like real traffic.
 * @property {import('express').RequestHandler[]} [before=[]]  Extra middleware
 *   mounted on `mountPath` BEFORE the router — the slot `main.js` uses for
 *   per-mount rate limiters and the admin auth guard (main.js:323-335).
 * @property {import('express').RequestHandler[]} [after=[]]   Extra middleware
 *   mounted after the router but before the 404 handler.
 * @property {boolean} [csrf=true]      Mount the CSRF guard (main.js:315).
 *   supertest sends neither `Origin` nor `Sec-Fetch-Site`, so it is treated as
 *   a non-browser client and passes; set false only to prove the guard's effect.
 * @property {string|string[]} [corsOrigins=[]]  Allowlist handed to the CSRF
 *   guard (main.js:35 passes `settings.api.corsOrigins`).
 * @property {string} [jsonLimit='1mb'] Body-size limit (main.js:130).
 * @property {() => boolean} [isProduction]  Predicate handed to the error
 *   handler (main.js:401). Defaults to false so 5xx messages stay visible,
 *   matching a dev/test run.
 */

/**
 * Build a throwaway Express app with `router` mounted the way main.js mounts
 * the data plane.
 *
 * @param {import('express').Router} router
 * @param {RouteAppOptions} [options]
 * @returns {import('express').Express}
 */
export function createRouteApp(router, options = {}) {
  const {
    mountPath = '/',
    before = [],
    after = [],
    csrf = true,
    corsOrigins = [],
    jsonLimit = '1mb',
    isProduction = () => false,
  } = options;

  const app = express();

  // main.js:82 — must run first so every later middleware and the envelope see req.id.
  app.use(requestId);
  // main.js:85
  app.use(requestMetrics);
  // main.js:130
  app.use(express.json({ limit: jsonLimit }));
  // main.js:315 — CSRF backstop across the whole /api data plane.
  if (csrf) app.use(createCsrfGuard(() => corsOrigins));
  // main.js:232 — attaches res.ok(data, meta?) before any router runs.
  app.use(wrapResponse);

  // main.js:317+ — mountRouter(app, path, ...perMountMiddleware, router)
  app.use(mountPath, ...before, router);
  for (const mw of after) app.use(mountPath, mw);

  // main.js:395 — unmatched paths funnel through the error handler.
  app.use((req, _res, next) => {
    next(new NotFoundError(`Not Found: ${req.method} ${req.path}`));
  });
  // main.js:401
  app.use(createErrorHandler(isProduction));

  return app;
}

/**
 * `createRouteApp` + a supertest agent bound to it.
 *
 * @param {import('express').Router} router
 * @param {RouteAppOptions} [options]
 * @returns {import('supertest').SuperTest<import('supertest').Test>}
 */
export function routeAgent(router, options = {}) {
  return supertest(createRouteApp(router, options));
}

/**
 * Matcher for the ADR-026 success envelope: `{ ok: true, data, meta }`, where
 * `meta.requestId` is injected by `wrapResponse` from `req.id` (envelope.js:31).
 * Use with `expect(res.body).toEqual(okEnvelope({...}))`.
 *
 * @param {any} data
 * @param {Record<string, any>} [extraMeta]
 */
export function okEnvelope(data, extraMeta = {}) {
  return {
    ok: true,
    data,
    meta: { requestId: expect.any(String), ...extraMeta },
  };
}

/**
 * Matcher for the ADR-026 failure envelope emitted by `createErrorHandler`
 * (errorHandler.js:240-244). `details` is only present on typed AppErrors that
 * carry it, so it is opt-in here.
 *
 * @param {{ code?: any, message?: any, details?: any }} [error]
 */
export function errEnvelope(error = {}) {
  const shape = {
    code: error.code ?? expect.any(String),
    message: error.message ?? expect.any(String),
  };
  if (error.details !== undefined) shape.details = error.details;
  return {
    ok: false,
    error: shape,
    meta: { requestId: expect.any(String) },
  };
}
