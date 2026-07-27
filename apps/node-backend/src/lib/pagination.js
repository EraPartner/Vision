/**
 * Shared query-parameter parsing for list endpoints.
 *
 * parseIntClamped is the generic "integer with bounds + fallback" parser (used
 * for pagination and for non-pagination knobs like month windows).
 * parsePagination is the limit/offset convenience built on it, so every list
 * route clamps, floors and falls back identically instead of each hand-rolling
 * its own (which drifted: some floored at 1 and were NaN-safe, the import batch
 * endpoints were neither). Per-resource caps stay configurable via maxLimit.
 *
 * parseOptionalPagination is the opt-in variant for endpoints that historically
 * returned the WHOLE collection: it reports "not paginating" (null) when the
 * caller sent neither limit nor offset, so adding pagination to an existing list
 * route cannot silently truncate a UI that never asked for a page.
 */

/**
 * @param {unknown} raw
 * @param {{ min?: number, max?: number, fallback: number }} bounds
 * @returns {number}
 */
export function parseIntClamped(raw, { min = 1, max, fallback }) {
  const parsed = parseInt(/** @type {string} */ (raw), 10);
  if (!Number.isFinite(parsed) || parsed < min) return fallback;
  return max != null ? Math.min(parsed, max) : parsed;
}

/**
 * @param {Record<string, unknown>} [query]
 * @param {{ defaultLimit?: number, maxLimit?: number }} [options]
 * @returns {{ limit: number, offset: number }}
 */
export function parsePagination(query = {}, { defaultLimit = 50, maxLimit } = {}) {
  return {
    limit: parseIntClamped(query.limit, { min: 1, max: maxLimit, fallback: defaultLimit }),
    offset: parseIntClamped(query.offset, { min: 0, fallback: 0 }),
  };
}

/**
 * Opt-in pagination: returns null when the caller supplied neither `limit` nor
 * `offset`, meaning "serve the full collection, exactly as before".
 *
 * When either param is present the pair is parsed with parsePagination's rules,
 * except that the limit fallback is the per-resource cap rather than a small
 * page size — an offset-only request means "everything from here", not "the
 * next 50". Empty-string params (`?limit=`) count as absent: a client that
 * renders a form field it left blank gets the full list, not a surprise page.
 *
 * @param {Record<string, unknown> | undefined} query
 * @param {{ defaultLimit?: number, maxLimit: number }} options
 * @returns {{ limit: number, offset: number } | null}
 */
export function parseOptionalPagination(query, { defaultLimit, maxLimit }) {
  const supplied = (key) => {
    const value = query?.[key];
    return value !== undefined && value !== null && value !== '';
  };
  if (!supplied('limit') && !supplied('offset')) return null;
  return parsePagination(query, { defaultLimit: defaultLimit ?? maxLimit, maxLimit });
}

/**
 * Canonical collection body: `{items, total}`, plus `{limit, offset}` when the
 * request actually paginated (docs/reference/code-patterns.md, "List Response
 * Envelope Pattern"). `total` is always the full match count, never the page
 * length.
 *
 * @template T
 * @param {T[]} items
 * @param {number} total
 * @param {{ limit: number, offset: number } | null} [page]
 */
export function listBody(items, total, page = null) {
  return page ? { items, total, limit: page.limit, offset: page.offset } : { items, total };
}
