/**
 * Dynamic SQL clause builders for the repository layer.
 *
 * Repositories repeatedly hand-roll the same idiom to turn a `{column: value}`
 * bag into a parameterized UPDATE `SET` list or INSERT `(columns) VALUES (...)`
 * pair:
 *
 *   for (const [key, value] of Object.entries(fields)) {
 *     setClauses.push(`${col} = $${i++}`);
 *     params.push(value);
 *   }
 *
 * These helpers centralize exactly that loop while preserving every call site's
 * semantics: `undefined` values are always skipped, an optional `allowed`
 * whitelist (Array or Set) gates which keys are written, `quote` wraps each
 * column identifier in double quotes, and `mapColumn` remaps a field name to a
 * DB column. Placeholder numbering starts at `startIdx` (default 1), matching
 * the original `let i = 1`.
 */

export type AllowedKeys = readonly string[] | Set<string>;

export interface ClauseOptions {
  /** whitelist of writable keys */
  allowed?: AllowedKeys;
  /** first placeholder number (default 1) */
  startIdx?: number;
  /** wrap column identifiers in "..." (default false) */
  quote?: boolean;
  /** field → column mapper */
  mapColumn?: (key: string) => string;
}

function isAllowed(allowed: AllowedKeys | undefined, key: string): boolean {
  if (!allowed) return true;
  if (allowed instanceof Set) return allowed.has(key);
  return allowed.includes(key);
}

function renderColumn(
  key: string,
  { quote = false, mapColumn }: Pick<ClauseOptions, 'quote' | 'mapColumn'> = {},
): string {
  const rawColumn = mapColumn ? mapColumn(key) : key;
  return quote ? `"${rawColumn}"` : rawColumn;
}

/**
 * Build a parameterized `SET` clause list from a field bag.
 */
export function buildSetClauses(
  fields: object,
  { allowed, startIdx = 1, quote = false, mapColumn }: ClauseOptions = {},
): { clauses: string[]; params: unknown[]; nextIdx: number } {
  const clauses: string[] = [];
  const params: unknown[] = [];
  let i = startIdx;

  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    if (!isAllowed(allowed, key)) continue;
    clauses.push(`${renderColumn(key, { quote, mapColumn })} = $${i++}`);
    params.push(value);
  }

  return { clauses, params, nextIdx: i };
}

/**
 * Build a parameterized single-row UPDATE from a field bag, matched on `id`.
 *
 * Returns null when no writable field survives the `allowedFields` whitelist —
 * i.e. there is nothing to update. `tableName` is interpolated directly, so the
 * caller MUST pass a trusted/allowlisted identifier, never user input (every
 * current caller passes a fixed table name or one resolved from a static
 * asset-class → table map).
 *
 * @param allowedFields - whitelist of writable keys
 */
export function buildUpdateSql(
  tableName: string,
  id: number | string,
  fields: object,
  allowedFields: AllowedKeys,
): { sql: string; params: unknown[] } | null {
  const { clauses: setClauses, params, nextIdx: idx } = buildSetClauses(fields, { allowed: allowedFields });

  if (!setClauses.length) return null;

  params.push(id);
  return {
    sql: `UPDATE ${tableName} SET ${setClauses.join(', ')} WHERE id = $${idx}`,
    params,
  };
}

/**
 * Build parameterized INSERT column/placeholder lists from a field bag.
 */
export function buildInsert(
  fields: object,
  { allowed, startIdx = 1, quote = false, mapColumn }: ClauseOptions = {},
): { columns: string[]; placeholders: string[]; params: unknown[] } {
  const columns: string[] = [];
  const placeholders: string[] = [];
  const params: unknown[] = [];
  let i = startIdx;

  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    if (!isAllowed(allowed, key)) continue;
    columns.push(renderColumn(key, { quote, mapColumn }));
    placeholders.push(`$${i++}`);
    params.push(value);
  }

  return { columns, placeholders, params };
}

/**
 * Append a parameterized `LIMIT … OFFSET …` tail, or nothing at all when the
 * caller did not ask for a page.
 *
 * `limit == null` means "unbounded" — the list routes that only recently gained
 * pagination must keep returning the full collection when the request carries no
 * limit/offset (see lib/pagination.ts::parseOptionalPagination), so the clause
 * has to disappear rather than fall back to a default page size. Pushes onto the
 * caller's `params` array so placeholder numbering follows the existing filters.
 *
 * @param params - query params built so far (mutated)
 * @returns SQL tail (leading space) — '' when unbounded
 */
export function buildLimitOffset(
  params: unknown[],
  {
    limit = null,
    offset = 0,
  }: { limit?: number | null; offset?: number | null } = {},
): string {
  if (limit == null) return '';
  params.push(limit);
  const limitIdx = params.length;
  params.push(offset ?? 0);
  return ` LIMIT $${limitIdx} OFFSET $${params.length}`;
}
