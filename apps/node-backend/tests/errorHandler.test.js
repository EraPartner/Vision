/**
 * errorHandler middleware tests.
 *
 * Covers: typed error class defaults, production detail masking, 4xx leakage
 * policy (expose message), 5xx leakage policy (mask in production).
 */

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
