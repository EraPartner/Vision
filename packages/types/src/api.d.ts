/**
 * Unified API envelope — TypeScript surface (see docs/adr/026-unified-api-response-envelope.md).
 */

import type { ApiErrorCodeValue } from './errors.js';

export { ApiErrorCode } from './errors.js';
export type { ApiErrorCodeValue } from './errors.js';

export interface ResponsePagination {
  total: number;
  limit: number;
  /** Page-based pagination cursor (1-indexed). Mutually exclusive with offset. */
  page?: number;
  /** Offset-based pagination cursor (0-indexed row count). Mutually exclusive with page. */
  offset?: number;
  hasMore?: boolean;
}

export interface ResponseMeta {
  requestId?: string;
  pagination?: ResponsePagination;
  extra?: Record<string, unknown>;
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
