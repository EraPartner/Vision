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
