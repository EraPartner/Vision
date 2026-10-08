/**
 * Real-Express route-test harness (supertest).
 *
 * Replaces the retired `routeHarness.js`, which mocked `express` itself:
 * `Router()` returned a stub that kept only the LAST handler registered per
 * verb+path, so every guard registered before it (`validateIdParam`,
 * per-route rate limiters, multer, …) was silently dropped, and handlers were
 * invoked with hand-built `{ query: {} }` objects that never went through
 * Express's parsing, the ADR-026 envelope middleware, or the centralized
 * error handler.
 *
 * This module mounts the REAL router on a throwaway `express()` app wired the
 * way `src/main.ts` wires the data plane, and hands back a supertest agent.
 * Repositories/services are still mocked per suite — only the HTTP edge is real.
 *
 * ── Fidelity map (what is reproduced, and from where) ──────────────────────
 *   requestId                 main.ts:104  `req.id` → envelope `meta.requestId`
 *                                          + the `X-Request-Id` response header
 *   requestMetrics            main.ts:115  passive `res.on('finish')` recorder
 *   express.json({limit})     main.ts:123  body parsing (1 MB limit, as prod)
 *   csrfGuard                 main.ts:252  mounted on the whole `/api` plane
 *   mountRouter(app, path, …) main.ts:254+ real router, real middleware chain,
 *                                          real `req.baseUrl` / `req.route`
 *   404 → NotFoundError       main.ts:389  unmatched paths funnel through the
 *                                          error handler so the envelope is
 *                                          uniform
 *   createErrorHandler(...)   main.ts:395  typed errors → `{ ok:false, error }`
 *
 * ── Deliberately NOT reproduced (and why) ─────────────────────────────────
 *   CORS reflection           main.ts:117      response headers only; needs the
 *                                              real settings allowlist.
 *   security headers          main.ts:125-146  response headers only.
 *   gzip response compression main.ts:148      wraps `res.write`/`res.end`;
 *                                              would obscure streamed-body and
 *                                              Content-Length assertions.
 *                                              Pass it via `before` if a suite
 *                                              needs it.
 *   request logging           main.ts:150-156  noise.
 *   globalRateLimiter and the per-mount limiters
 *                             main.ts:244, 261-338
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
 *                             main.ts:161-237, 344-384  not reachable from a router.
 *
 * Usage:
 *   import { routeAgent } from '../helpers/routeApp.ts';
 *   // ... vi.mock() the repositories/services this router imports ...
 *   const { default: router } = await import('../../src/routes/transactions.ts');
 *   const api = routeAgent(router, { mountPath: '/api/transactions' });
 *
 *   const res = await api.get('/api/transactions/').expect(200);
 *   expect(res.body).toEqual({ ok: true, data: {...}, meta: { requestId: expect.any(String) } });
 */
import express from 'express';
import type { Express, RequestHandler, Router } from 'express';
import supertest from 'supertest';
import type { Test, TestAgent } from 'supertest';
import type { ExpressHandler } from '../../src/types/express.ts';

import { requestId } from '../../src/middleware/requestId.ts';
import { requestMetrics } from '../../src/middleware/requestMetrics.ts';
import { wrapResponse } from '../../src/middleware/envelope.ts';
import { createCsrfGuard } from '../../src/middleware/csrfGuard.ts';
import { createErrorHandler, NotFoundError } from '../../src/middleware/errorHandler.ts';

/**
 * Middleware for the `before`/`after` slots: real Express handlers, or the
 * structurally typed ones `src/` builds (src/types/express.ts), which main.ts
 * mounts the same way.
 */
export type RouteMiddleware = RequestHandler | ExpressHandler;

export interface RouteAppOptions {
  /**
   * Path the router is mounted at (default `'/'`). Use the production path
   * (`/api/transactions`, `/api/planned-transactions`, …) so `req.baseUrl` and
   * the request paths in the test read like real traffic.
   */
  mountPath?: string;
  /**
   * Extra middleware mounted on `mountPath` BEFORE the router — the slot
   * `main.ts` uses for per-mount rate limiters and the admin auth guard
   * (main.ts:261-338).
   */
  before?: RouteMiddleware[];
  /** Extra middleware mounted after the router but before the 404 handler. */
  after?: RouteMiddleware[];
  /**
   * Mount the CSRF guard (main.ts:252; default true). supertest sends neither
   * `Origin` nor `Sec-Fetch-Site`, so it is treated as a non-browser client and
   * passes; set false only to prove the guard's effect.
   */
  csrf?: boolean;
  /** Allowlist handed to the CSRF guard (main.ts:49 passes `settings.api.corsOrigins`). */
  corsOrigins?: string | string[];
  /** Body-size limit (main.ts:123; default `'1mb'`). */
  jsonLimit?: string;
  /**
   * Predicate handed to the error handler (main.ts:395). Defaults to false so
   * 5xx messages stay visible, matching a dev/test run.
   */
  isProduction?: () => boolean;
}

/** The supertest agent `routeAgent` returns. */
export type RouteAgent = TestAgent<Test>;

/**
 * Build a throwaway Express app with `router` mounted the way main.ts mounts
 * the data plane.
 */
export function createRouteApp(
  router: Router | RequestHandler,
  options: RouteAppOptions = {},
): Express {
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

  // main.ts:104 — must run first so every later middleware and the envelope see req.id.
  app.use(requestId);
  // main.ts:115
  app.use(requestMetrics);
  // main.ts:123
  app.use(express.json({ limit: jsonLimit }));
  // main.ts:252 — CSRF backstop across the whole /api data plane.
  if (csrf) app.use(createCsrfGuard(() => corsOrigins));
  // main.ts:159 — attaches res.ok(data, meta?) before any router runs.
  app.use(wrapResponse);

  // main.ts:254+ — mountRouter(app, path, ...perMountMiddleware, router)
  app.use(mountPath, ...(before as RequestHandler[]), router);
  for (const mw of after) app.use(mountPath, mw as RequestHandler);

  // main.ts:389 — unmatched paths funnel through the error handler.
  app.use((req, _res, next) => {
    next(new NotFoundError(`Not Found: ${req.method} ${req.path}`));
  });
  // main.ts:395
  app.use(createErrorHandler(isProduction));

  return app;
}

/**
 * `createRouteApp` + a supertest agent bound to it.
 */
export function routeAgent(
  router: Router | RequestHandler,
  options: RouteAppOptions = {},
): RouteAgent {
  return supertest(createRouteApp(router, options));
}

/**
 * Matcher for the ADR-026 success envelope: `{ ok: true, data, meta }`, where
 * `meta.requestId` is injected by `wrapResponse` from `req.id` (envelope.js:31).
 * Use with `expect(res.body).toEqual(okEnvelope({...}))`.
 */
export function okEnvelope(
  data: unknown,
  extraMeta: Record<string, unknown> = {},
): { ok: true; data: unknown; meta: Record<string, unknown> } {
  return {
    ok: true,
    data,
    meta: { requestId: expect.any(String), ...extraMeta },
  };
}

/**
 * Matcher for the ADR-026 failure envelope emitted by `createErrorHandler`
 * (errorHandler.js:240-244). `details` is only present on typed AppErrors that
 * carry it, so it is opt-in here. Each field may be a literal or an
 * asymmetric matcher (`expect.any(String)`, `expect.stringMatching(...)`).
 */
export function errEnvelope(
  error: { code?: unknown; message?: unknown; details?: unknown } = {},
): {
  ok: false;
  error: { code: unknown; message: unknown; details?: unknown };
  meta: { requestId: unknown };
} {
  const shape: { code: unknown; message: unknown; details?: unknown } = {
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
