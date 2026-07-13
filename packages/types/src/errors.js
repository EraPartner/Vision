/**
 * Stable, client-visible error codes emitted by the unified API envelope
 * (see docs/adr/026-unified-api-response-envelope.md).
 *
 * Keep this list append-only — downstream UIs switch on these codes for
 * i18n messages and branching logic. Retiring a code is a breaking change.
 */

export const ApiErrorCode = Object.freeze({
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN: 'FORBIDDEN',
  RATE_LIMITED: 'RATE_LIMITED',
  INTERNAL_SERVER_ERROR: 'INTERNAL_SERVER_ERROR',
  BAD_GATEWAY: 'BAD_GATEWAY',
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',
  APP_ERROR: 'APP_ERROR',
});

/** @typedef {typeof ApiErrorCode[keyof typeof ApiErrorCode]} ApiErrorCodeValue */
