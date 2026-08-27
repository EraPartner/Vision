/**
 * Unified API envelope — TypeScript surface (see docs/adr/026-unified-api-response-envelope.md).
 */

import type { ApiErrorCodeValue } from './errors.js';

export { ApiErrorCode } from './errors.js';
export type { ApiErrorCodeValue } from './errors.js';

/**
 * Pagination lives in the response BODY (`{items, total, limit?, offset?}`),
 * never in `meta` — see the note in api.js. There is intentionally no
 * `ResponsePagination` type here.
 */
export interface ResponseMeta {
  requestId?: string;
  [key: string]: unknown;
}

export interface ApiError {
  code: ApiErrorCodeValue;
  message: string;
  details?: unknown;
}

export interface ApiSuccess<T> {
  ok: true;
  data: T;
  meta?: ResponseMeta;
}

export interface ApiFailure {
  ok: false;
  error: ApiError;
  meta?: ResponseMeta;
}

export type ApiResponse<T> = ApiSuccess<T> | ApiFailure;
