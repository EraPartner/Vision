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

export interface PageParams {
  limit: number;
  offset: number;
}

export function parseIntClamped(
  raw: unknown,
  { min = 1, max, fallback }: { min?: number; max?: number; fallback: number },
): number {
  // parseInt applies ToString itself; String() only makes that explicit.
  const parsed = parseInt(String(raw), 10);
  if (!Number.isFinite(parsed) || parsed < min) return fallback;
  return max != null ? Math.min(parsed, max) : parsed;
}

export function parsePagination(
  query: Record<string, unknown> = {},
  { defaultLimit = 50, maxLimit }: { defaultLimit?: number; maxLimit?: number } = {},
): PageParams {
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
 */
export function parseOptionalPagination(
  query: Record<string, unknown> | undefined,
  { defaultLimit, maxLimit }: { defaultLimit?: number; maxLimit: number },
): PageParams | null {
  const supplied = (key: string) => {
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
 */
export function listBody<T>(
  items: T[],
  total: number,
  page: PageParams | null = null,
) {
  return page ? { items, total, limit: page.limit, offset: page.offset } : { items, total };
}
