/**
 * TypeScript declarations for ./errors.js — the runtime enum of stable,
 * client-visible API error codes (see docs/adr/026-unified-api-response-envelope.md).
 */

export declare const ApiErrorCode: Readonly<{
  VALIDATION_ERROR: 'VALIDATION_ERROR';
  NOT_FOUND: 'NOT_FOUND';
  CONFLICT: 'CONFLICT';
  UNAUTHORIZED: 'UNAUTHORIZED';
  FORBIDDEN: 'FORBIDDEN';
  RATE_LIMITED: 'RATE_LIMITED';
  INTERNAL_SERVER_ERROR: 'INTERNAL_SERVER_ERROR';
  BAD_GATEWAY: 'BAD_GATEWAY';
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE';
  APP_ERROR: 'APP_ERROR';
}>;

export type ApiErrorCodeValue = typeof ApiErrorCode[keyof typeof ApiErrorCode];

export declare function isApiErrorCode(value: unknown): value is ApiErrorCodeValue;
