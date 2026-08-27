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
 * Pagination lives in the response BODY, not in `meta`.
 *
 * A collection endpoint answers `{ items, total }`, and adds `limit` + `offset`
 * whenever the request actually paginated — `total` is always the full match
 * count, never the length of the page. Endpoints that only recently gained
 * pagination keep answering the complete list when no limit/offset is supplied
 * (lib/pagination.js::parseOptionalPagination), so `limit`/`offset` are absent
 * exactly when the body already holds everything.
 *
 *   { ok: true, data: { items: [...], total: 128, limit: 50, offset: 50 } }
 *
 * A composite payload that embeds one list (e.g. /api/info/net-worth) prefixes
 * the same fields with the list they describe: `snapshotsTotal`,
 * `snapshotsLimit`, `snapshotsOffset`.
 *
 * There is deliberately no `meta.pagination`: an earlier `ResponsePagination`
 * typedef documented one, but a single endpoint ever emitted it while every
 * other list used the body, so the envelope-level variant was dropped rather
 * than migrated onto (see docs/reference/code-patterns.md, "List Response
 * Envelope Pattern").
 */

/**
 * Optional response metadata. Every response may carry `requestId` (stamped by
 * the correlation middleware), while route-specific facts such as `source`,
 * `provider`, or `computedAt` live beside it at the top level. Pagination does
 * NOT belong here — see the note above.
 *
 * @typedef {Record<string, unknown> & { requestId?: string }} ResponseMeta
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
