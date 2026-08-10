/**
 * Centralized error handling middleware with typed error classes.
 *
 * Routes and services throw typed errors (AppError, ValidationError, NotFoundError,
 * ConflictError, UnauthorizedError, ForbiddenError, RateLimitedError, UpstreamError,
 * UpstreamTimeoutError); middleware maps them to the unified API
 * envelope (see docs/adr/026-unified-api-response-envelope.md):
 *   { ok: false, error: { code, message, details? }, meta? }
 *
 * Untyped errors fall through to a 500 with the production-safe message used by
 * the previous inline handler in main.js. Production mode hides raw messages.
 *
 * One exception: an untyped error that carries its own 4xx status (body-parser's
 * http-errors, raised before any route runs) keeps that status. See THE RULE
 * above `forwardable4xx` for exactly when, and when its message is echoed.
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
  /** @param {string} message */
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
  /** @param {string} message */
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
 * A third-party upstream (price provider, Ollama, research API) failed or
 * answered garbage: non-2xx status, oversized/malformed payload, broken
 * redirect chain. 502 tells the client the fault is a dependency, not us or
 * their request.
 *
 * Masking: status ≥ 500, so the handler's existing 5xx split applies — message
 * verbatim in development, masked in production. Deliberate: although the
 * wording is authored by our services, it routinely embeds upstream detail
 * (provider URLs, upstream HTTP statuses, echoed provider text — e.g.
 * "Ollama call failed: …"), unlike the fully-authored 4xx messages. The stable
 * `code` still reaches the client for branching; put safe extras in `details`.
 */
export class UpstreamError extends AppError {
  /** @param {string} message */
  constructor(message, opts = {}) {
    super(message, { status: 502, code: ApiErrorCode.BAD_GATEWAY, ...opts });
  }
}

/**
 * An upstream call exceeded its deadline. 504 variant of UpstreamError —
 * same production masking rationale.
 */
export class UpstreamTimeoutError extends AppError {
  constructor(message = 'Upstream request timed out', opts = {}) {
    super(message, { status: 504, code: ApiErrorCode.GATEWAY_TIMEOUT, ...opts });
  }
}

/* ── Non-AppError errors that carry their own HTTP status ─────────────────
 *
 * Some errors reaching this handler are not ours and never will be: body-parser
 * (mounted by `express.json()` in main.js:130) rejects a request BEFORE any
 * route runs and raises an `http-errors` instance carrying the correct status —
 * 400 for truncated JSON, 413 for a body over the 1 MB cap. Collapsing those to
 * 500 reports a client typo as a server fault, and in production the 5xx
 * sanitizer then hides the one thing the client needed to know ("request entity
 * too large").
 *
 * THE RULE (two independent decisions — status, then message):
 *
 *  1. STATUS is forwarded when a non-AppError carries a numeric `status` or
 *     `statusCode` in the 400-499 range. 5xx and nonsense values (NaN, 0, 700,
 *     strings) are ignored and still take the sanitized 500 path, so an
 *     internal failure can never downgrade itself into a client error.
 *
 *  2. MESSAGE is echoed verbatim ONLY when the error also carries a `type` from
 *     `TRUSTED_ERROR_TYPES` below — body-parser's fixed, non-sensitive strings.
 *     Every other forwarded 4xx gets the generic reason phrase for its status.
 *     Reason: `.status`/`.statusCode` is a convention any library may adopt,
 *     and its message is not vetted. In this codebase the only other non-AppError
 *     with a status is `OllamaError` (integrations/ollama/client.js:25), which
 *     stores the UPSTREAM provider's HTTP status and a message naming our
 *     internal call ("Ollama POST /api/chat failed with 404"); it is normally
 *     wrapped into an AppError (aiChatService.js:325), but if one ever escapes,
 *     this rule keeps the wording out of the response.
 *
 *     `services/calculations/loanSchedule.js` used to be cited here as a second
 *     example. It no longer is: its two throws were the case where clause 2 cost
 *     something real — the text ("Invalid loan configuration: <enumerated
 *     reasons>") is authored by us and safe, but a bare `statusCode` made it
 *     indistinguishable from an unvetted library message, so it was replaced by
 *     "Bad Request". They now throw `ValidationError`, which is the right way to
 *     get an authored 4xx message through: same status, full fidelity, via the
 *     AppError path rather than by widening the trust rule.
 *
 * `details` is still AppError-only: nothing here fabricates one.
 */

/** body-parser `type` values whose message is a fixed library string, safe to echo. */
const TRUSTED_ERROR_TYPES = new Set([
  'entity.parse.failed', // 400 — malformed/truncated JSON body
  'entity.too.large', // 413 — body over the express.json({ limit }) cap
  'parameters.too.many', // 413 — urlencoded parameter-count cap
  'request.aborted', // 400 — client hung up mid-body
  'request.size.invalid', // 400 — Content-Length disagreed with the body read
  'charset.unsupported', // 415
  'encoding.unsupported', // 415
  'entity.verify.failed', // 403 — an express.json({ verify }) hook rejected it
]);

/** Generic reason phrases for a forwarded 4xx whose own message is not trusted. */
const GENERIC_4XX_MESSAGES = {
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  405: 'Method Not Allowed',
  409: 'Conflict',
  413: 'Payload Too Large',
  415: 'Unsupported Media Type',
  422: 'Unprocessable Content',
  429: 'Too Many Requests',
};

/**
 * Map a forwarded 4xx status onto the stable client-visible code vocabulary
 * (ADR-026). The list is deliberately the existing one — no new codes are
 * minted for these, since every UI already branches on VALIDATION_ERROR for a
 * "your request was wrong" outcome.
 *
 * @param {number} status
 * @returns {string}
 */
function codeForForwardedStatus(status) {
  switch (status) {
    case 401: return ApiErrorCode.UNAUTHORIZED;
    case 403: return ApiErrorCode.FORBIDDEN;
    case 404: return ApiErrorCode.NOT_FOUND;
    case 409: return ApiErrorCode.CONFLICT;
    case 429: return ApiErrorCode.RATE_LIMITED;
    // 400 / 405 / 413 / 415 / 422 / any other 4xx: the request itself was
    // rejected — VALIDATION_ERROR is the code clients already handle for that.
    default: return ApiErrorCode.VALIDATION_ERROR;
  }
}

/**
 * Decide whether a non-AppError may keep its own status, per THE RULE above.
 *
 * @param {any} err
 * @returns {{ status: number, code: string, message: string }|null} null when the
 *   error must take the ordinary 500 path.
 */
function forwardable4xx(err) {
  const raw = typeof err.status === 'number' ? err.status : err.statusCode;
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 400 || raw > 499) return null;

  const trusted = typeof err.type === 'string' && TRUSTED_ERROR_TYPES.has(err.type);
  return {
    status: raw,
    code: codeForForwardedStatus(raw),
    message: trusted ? err.message : (GENERIC_4XX_MESSAGES[/** @type {keyof typeof GENERIC_4XX_MESSAGES} */ (raw)] || 'Request rejected'),
  };
}

/**
 * Factory: returns Express error-handling middleware bound to the provided
 * `isProduction` predicate. Injecting the predicate keeps this module free of
 * side-effect imports so it can be unit-tested without spinning up config.
 *
 * `express`'s `ErrorRequestHandler` type is not referenced here — express
 * ships no type declarations and `@types/express` is not a workspace
 * dependency, so referencing its types resolves to an implicit `any`
 * (TS7016) under `noImplicitAny`; the returned function is typed inline via
 * the shared structural types instead (types/express.js).
 * @param {() => boolean} isProduction
 * @returns {(err: any, req: import('../types/express.js').ExpressRequest, res: import('../types/express.js').ExpressResponse, next: import('../types/express.js').ExpressNextFunction) => void}
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
    // Errors raised before any route ran (body-parser) carry a correct 4xx of
    // their own — see THE RULE above for when it is honoured.
    const forwarded = isApp ? null : forwardable4xx(err);
    const status = isApp ? err.status : (forwarded ? forwarded.status : 500);
    const code = isApp ? err.code : (forwarded ? forwarded.code : ApiErrorCode.INTERNAL_SERVER_ERROR);

    // Typed 4xx errors are expected business outcomes — log at warn, not error.
    const logFn = status >= 500 ? logger.error : logger.warn;
    const logLabel = isApp
      ? 'Handled application error'
      : (forwarded ? 'Rejected request' : 'Unhandled exception');
    logFn.call(logger, logLabel, {
      error: err.message,
      code,
      status,
      path: req.path,
      method: req.method,
      requestId: req.id,
      ...(err.details ? { details: err.details } : {}),
    });

    let message;
    if (forwarded) {
      // Not ours: body-parser's fixed strings pass through, everything else
      // gets the generic reason phrase. Unlike the 5xx branch this is NOT
      // environment-dependent — the whole point is that a client hitting the
      // body-size cap in production can still read why.
      message = forwarded.message;
    } else if (status < 500) {
      // 4xx messages are authored by us — safe to expose.
      message = err.message;
    } else if (isProduction()) {
      message = 'An internal server error occurred. Please try again later.';
    } else {
      message = err.message;
    }

    /** @type {{ code: any, message: any, details?: unknown }} */
    const error = { code, message };
    if (isApp && err.details !== undefined) error.details = err.details;

    /** @type {{ ok: false, error: typeof error, meta?: import('@vision/types/api').ResponseMeta }} */
    const body = { ok: false, error };
    if (req.id) body.meta = { requestId: req.id };

    res.status(status).json(body);
  };
}
