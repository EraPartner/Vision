/**
 * errorHandler middleware tests.
 *
 * Covers: typed error class defaults, production detail masking, 4xx leakage
 * policy (expose message), 5xx leakage policy (mask in production), and the
 * forwarded-4xx rule for non-AppError errors that carry their own status
 * (body-parser's http-errors) — see THE RULE in src/middleware/errorHandler.js.
 */

import express from 'express';
import supertest from 'supertest';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import { mockLogger } from './helpers/mockLogger.js';
vi.mock('../src/config/logger.js', () => ({
  logger: mockLogger(),
}));

const {
  AppError,
  ValidationError,
  NotFoundError,
  ConflictError,
  UnauthorizedError,
  ForbiddenError,
  createErrorHandler,
} = await import('../src/middleware/errorHandler.js');

const { createRouteApp } = await import('./helpers/routeApp.js');

function mockRes() {
  const res = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res;
}
const req = { path: '/x', method: 'GET' };

describe('typed error classes', () => {
  it('AppError defaults to 500 / APP_ERROR', () => {
    const e = new AppError('boom');
    expect(e.status).toBe(500);
    expect(e.code).toBe('APP_ERROR');
    expect(e.name).toBe('AppError');
  });

  it('ValidationError is 400 / VALIDATION_ERROR', () => {
    const e = new ValidationError('bad input');
    expect(e.status).toBe(400);
    expect(e.code).toBe('VALIDATION_ERROR');
    expect(e instanceof AppError).toBe(true);
  });

  it('UnauthorizedError / ForbiddenError map to 401 / 403', () => {
    expect(new UnauthorizedError().status).toBe(401);
    expect(new ForbiddenError().status).toBe(403);
  });

  it('NotFoundError is 404 / NOT_FOUND', () => {
    const e = new NotFoundError('missing');
    expect(e.status).toBe(404);
    expect(e.code).toBe('NOT_FOUND');
  });

  it('ConflictError is 409 / CONFLICT', () => {
    const e = new ConflictError('dup');
    expect(e.status).toBe(409);
    expect(e.code).toBe('CONFLICT');
  });
});

describe('createErrorHandler', () => {
  let handler;
  let res;

  beforeEach(() => {
    res = mockRes();
  });

  it('maps typed 4xx error to status + message verbatim', () => {
    handler = createErrorHandler(() => true); // production, but 4xx still leaks message
    handler(new ValidationError('email required'), req, res, () => {});
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({
      ok: false,
      error: { code: 'VALIDATION_ERROR', message: 'email required' },
    });
  });

  it('maps typed 404 error', () => {
    handler = createErrorHandler(() => false);
    handler(new NotFoundError('recipe not found'), req, res, () => {});
    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({
      ok: false,
      error: { code: 'NOT_FOUND', message: 'recipe not found' },
    });
  });

  it('untyped error in production returns generic 500 detail', () => {
    handler = createErrorHandler(() => true);
    handler(new Error('DB password wrong'), req, res, () => {});
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({
      ok: false,
      error: { code: 'INTERNAL_SERVER_ERROR', message: 'An internal server error occurred. Please try again later.' },
    });
  });

  it('untyped error in development exposes the raw message', () => {
    handler = createErrorHandler(() => false);
    handler(new Error('DB password wrong'), req, res, () => {});
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({
      ok: false,
      error: { code: 'INTERNAL_SERVER_ERROR', message: 'DB password wrong' },
    });
  });

  it('typed 5xx AppError in production masks the message', () => {
    handler = createErrorHandler(() => true);
    handler(new AppError('internal integrity check', { status: 503, code: 'UPSTREAM_DOWN' }), req, res, () => {});
    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith({
      ok: false,
      error: { code: 'UPSTREAM_DOWN', message: 'An internal server error occurred. Please try again later.' },
    });
  });
});

/**
 * Non-AppError errors carrying their own status. Only 400-499 is forwarded, and
 * only an allowlisted body-parser `type` gets its message echoed; everything
 * else keeps the sanitized 500 path.
 */
describe('forwarded 4xx from non-AppError errors', () => {
  /** Build a plain Error with the http-errors shape body-parser produces. */
  function httpish(message, { status, statusCode, type } = {}) {
    const e = /** @type {any} */ (new Error(message));
    if (status !== undefined) e.status = status;
    if (statusCode !== undefined) e.statusCode = statusCode;
    if (type !== undefined) e.type = type;
    return e;
  }

  const run = (err, production = false) => {
    const res = mockRes();
    createErrorHandler(() => production)(err, req, res, () => {});
    return { status: res.status.mock.calls[0][0], body: res.json.mock.calls[0][0] };
  };

  it('forwards a trusted body-parser 400 with its own message, even in production', () => {
    const err = httpish('Unexpected end of JSON input', { status: 400, type: 'entity.parse.failed' });
    for (const production of [false, true]) {
      const { status, body } = run(err, production);
      expect(status).toBe(400);
      expect(body.error).toEqual({ code: 'VALIDATION_ERROR', message: 'Unexpected end of JSON input' });
    }
  });

  it('forwards a trusted body-parser 413 with its own message, even in production', () => {
    const err = httpish('request entity too large', { status: 413, type: 'entity.too.large' });
    for (const production of [false, true]) {
      const { status, body } = run(err, production);
      expect(status).toBe(413);
      expect(body.error).toEqual({ code: 'VALIDATION_ERROR', message: 'request entity too large' });
    }
  });

  it('forwards an untrusted 4xx status but replaces its message with the reason phrase', () => {
    // A fabricated non-AppError carrying status 403 and no recognised `type`:
    // the status is truthful enough to forward, the wording is not vetted.
    const { status, body } = run(httpish('token abc123 rejected by ldap://internal', { status: 403 }));
    expect(status).toBe(403);
    expect(body.error).toEqual({ code: 'FORBIDDEN', message: 'Forbidden' });
    expect(JSON.stringify(body)).not.toContain('ldap');
  });

  it('honours statusCode as well as status (loanSchedule.js:70 style throws)', () => {
    const { status, body } = run(httpish('Invalid loan configuration: term missing', { statusCode: 400 }));
    expect(status).toBe(400);
    expect(body.error).toEqual({ code: 'VALIDATION_ERROR', message: 'Bad Request' });
  });

  it('maps forwarded statuses onto the existing ADR-026 code vocabulary', () => {
    const cases = [
      [401, 'UNAUTHORIZED'], [403, 'FORBIDDEN'], [404, 'NOT_FOUND'],
      [409, 'CONFLICT'], [429, 'RATE_LIMITED'],
      [400, 'VALIDATION_ERROR'], [413, 'VALIDATION_ERROR'], [415, 'VALIDATION_ERROR'],
      [451, 'VALIDATION_ERROR'],
    ];
    for (const [code, expected] of cases) {
      expect(run(httpish('x', { status: code })).body.error.code).toBe(expected);
    }
    // A 4xx with no reason phrase in the table still gets a generic message.
    expect(run(httpish('x', { status: 451 })).body.error.message).toBe('Request rejected');
  });

  it('ignores 5xx and nonsense statuses — those keep the sanitized 500 path', () => {
    for (const bad of [500, 502, 399, 700, 0, -1, NaN, 400.5]) {
      const { status, body } = run(httpish('DB password wrong', { status: bad }), true);
      expect(status).toBe(500);
      expect(body.error).toEqual({
        code: 'INTERNAL_SERVER_ERROR',
        message: 'An internal server error occurred. Please try again later.',
      });
    }
    // Non-numeric statuses (a string, an object) must not be coerced either.
    for (const bad of ['400', { valueOf: () => 400 }]) {
      expect(run(httpish('DB password wrong', { status: bad }), true).status).toBe(500);
    }
  });

  it('a non-AppError with no status is unchanged: 500, sanitized in production only', () => {
    expect(run(new Error('DB password wrong'), false).body.error).toEqual({
      code: 'INTERNAL_SERVER_ERROR', message: 'DB password wrong',
    });
    expect(run(new Error('DB password wrong'), true).body.error).toEqual({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'An internal server error occurred. Please try again later.',
    });
  });

  it('a trusted type without a 4xx status is NOT forwarded', () => {
    // body-parser's `stream.encoding.set` is a 500; the type allowlist must not
    // be able to pull a 5xx into the exposed-message branch.
    const { status, body } = run(httpish('stream encoding should not be set', { status: 500, type: 'entity.too.large' }), true);
    expect(status).toBe(500);
    expect(body.error.message).toBe('An internal server error occurred. Please try again later.');
  });
});

/**
 * Same rule end-to-end over real Express + real body-parser (the harness that
 * main.js's data plane is modelled on), so the behaviour is proven against the
 * actual http-errors objects rather than hand-built look-alikes.
 */
describe('forwarded 4xx over real Express (supertest)', () => {
  /** Router that throws whatever the test asks for, so non-parser paths are covered too. */
  function fixtureRouter() {
    const router = express.Router();
    router.post('/echo', (req, res) => res.ok({ got: req.body }));
    router.get('/boom', () => { throw new Error('DB password wrong'); });
    router.get('/fake403', () => {
      const e = /** @type {any} */ (new Error('token abc123 rejected by ldap://internal'));
      e.status = 403;
      throw e;
    });
    return router;
  }

  const agent = (production) => supertest(createRouteApp(fixtureRouter(), {
    mountPath: '/api/fixture',
    isProduction: () => production,
  }));

  const PROD_5XX = 'An internal server error occurred. Please try again later.';

  it.each([['dev', false], ['production', true]])('malformed JSON → 400 with a useful message (%s)', async (_label, production) => {
    const res = await agent(production)
      .post('/api/fixture/echo')
      .set('Content-Type', 'application/json')
      .send('{"amount": ');

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.message).toMatch(/JSON/i);
    expect(res.body.error.message).not.toBe(PROD_5XX);
  });

  it.each([['dev', false], ['production', true]])('over-limit body → 413 with its reason visible (%s)', async (_label, production) => {
    const res = await agent(production)
      .post('/api/fixture/echo')
      .send({ memo: 'x'.repeat(1024 * 1024 + 100) });

    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.message).toBe('request entity too large');
  });

  it('a route-thrown non-AppError with status 403 → 403 with the generic reason phrase', async () => {
    const res = await agent(true).get('/api/fixture/fake403');
    expect(res.status).toBe(403);
    expect(res.body.error).toEqual({ code: 'FORBIDDEN', message: 'Forbidden' });
    expect(JSON.stringify(res.body)).not.toContain('ldap');
  });

  it('a route-thrown non-AppError with no status → 500, sanitized in production', async () => {
    const dev = await agent(false).get('/api/fixture/boom');
    expect(dev.status).toBe(500);
    expect(dev.body.error).toMatchObject({ code: 'INTERNAL_SERVER_ERROR', message: 'DB password wrong' });

    const prod = await agent(true).get('/api/fixture/boom');
    expect(prod.status).toBe(500);
    expect(prod.body.error).toMatchObject({ code: 'INTERNAL_SERVER_ERROR', message: PROD_5XX });
  });
});
