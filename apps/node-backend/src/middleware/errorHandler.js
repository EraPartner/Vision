/**
 * Centralized error handling middleware with typed error classes.
 *
 * Routes throw typed errors (AppError, ValidationError, NotFoundError, ConflictError,
 * UnauthorizedError, ForbiddenError); middleware maps them to the unified API
 * envelope (see docs/adr/026-unified-api-response-envelope.md):
 *   { ok: false, error: { code, message, details? }, meta? }
 *
 * Untyped errors fall through to a 500 with the production-safe message used by
 * the previous inline handler in main.js. Production mode hides raw messages.
 */

import { logger } from '../config/logger.js';
import { ApiErrorCode } from '@vision/types/errors';

/**
 * Base application error. Preserves a stable error_code for clients and an
 * HTTP status that the middleware forwards as-is. Subclass for specific
 * categories so route handlers can `throw new NotFoundError('thing')` without
 * constructing status codes inline.
 */
export class AppError extends Error {
  /**
   * @param {string} message
   * @param {object} [opts]
   * @param {number} [opts.status=500]
   * @param {string} [opts.code='APP_ERROR']
   * @param {unknown} [opts.cause]  native Error cause (preserved for logs)
   * @param {Record<string, unknown>} [opts.details]  non-sensitive debug info
   */
  constructor(message, { status = 500, code = ApiErrorCode.APP_ERROR, cause, details } = {}) {
    super(message);
    this.name = this.constructor.name;
    this.status = status;
    this.code = code;
    this.details = details;
    if (cause !== undefined) this.cause = cause;
  }
}

export class ValidationError extends AppError {
  constructor(message, opts = {}) {
    super(message, { status: 400, code: ApiErrorCode.VALIDATION_ERROR, ...opts });
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = 'Unauthorized', opts = {}) {
    super(message, { status: 401, code: ApiErrorCode.UNAUTHORIZED, ...opts });
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'Forbidden', opts = {}) {
    super(message, { status: 403, code: ApiErrorCode.FORBIDDEN, ...opts });
  }
}

export class NotFoundError extends AppError {
  constructor(message = 'Not Found', opts = {}) {
    super(message, { status: 404, code: ApiErrorCode.NOT_FOUND, ...opts });
  }
}

export class ConflictError extends AppError {
  constructor(message, opts = {}) {
    super(message, { status: 409, code: ApiErrorCode.CONFLICT, ...opts });
  }
}

export class RateLimitedError extends AppError {
  constructor(message = 'Rate limit exceeded', opts = {}) {
    super(message, { status: 429, code: ApiErrorCode.RATE_LIMITED, ...opts });
  }
}

/**
 * Factory: returns Express error-handling middleware bound to the provided
 * `isProduction` predicate. Injecting the predicate keeps this module free of
 * side-effect imports so it can be unit-tested without spinning up config.
 *
 * @param {() => boolean} isProduction
 * @returns {import('express').ErrorRequestHandler}
 */
export function createErrorHandler(isProduction) {
  return function errorHandler(err, req, res, next) {
    // The response is already committed (e.g. a streaming/SSE handler threw
    // mid-stream). Writing another body would throw ERR_HTTP_HEADERS_SENT, so
    // hand off to Express's default handler which just closes the connection.
    if (res.headersSent) return next(err);

    // Normalize non-Error throws (`throw null`, `throw 'string'`, rejected
    // promises with non-Error values) so property access below is always safe.
    if (!(err instanceof Error)) {
      err = new Error(typeof err === 'string' ? err : 'Unknown error');
    }

    const isApp = err instanceof AppError;
    const status = isApp ? err.status : 500;
    const code = isApp ? err.code : ApiErrorCode.INTERNAL_SERVER_ERROR;

    // Typed 4xx errors are expected business outcomes — log at warn, not error.
    const logFn = status >= 500 ? logger.error : logger.warn;
    logFn.call(logger, isApp ? 'Handled application error' : 'Unhandled exception', {
      error: err.message,
      code,
      status,
      path: req.path,
      method: req.method,
      requestId: req.id,
      ...(err.details ? { details: err.details } : {}),
    });

    let message;
    if (status < 500) {
      // 4xx messages are authored by us — safe to expose.
      message = err.message;
    } else if (isProduction()) {
      message = 'An internal server error occurred. Please try again later.';
    } else {
      message = err.message;
    }

    const error = { code, message };
    if (isApp && err.details !== undefined) error.details = err.details;

    const body = { ok: false, error };
    if (req.id) body.meta = { requestId: req.id };

    res.status(status).json(body);
  };
}
