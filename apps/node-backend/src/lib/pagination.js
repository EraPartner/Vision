/**
 * Shared query-parameter parsing for list endpoints.
 *
 * parseIntClamped is the generic "integer with bounds + fallback" parser (used
 * for pagination and for non-pagination knobs like month windows).
 * parsePagination is the limit/offset convenience built on it, so every list
 * route clamps, floors and falls back identically instead of each hand-rolling
 * its own (which drifted: some floored at 1 and were NaN-safe, the import batch
 * endpoints were neither). Per-resource caps stay configurable via maxLimit.
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
