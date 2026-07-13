/**
 * Unified API response envelope — see docs/adr/026-unified-api-response-envelope.md.
 *
 * Every Vision HTTP endpoint returns a discriminated union keyed on `ok`.
 * Success: { ok: true, data, meta? }
 * Failure: { ok: false, error: { code, message, details? } }
 *
 * This file carries only JSDoc typedefs and a re-export of ApiErrorCode — the
 * envelope has no runtime shape of its own, so nothing to instantiate here.
 */

export { ApiErrorCode } from './errors.js';

/**
 * Pagination cursor. Endpoints use either `page` or `offset`, never both.
 *
 * @typedef {object} ResponsePagination
 * @property {number} total
 * @property {number} limit
 * @property {number} [page]
 * @property {number} [offset]
 * @property {boolean} [hasMore]
 */

/**
 * Optional response metadata. Paginated endpoints populate `pagination`;
 * every response may carry `requestId` once correlation middleware lands.
 *
 * @typedef {object} ResponseMeta
 * @property {string} [requestId]
 * @property {ResponsePagination} [pagination]
 * @property {Record<string, unknown>} [extra]
 */

/**
 * Shape of an envelope error payload.
 *
 * @typedef {object} ApiError
 * @property {import('./errors.js').ApiErrorCodeValue} code
 * @property {string} message
 * @property {unknown} [details]
 */

/**
 * Success envelope. Generic over the data payload.
 *
 * @template T
 * @typedef {{ ok: true, data: T, meta?: ResponseMeta }} ApiSuccess
 */

/**
 * Failure envelope.
 *
 * @typedef {{ ok: false, error: ApiError, meta?: ResponseMeta }} ApiFailure
 */

/**
 * Full discriminated union.
 *
 * @template T
 * @typedef {ApiSuccess<T> | ApiFailure} ApiResponse
 */
