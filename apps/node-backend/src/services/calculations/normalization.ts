/**
 * Normalization — recipient name canonicalization + trigram fuzzy matching.
 *
 * Phase 6 of the non-portfolio refactor. Consolidates the existing
 * `textNormalization.js` normalize helpers and adds a single-query batch
 * matcher that scores candidate names against the existing recipients with
 * Vision's pg_trgm-compatible similarity() (ADR-263: SQLite has no trigram
 * index, so the fuzzy step compares each candidate with every recipient in
 * one statement) — replacing ad-hoc per-row similarity scans in import hot
 * paths.
 *
 * The DB-level UNIQUE constraint on `recipients.normalized_name` (migration
 * 0029) guarantees that an exact-normalized match returns at most one row.
 */
import { sql } from 'kysely';
import { db } from '../../database/db.ts';
import { float4Value } from '../../database/sqlite/text.ts';
import { normalizeForMatching } from '../../lib/textNormalization.ts';

export {
  normalizeForMatching,
};

export interface RecipientMatch {
  recipientId: number;
  normalizedName: string;
  similarity: number;
  exact: boolean;
}

/** One exact-or-fuzzy hit from the batch matcher SQL below. */
type RecipientMatchQueryRow = {
  norm: string;
  recipient_id: number;
  normalized_name: string;
  /** similarity() — a float4 value, as a number. */
  sim: number;
  is_exact: boolean;
};

/** Default pg_trgm similarity cutoff for "the same recipient, spelled differently". */
const DEFAULT_MATCH_THRESHOLD = 0.7;

/** pg_trgm.similarity_threshold's default: the floor of its `%` operator. */
const PG_TRGM_SIMILARITY_THRESHOLD = 0.3;

/**
 * Batch-resolve raw recipient names to existing recipient ids.
 *
 * For each input name:
 *   1. Normalize to canonical form (`normalizeForMatching`).
 *   2. Prefer an exact normalized match (unique constraint guarantees O(1)).
 *   3. Fall back to the highest-similarity recipient above `threshold` (and
 *      pg_trgm's `%` floor of 0.3) by trigram similarity().
 *
 * Returns a Map keyed on the ORIGINAL raw input name so callers can correlate
 * matches back to their source rows without a second normalization pass.
 */
export async function findBestRecipientMatches(
  names: Array<string | null | undefined>,
  { threshold = DEFAULT_MATCH_THRESHOLD }: { threshold?: number } = {},
): Promise<Map<string, RecipientMatch>> {
  const out = new Map<string, RecipientMatch>();
  if (!Array.isArray(names) || names.length === 0) return out;

  // Normalize once up-front; preserve the mapping raw -> normalized so we can
  // project results back onto the caller's original input strings.
  const normalizedByRaw = new Map<string, string>();
  for (const raw of names) {
    if (raw == null) continue;
    const norm = normalizeForMatching(raw);
    if (!norm) continue;
    normalizedByRaw.set(raw, norm);
  }
  if (normalizedByRaw.size === 0) return out;

  const uniqNorms = [...new Set(normalizedByRaw.values())];

  // Single-trip SQL:
  //   * `candidates` holds the deduped normalized inputs.
  //   * `exact_matches` picks the UNIQUE-guaranteed exact hit when present.
  //   * `fuzzy_matches` keeps recipients that pass pg_trgm's `%` (similarity
  //     >= pg_trgm.similarity_threshold, 0.3) and the caller's threshold,
  //     then a row_number() window (PostgreSQL's DISTINCT ON) keeps the best
  //     similarity per candidate, ties to the lowest recipient id.
  //   * The final UNION prefers exact over fuzzy via `is_exact` ranking.
  // similarity() returns a float4 (as the shortest decimal that reads back as
  // it, PostgreSQL's float4out); PostgreSQL compared it with the bound
  // threshold as float4, so the threshold takes the same float4 form.
  const result = await sql<RecipientMatchQueryRow>`
    WITH candidates AS (
      SELECT DISTINCT value AS norm FROM json_each(${JSON.stringify(uniqNorms)})
    ),
    exact_matches AS (
      SELECT c.norm,
             r.id  AS recipient_id,
             r.normalized_name,
             1.0 AS sim,
             1 AS is_exact
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
        ON r.normalized_name <> c.norm
      WHERE similarity(r.normalized_name, c.norm) >= ${PG_TRGM_SIMILARITY_THRESHOLD}
        AND similarity(r.normalized_name, c.norm) >= ${float4Value(threshold)}
    ),
    fuzzy_matches AS (
      SELECT norm, recipient_id, normalized_name, sim, 0 AS is_exact
      FROM (
        SELECT norm, recipient_id, normalized_name, sim,
               row_number() OVER (PARTITION BY norm ORDER BY sim DESC, recipient_id ASC) AS rn
        FROM fuzzy_candidates
      ) ranked
      WHERE rn = 1
    )
    SELECT norm, recipient_id, normalized_name, sim, is_exact AS "is_exact::bool"
    FROM exact_matches
    UNION ALL
    SELECT f.norm, f.recipient_id, f.normalized_name, f.sim, f.is_exact
    FROM fuzzy_matches f
    WHERE NOT EXISTS (SELECT 1 FROM exact_matches e WHERE e.norm = f.norm)
  `.execute(db);

  const byNorm = new Map<string, RecipientMatch>();
  for (const row of result.rows) {
    byNorm.set(row.norm, {
      recipientId: row.recipient_id,
      normalizedName: row.normalized_name,
      similarity: parseFloat(String(row.sim)),
      exact: row.is_exact,
    });
  }

  for (const [raw, norm] of normalizedByRaw) {
    const m = byNorm.get(norm);
    if (m) out.set(raw, m);
  }
  return out;
}
