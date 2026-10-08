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

import { query } from '../database/connection.ts';
import { buildSetClauses } from '../lib/sqlClauses.ts';
import { logger } from '../config/logger.ts';
import { ValidationError, NotFoundError } from '../middleware/errorHandler.ts';
import type { RecipientMatchPatternRow } from '../types/rows.ts';

export type { RecipientMatchPatternRow };

/**
 * `RecipientMatchPatternRow` as `loadActivePatterns` projects it: `updated_at`
 * is explicitly cast to text in that query (used verbatim in the compile-cache
 * key), so it is `string` here rather than the raw row's `Date`.
 */
export type ActivePatternRow = Omit<RecipientMatchPatternRow, 'updated_at'|'created_at'> & { updated_at: string };

const MIN_LCP_LENGTH = 8;

const STOP_PATTERNS = new Set([
  'PAYMENT', 'PAYMENT TO', 'PAYMENT FROM',
  'TRANSFER', 'TRANSFER TO', 'TRANSFER FROM',
  'SENT TO', 'RECEIVED FROM',
  'FROM', 'TO',
]);

/**
 * Simple fixed-size LRU cache keyed by string. Only ever holds compiled
 * `RegExp`s (the pattern cache below) — typed to that instead of a generic
 * `<K,V>` cache since there is exactly one caller.
 */
function makeLruCache(maxSize: number) {
  const map = new Map<string, RegExp>();
  return {
    get(k: string): RegExp | undefined {
      const v = map.get(k);
      if (v === undefined) return undefined;
      map.delete(k);
      map.set(k, v);
      return v;
    },
    set(k: string, v: RegExp) {
      if (map.has(k)) map.delete(k);
      else if (map.size >= maxSize) {
        const oldest = map.keys().next();
        if (!oldest.done) map.delete(oldest.value);
      }
      map.set(k, v);
    },
  };
}

const patternCache = makeLruCache(512);

/**
 * Build the RegExp for a pattern. Throws on an invalid regex: validation
 * rejects it on save, and compilePattern turns it into a never-match at
 * match time so one bad stored row cannot break matching.
 */
function buildPatternRegExp(row: {
  pattern: string;
  pattern_kind: string;
  case_sensitive?: boolean;
}): RegExp {
  const flags = row.case_sensitive ? '' : 'i';
  switch (row.pattern_kind) {
    case 'literal_prefix': {
      const escaped = row.pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return new RegExp(`^${escaped}`, flags);
    }
    case 'glob': {
      const translated = row.pattern
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '.*')
        .replace(/\?/g, '.');
      return new RegExp(`^${translated}$`, flags);
    }
    case 'regex':
    default:
      // User-authored regex by design; validatePattern screens ReDoS shapes.
      return new RegExp(row.pattern, flags);
  }
}

/**
 * Compile a pattern DB row into a RegExp.
 * Cached by `${id}:${updated_at}` so stale entries are evicted on update.
 */
function compilePattern(row: {
  id: number;
  pattern: string;
  pattern_kind: string;
  case_sensitive: boolean;
  updated_at: string;
}): RegExp {
  const cacheKey = `${row.id}:${row.updated_at}:${row.pattern_kind}:${row.case_sensitive ? '1' : '0'}:${row.pattern}`;
  const cached = patternCache.get(cacheKey);
  if (cached) return cached;

  let re: RegExp;
  try {
    re = buildPatternRegExp(row);
  } catch (err) {
    logger.warn('Skipping invalid regex pattern', { patternId: row.id, pattern: row.pattern, error: (err as Error).message });
    re = /(?!)/;
  }

  patternCache.set(cacheKey, re);
  return re;
}

/**
 * Detect the most common ReDoS vectors in a raw regex pattern string:
 * nested quantifiers (a+)+ and quantified alternation (a|b)+ with overlap.
 *
 * This is a conservative static heuristic — not exhaustive, but catches the
 * patterns that cause catastrophic backtracking in practice.
 */
function hasRedosRisk(pattern: string): boolean {
  // Remove character classes so [...+*] doesn't confuse the group scanner.
  const stripped = pattern.replace(/\[(?:[^\]\\]|\\.)*\]/g, '[]');
  // Nested quantifier inside a group: (...QUANT...)QUANT
  if (/\((?:[^()]*[+*][^()]*)\)[+*{?]/.test(stripped)) return true;
  // Alternation inside a quantified group: (A|B)+
  // Only flag when both branches share a non-trivial prefix (overlap check omitted
  // for simplicity — flag all alternation-under-quantifier as potentially unsafe).
  if (/\((?:[^()]*\|[^()]*)\)[+*{]/.test(stripped)) return true;
  return false;
}

/**
 * Validate a pattern string server-side before saving.
 * Rejects: empty, too long, ReDoS-risky (regex kind), or patterns that fail to compile.
 */
function validatePattern(row: {
  pattern: string;
  pattern_kind: string;
  case_sensitive?: boolean;
}): { valid: true; error?: undefined } | { valid: false; error: string } {
  if (!row.pattern || !row.pattern.trim()) {
    return { valid: false, error: 'Pattern must not be empty' };
  }
  if (row.pattern.length > 500) {
    return { valid: false, error: 'Pattern must not exceed 500 characters' };
  }
  if (row.pattern_kind === 'regex' && hasRedosRisk(row.pattern)) {
    return { valid: false, error: 'Regex pattern contains nested quantifiers or quantified alternation that could cause catastrophic backtracking' };
  }
  try {
    buildPatternRegExp(row);
    return { valid: true };
  } catch (err) {
    return { valid: false, error: `Invalid pattern: ${(err as Error).message}` };
  }
}

/**
 * Load all active patterns from DB, ordered by (priority ASC, id ASC).
 * Returns raw rows — callers compile as needed.
 */
export async function loadActivePatterns(): Promise<ActivePatternRow[]> {
  const { rows } = await query<ActivePatternRow>(
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
 * @param preloadedPatterns  optional: pass already-loaded patterns to avoid a DB round-trip
 */
export async function applyPatterns(
  distinctRaw: string[],
  preloadedPatterns?: ActivePatternRow[],
): Promise<Map<string, { recipientId: number; patternId: number }>> {
  const result = new Map<string, { recipientId: number; patternId: number }>();
  if (!distinctRaw.length) return result;

  const patternRows = preloadedPatterns ?? await loadActivePatterns();
  if (!patternRows.length) return result;

  for (const raw of distinctRaw) {
    if (!raw) continue;
    const upper = raw.trim().toUpperCase();
    for (const prow of patternRows) {
      let re: RegExp;
      try {
        re = compilePattern(prow);
      } catch (err) {
        logger.warn('[recipientPatternService] bad pattern, skipping', { id: prow.id, err: (err as Error).message });
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
 */
function longestCommonPrefix(strs: string[]): string {
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
 * @param names  — array of raw recipient_raw values (uppercase expected)
 */
export function suggestPatternFromNames(
  names: string[] | null | undefined,
): {
  kind: 'literal_prefix';
  pattern: string;
  confidence: 'high' | 'medium';
} | null {
  if (!names || names.length < 2) return null;

  const upper = names.map((n) => String(n).trim().toUpperCase());
  const lcp = longestCommonPrefix(upper);

  if (lcp.length < MIN_LCP_LENGTH) return null;
  if (STOP_PATTERNS.has(lcp.trim())) return null;

  const confidence = lcp.length >= 16 ? 'high' : 'medium';
  return { kind: 'literal_prefix', pattern: lcp, confidence };
}

function buildSqlRegexPattern({
  pattern,
  pattern_kind,
}: {
  pattern: string;
  pattern_kind: string;
}): string {
  switch (pattern_kind) {
    case 'literal_prefix': {
      const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return `^${escaped}`;
    }
    case 'glob': {
      const translated = pattern
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '.*')
        .replace(/\?/g, '.');
      return `^${translated}$`;
    }
    case 'regex':
    default:
      return pattern;
  }
}

// Cap the regex-preview scan: it pulls recipient rows into memory and filters
// in JS, so an unbounded SELECT could load the whole table for one preview.
const PREVIEW_REGEX_SCAN_CAP = 10_000;

/**
 * Preview how many recipients in the DB have a normalized_name or name
 * that the given pattern would match.
 *
 * Used to warn the user when a new pattern would collide with recipients
 * outside the intended merge set.
 */
export async function previewPatternMatches(patternRow: {
  pattern: string;
  pattern_kind: string;
  case_sensitive: boolean;
}): Promise<{ matchCount: number; recipientIds: number[]; truncated?: boolean }> {
  const validation = validatePattern(patternRow);
  if (!validation.valid) {
    throw new ValidationError(validation.error);
  }

  // Validate pattern compiles before hitting the DB.
  try {
    compilePattern({ id: 0, updated_at: '0', ...patternRow });
  } catch (err) {
    throw new ValidationError(`Pattern compilation failed: ${(err as Error).message}`);
  }

  // For `regex` patterns use JS matching (same engine as runtime) because
  // Postgres POSIX ERE (~) does not support JS tokens like \d, \b, lookaheads.
  // For literal_prefix/glob the patterns are safe POSIX ERE and Postgres is faster.
  if (patternRow.pattern_kind === 'regex') {
    const re = compilePattern({ id: 0, updated_at: '0', ...patternRow });
    const { rows } = await query<{ id: number; name: string | null }>(
      `SELECT id, name FROM recipients WHERE is_active = true ORDER BY id LIMIT $1`,
      [PREVIEW_REGEX_SCAN_CAP + 1],
    );
    const truncated = rows.length > PREVIEW_REGEX_SCAN_CAP;
    const scanned = truncated ? rows.slice(0, PREVIEW_REGEX_SCAN_CAP) : rows;
    const matched = scanned.filter((r) => re.test(String(r.name ?? '').toUpperCase()));
    return { matchCount: matched.length, recipientIds: matched.map((r) => r.id), truncated };
  }

  const sqlPattern = buildSqlRegexPattern(patternRow);
  const op = patternRow.case_sensitive ? '~' : '~*';

  const { rows } = await query<{ id: number }>(
    `SELECT id FROM recipients WHERE is_active = true AND UPPER(name) ${op} $1`,
    [sqlPattern],
  );

  return {
    matchCount: rows.length,
    recipientIds: rows.map((r) => r.id),
  };
}

/**
 * Persist a new pattern for a recipient.
 */
export async function createPattern(opts: {
  recipientId: number;
  pattern: string;
  pattern_kind?: string;
  case_sensitive?: boolean;
  priority?: number;
  source?: string;
  notes?: string;
}): Promise<{ id: number }> {
  // Validate the kind that is stored: an omitted kind used to be compiled as a
  // regex here while the row was saved as literal_prefix.
  const patternKind = opts.pattern_kind ?? 'literal_prefix';
  const validation = validatePattern({ ...opts, pattern_kind: patternKind });
  if (!validation.valid) throw new ValidationError(validation.error);

  const { rows } = await query<{ id: number }>(
    `INSERT INTO recipient_match_patterns
       (recipient_id, pattern, pattern_kind, case_sensitive, priority, source, notes)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id`,
    [
      opts.recipientId,
      opts.pattern,
      patternKind,
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
 */
export async function updatePattern(
  patternId: number,
  updates: {
    pattern?: string;
    pattern_kind?: string;
    case_sensitive?: boolean;
    priority?: number;
    is_active?: boolean;
    notes?: string;
  },
): Promise<void> {
  if (updates.pattern !== undefined || updates.pattern_kind !== undefined || updates.case_sensitive !== undefined) {
    // Validate the row MERGED with its stored values, not hardcoded fallbacks:
    // a partial PATCH like {case_sensitive:true} must keep the stored pattern
    // (else it fails "must not be empty"), and a pattern-only edit on a regex
    // row must still run the ReDoS guard against the stored kind.
    const { rows } = await query<
      Pick<RecipientMatchPatternRow, 'pattern' | 'pattern_kind' | 'case_sensitive'>
    >(
      `SELECT pattern, pattern_kind, case_sensitive FROM recipient_match_patterns WHERE id = $1`,
      [patternId],
    );
    if (!rows[0]) throw new NotFoundError(`Pattern ${patternId} not found`);
    const merged = {
      pattern: updates.pattern ?? rows[0].pattern,
      pattern_kind: updates.pattern_kind ?? rows[0].pattern_kind,
      case_sensitive: updates.case_sensitive ?? rows[0].case_sensitive,
    };
    const validation = validatePattern(merged);
    if (!validation.valid) throw new ValidationError(validation.error);
  }

  // Shared clause builder (lib/sqlClauses.ts); `allowed` keeps the writable-
  // column whitelist, undefined values are skipped (JSON bodies never carry any).
  const { clauses: fields, params: values, nextIdx: idx } = buildSetClauses(updates, {
    allowed: ['pattern', 'pattern_kind', 'case_sensitive', 'priority', 'is_active', 'notes'],
  });
  if (!fields.length) return;

  values.push(patternId);
  await query(
    `UPDATE recipient_match_patterns SET ${fields.join(', ')} WHERE id = $${idx}`,
    values,
  );
}

/**
 * Delete a pattern by id.
 */
export async function deletePattern(patternId: number): Promise<void> {
  await query(`DELETE FROM recipient_match_patterns WHERE id = $1`, [patternId]);
}

/**
 * List all patterns for a recipient.
 *
 * `recipient_id` is not selected.
 */
export async function listPatternsForRecipient(
  recipientId: number,
): Promise<Omit<RecipientMatchPatternRow, 'recipient_id'>[]> {
  const { rows } = await query<Omit<RecipientMatchPatternRow, 'recipient_id'>>(
    `SELECT id, pattern, pattern_kind, case_sensitive, priority, is_active, source, notes,
            created_at, updated_at
       FROM recipient_match_patterns
      WHERE recipient_id = $1
      ORDER BY priority ASC, id ASC`,
    [recipientId],
  );
  return rows;
}
