/**
 * Recipient Pattern Service
 *
 * Compiles and evaluates per-recipient match patterns
 * (literal_prefix / glob / regex) so the import pipeline can normalize
 * variable bank descriptions to canonical recipients before the fuzzy
 * pg_trgm fallback runs.
 *
 * Patterns are evaluated against the uppercase trimmed recipient_raw
 * value (the same form adapters store in import_staging_rows.recipient_raw).
 */

import { query } from '../database/connection.js';
import { logger } from '../config/logger.js';

const MIN_LCP_LENGTH = 8;

const STOP_PATTERNS = new Set([
  'PAYMENT', 'PAYMENT TO', 'PAYMENT FROM',
  'TRANSFER', 'TRANSFER TO', 'TRANSFER FROM',
  'SENT TO', 'RECEIVED FROM',
  'FROM', 'TO',
]);

/** Simple fixed-size LRU cache keyed by string. */
function makeLruCache(maxSize) {
  const map = new Map();
  return {
    get(k) {
      if (!map.has(k)) return undefined;
      const v = map.get(k);
      map.delete(k);
      map.set(k, v);
      return v;
    },
    set(k, v) {
      if (map.has(k)) map.delete(k);
      else if (map.size >= maxSize) map.delete(map.keys().next().value);
      map.set(k, v);
    },
  };
}

const patternCache = makeLruCache(512);

/**
 * Compile a pattern DB row into a RegExp.
 * Cached by `${id}:${updated_at}` so stale entries are evicted on update.
 *
 * @param {{ id: number, pattern: string, pattern_kind: string, case_sensitive: boolean, updated_at: string }} row
 * @returns {RegExp}
 */
export function compilePattern(row) {
  const cacheKey = `${row.id}:${row.updated_at}`;
  const cached = patternCache.get(cacheKey);
  if (cached) return cached;

  const flags = row.case_sensitive ? '' : 'i';
  let re;

  switch (row.pattern_kind) {
    case 'literal_prefix': {
      const escaped = row.pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      re = new RegExp(`^${escaped}`, flags);
      break;
    }
    case 'glob': {
      const translated = row.pattern
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '.*')
        .replace(/\?/g, '.');
      re = new RegExp(`^${translated}$`, flags);
      break;
    }
    case 'regex':
    default: {
      re = new RegExp(row.pattern, flags);
      break;
    }
  }

  patternCache.set(cacheKey, re);
  return re;
}

/**
 * Validate a pattern string server-side before saving.
 * Rejects: empty, too long, or patterns that fail to compile.
 *
 * @param {{ pattern: string, pattern_kind: string, case_sensitive: boolean }} row
 * @returns {{ valid: boolean, error?: string }}
 */
export function validatePattern(row) {
  if (!row.pattern || !row.pattern.trim()) {
    return { valid: false, error: 'Pattern must not be empty' };
  }
  if (row.pattern.length > 500) {
    return { valid: false, error: 'Pattern must not exceed 500 characters' };
  }
  try {
    compilePattern({ id: 0, updated_at: '0', ...row });
    return { valid: true };
  } catch (err) {
    return { valid: false, error: `Invalid pattern: ${err.message}` };
  }
}

/**
 * Load all active patterns from DB, ordered by (priority ASC, id ASC).
 * Returns raw rows — callers compile as needed.
 *
 * @returns {Promise<Array<{id: number, recipient_id: number, pattern: string, pattern_kind: string, case_sensitive: boolean, priority: number, source: string, updated_at: string}>>}
 */
export async function loadActivePatterns() {
  const { rows } = await query(
    `SELECT id, recipient_id, pattern, pattern_kind, case_sensitive,
            priority, source, updated_at::text AS updated_at
       FROM recipient_match_patterns
      WHERE is_active = true
      ORDER BY priority ASC, id ASC`,
  );
  return rows;
}

/**
 * Apply active patterns to a set of distinct raw recipient strings.
 * Returns a Map of raw → { recipientId, patternId }.
 *
 * Runs pattern phase before the fuzzy fallback.  Rows not matched here
 * are left for findBestRecipientMatches.
 *
 * @param {string[]} distinctRaw
 * @param {Array} [preloadedPatterns]  optional: pass already-loaded patterns to avoid a DB round-trip
 * @returns {Promise<Map<string, { recipientId: number, patternId: number }>>}
 */
export async function applyPatterns(distinctRaw, preloadedPatterns) {
  const result = new Map();
  if (!distinctRaw.length) return result;

  const patternRows = preloadedPatterns ?? await loadActivePatterns();
  if (!patternRows.length) return result;

  for (const raw of distinctRaw) {
    if (!raw) continue;
    const upper = raw.trim().toUpperCase();
    for (const prow of patternRows) {
      let re;
      try {
        re = compilePattern(prow);
      } catch (err) {
        logger.warn('[recipientPatternService] bad pattern, skipping', { id: prow.id, err: err.message });
        continue;
      }
      if (re.test(upper)) {
        result.set(raw, { recipientId: prow.recipient_id, patternId: prow.id });
        break;
      }
    }
  }

  return result;
}

/**
 * Compute the longest common prefix across an array of uppercase strings,
 * then trim any trailing partial word/punctuation.
 *
 * @param {string[]} strs
 * @returns {string}
 */
function longestCommonPrefix(strs) {
  if (!strs.length) return '';
  let prefix = strs[0];
  for (let i = 1; i < strs.length; i++) {
    while (!strs[i].startsWith(prefix)) {
      prefix = prefix.slice(0, -1);
      if (!prefix) return '';
    }
  }
  // Trim trailing partial word (stop at last word boundary or trailing space).
  return prefix.replace(/[\s,\-.']+$/, '');
}

/**
 * Suggest a literal_prefix pattern from a set of raw recipient names.
 * Used after merges and in the import preview "+ pattern" flow.
 *
 * Returns null when the LCP is too short, in the stop-list, or not
 * meaningfully narrower than a full match.
 *
 * @param {string[]} names  — array of raw recipient_raw values (uppercase expected)
 * @returns {{ kind: 'literal_prefix', pattern: string, confidence: 'high'|'medium' } | null}
 */
export function suggestPatternFromNames(names) {
  if (!names || names.length < 2) return null;

  const upper = names.map((n) => String(n).trim().toUpperCase());
  const lcp = longestCommonPrefix(upper);

  if (lcp.length < MIN_LCP_LENGTH) return null;
  if (STOP_PATTERNS.has(lcp.trim())) return null;

  const confidence = lcp.length >= 16 ? 'high' : 'medium';
  return { kind: 'literal_prefix', pattern: lcp, confidence };
}

/**
 * Preview how many recipients in the DB have a normalized_name or name
 * that the given pattern would match.
 *
 * Used to warn the user when a new pattern would collide with recipients
 * outside the intended merge set.
 *
 * @param {{ pattern: string, pattern_kind: string, case_sensitive: boolean }} patternRow
 * @returns {Promise<{ matchCount: number, recipientIds: number[] }>}
 */
export async function previewPatternMatches(patternRow) {
  const validation = validatePattern(patternRow);
  if (!validation.valid) {
    throw new Error(validation.error);
  }

  const { rows: recipients } = await query(
    `SELECT id, name FROM recipients WHERE is_active = true`,
  );

  let re;
  try {
    re = compilePattern({ id: 0, updated_at: '0', ...patternRow });
  } catch (err) {
    throw new Error(`Pattern compilation failed: ${err.message}`, { cause: err });
  }

  const matching = recipients.filter((r) => re.test(r.name.toUpperCase()));
  return {
    matchCount: matching.length,
    recipientIds: matching.map((r) => r.id),
  };
}

/**
 * Persist a new pattern for a recipient.
 *
 * @param {{ recipientId: number, pattern: string, pattern_kind: string, case_sensitive?: boolean, priority?: number, source?: string, notes?: string }} opts
 * @returns {Promise<{ id: number }>}
 */
export async function createPattern(opts) {
  const validation = validatePattern(opts);
  if (!validation.valid) throw new Error(validation.error);

  const { rows } = await query(
    `INSERT INTO recipient_match_patterns
       (recipient_id, pattern, pattern_kind, case_sensitive, priority, source, notes)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id`,
    [
      opts.recipientId,
      opts.pattern,
      opts.pattern_kind ?? 'literal_prefix',
      opts.case_sensitive ?? false,
      opts.priority ?? 100,
      opts.source ?? 'user',
      opts.notes ?? null,
    ],
  );
  return { id: rows[0].id };
}

/**
 * Update an existing pattern row.
 *
 * @param {number} patternId
 * @param {{ pattern?: string, pattern_kind?: string, case_sensitive?: boolean, priority?: number, is_active?: boolean, notes?: string }} updates
 * @returns {Promise<void>}
 */
export async function updatePattern(patternId, updates) {
  if (updates.pattern !== undefined || updates.pattern_kind !== undefined || updates.case_sensitive !== undefined) {
    const validation = validatePattern({
      pattern: updates.pattern ?? '',
      pattern_kind: updates.pattern_kind ?? 'literal_prefix',
      case_sensitive: updates.case_sensitive ?? false,
    });
    if (!validation.valid) throw new Error(validation.error);
  }

  const fields = [];
  const values = [];
  let idx = 1;

  for (const [col, val] of Object.entries(updates)) {
    if (['pattern', 'pattern_kind', 'case_sensitive', 'priority', 'is_active', 'notes'].includes(col)) {
      fields.push(`${col} = $${idx++}`);
      values.push(val);
    }
  }
  if (!fields.length) return;

  values.push(patternId);
  await query(
    `UPDATE recipient_match_patterns SET ${fields.join(', ')} WHERE id = $${idx}`,
    values,
  );
}

/**
 * Delete a pattern by id.
 *
 * @param {number} patternId
 * @returns {Promise<void>}
 */
export async function deletePattern(patternId) {
  await query(`DELETE FROM recipient_match_patterns WHERE id = $1`, [patternId]);
}

/**
 * List all patterns for a recipient.
 *
 * @param {number} recipientId
 * @returns {Promise<Array>}
 */
export async function listPatternsForRecipient(recipientId) {
  const { rows } = await query(
    `SELECT id, pattern, pattern_kind, case_sensitive, priority, is_active, source, notes,
            created_at, updated_at
       FROM recipient_match_patterns
      WHERE recipient_id = $1
      ORDER BY priority ASC, id ASC`,
    [recipientId],
  );
  return rows;
}
