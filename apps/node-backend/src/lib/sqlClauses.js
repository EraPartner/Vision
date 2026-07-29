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

/**
 * @param {string[]|Set<string>|undefined} allowed
 * @param {string} key
 * @returns {boolean}
 */
function isAllowed(allowed, key) {
  if (!allowed) return true;
  if (allowed instanceof Set) return allowed.has(key);
  return allowed.includes(key);
}

/**
 * @param {string} key
 * @param {{ quote?: boolean, mapColumn?: (key: string) => string }} [options]
 * @returns {string}
 */
function renderColumn(key, { quote = false, mapColumn } = {}) {
  const rawColumn = mapColumn ? mapColumn(key) : key;
  return quote ? `"${rawColumn}"` : rawColumn;
}

/**
 * Build a parameterized `SET` clause list from a field bag.
 *
 * @param {object} fields
 * @param {object} [options]
 * @param {string[]|Set<string>} [options.allowed] - whitelist of writable keys
 * @param {number} [options.startIdx=1] - first placeholder number
 * @param {boolean} [options.quote=false] - wrap column identifiers in "..."
 * @param {(key: string) => string} [options.mapColumn] - field → column mapper
 * @returns {{ clauses: string[], params: unknown[], nextIdx: number }}
 */
export function buildSetClauses(fields, { allowed, startIdx = 1, quote = false, mapColumn } = {}) {
  const clauses = [];
  const params = [];
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
 * @param {string} tableName
 * @param {number|string} id
 * @param {object} fields
 * @param {string[]|Set<string>} allowedFields - whitelist of writable keys
 * @returns {{ sql: string, params: unknown[] } | null}
 */
export function buildUpdateSql(tableName, id, fields, allowedFields) {
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
 *
 * @param {object} fields
 * @param {object} [options]
 * @param {string[]|Set<string>} [options.allowed] - whitelist of writable keys
 * @param {number} [options.startIdx=1] - first placeholder number
 * @param {boolean} [options.quote=false] - wrap column identifiers in "..."
 * @param {(key: string) => string} [options.mapColumn] - field → column mapper
 * @returns {{ columns: string[], placeholders: string[], params: unknown[] }}
 */
export function buildInsert(fields, { allowed, startIdx = 1, quote = false, mapColumn } = {}) {
  const columns = [];
  const placeholders = [];
  const params = [];
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
 * limit/offset (see lib/pagination.js::parseOptionalPagination), so the clause
 * has to disappear rather than fall back to a default page size. Pushes onto the
 * caller's `params` array so placeholder numbering follows the existing filters.
 *
 * @param {unknown[]} params - query params built so far (mutated)
 * @param {{ limit?: number|null, offset?: number|null }} [page]
 * @returns {string} SQL tail (leading space) — '' when unbounded
 */
export function buildLimitOffset(params, { limit = null, offset = 0 } = {}) {
  if (limit == null) return '';
  params.push(limit);
  const limitIdx = params.length;
  params.push(offset ?? 0);
  return ` LIMIT $${limitIdx} OFFSET $${params.length}`;
}
