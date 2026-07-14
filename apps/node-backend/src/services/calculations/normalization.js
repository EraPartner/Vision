/**
 * Normalization — recipient name canonicalization + pg_trgm-backed fuzzy matching.
 *
 * Phase 6 of the non-portfolio refactor. Consolidates the existing
 * `textNormalization.js` normalize helpers and adds a Postgres-backed batch
 * matcher that uses the `pg_trgm` GIN index (installed in migration 0026) to
 * find the best existing recipient for a set of candidate names in O(log N)
 * per lookup — replacing ad-hoc per-row similarity scans in import hot paths.
 *
 * The DB-level UNIQUE constraint on `recipients.normalized_name` (migration
 * 0029) guarantees that an exact-normalized match returns at most one row.
 */
import { query } from '../../database/connection.js';
import {
  cleanRecipientName,
  cleanKbcRecipientName,
  normalizeToUppercase,
  normalizeForMatching,
} from '../textNormalization.js';

export {
  cleanRecipientName,
  cleanKbcRecipientName,
  normalizeToUppercase,
  normalizeForMatching,
};

/** Default pg_trgm similarity cutoff for "the same recipient, spelled differently". */
export const DEFAULT_MATCH_THRESHOLD = 0.7;

/**
 * Batch-resolve raw recipient names to existing recipient ids.
 *
 * For each input name:
 *   1. Normalize to canonical form (`normalizeForMatching`).
 *   2. Prefer an exact normalized match (unique constraint guarantees O(1)).
 *   3. Fall back to the highest-similarity recipient above `threshold` via
 *      the pg_trgm `%` operator (uses the GIN index).
 *
 * Returns a Map keyed on the ORIGINAL raw input name so callers can correlate
 * matches back to their source rows without a second normalization pass.
 *
 * @param {string[]} names
 * @param {{ threshold?: number }} [opts]
 * @returns {Promise<Map<string, { recipientId: number, normalizedName: string, similarity: number, exact: boolean }>>}
 */
export async function findBestRecipientMatches(names, { threshold = DEFAULT_MATCH_THRESHOLD } = {}) {
  const out = new Map();
  if (!Array.isArray(names) || !names.length) return out;

  // Normalize once up-front; preserve the mapping raw -> normalized so we can
  // project results back onto the caller's original input strings.
  const normalizedByRaw = new Map();
  for (const raw of names) {
    if (raw == null) continue;
    const norm = normalizeForMatching(String(raw));
    if (!norm) continue;
    normalizedByRaw.set(raw, norm);
  }
  if (!normalizedByRaw.size) return out;

  const uniqNorms = [...new Set(normalizedByRaw.values())];

  // Single-trip SQL:
  //   * `candidates` holds the deduped normalized inputs.
  //   * `exact_matches` picks the UNIQUE-guaranteed exact hit when present.
  //   * `fuzzy_matches` uses pg_trgm `%` (GIN-backed) then DISTINCT ON keeps
  //     the best similarity per candidate above the threshold.
  //   * The final UNION prefers exact over fuzzy via `is_exact` ranking.
  const sql = `
    WITH candidates AS (
      SELECT DISTINCT norm FROM unnest($1::text[]) AS t(norm)
    ),
    exact_matches AS (
      SELECT c.norm,
             r.id  AS recipient_id,
             r.normalized_name,
             1.0::real AS sim,
             true AS is_exact
      FROM candidates c
      JOIN recipients r ON r.normalized_name = c.norm
    ),
    fuzzy_candidates AS (
      SELECT c.norm,
             r.id AS recipient_id,
             r.normalized_name,
             similarity(r.normalized_name, c.norm) AS sim
      FROM candidates c
      JOIN recipients r
        ON r.normalized_name % c.norm
       AND r.normalized_name <> c.norm
      WHERE similarity(r.normalized_name, c.norm) >= $2
    ),
    fuzzy_matches AS (
      SELECT DISTINCT ON (norm) norm, recipient_id, normalized_name, sim, false AS is_exact
      FROM fuzzy_candidates
      ORDER BY norm, sim DESC, recipient_id ASC
    )
    SELECT * FROM exact_matches
    UNION ALL
    SELECT f.* FROM fuzzy_matches f
    WHERE NOT EXISTS (SELECT 1 FROM exact_matches e WHERE e.norm = f.norm)
  `;

  const result = await query(sql, [uniqNorms, threshold]);

  const byNorm = new Map();
  for (const row of result.rows) {
    byNorm.set(row.norm, {
      recipientId: row.recipient_id,
      normalizedName: row.normalized_name,
      similarity: parseFloat(row.sim),
      exact: !!row.is_exact,
    });
  }

  for (const [raw, norm] of normalizedByRaw) {
    const m = byNorm.get(norm);
    if (m) out.set(raw, m);
  }
  return out;
}

