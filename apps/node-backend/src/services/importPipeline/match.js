/**
 * Import pipeline — MATCH
 *
 * Resolves each validated staging row's `recipient_raw` to a canonical
 * recipient id in three ordered phases:
 *
 *   1. Pattern   — literal_prefix / glob / regex rules owned by the user.
 *                  Fastest signal; first match wins.
 *   2. Exact/Fuzzy — pg_trgm via `findBestRecipientMatches`.
 *                  Exact normalized hit preferred; fuzzy fallback above 0.7.
 *   3. New        — names not resolved by either phase are upserted as new
 *                  recipients.
 *
 * Every staging row is stamped with `match_source`, `match_similarity`,
 * and `matched_pattern_id` so the review UI can surface exactly how each
 * row was resolved.
 */

import { query, withTransaction } from '../../database/connection.js';
import { logger } from '../../config/logger.js';
import {
  findBestRecipientMatches,
  normalizeForMatching,
} from '../calculations/normalization.js';
import { loadActivePatterns, applyPatterns } from '../recipientPatternService.js';

const MATCH_UPDATE_CHUNK = 500;

export async function matchBatch({ batchId, onProgress }) {
  await query(`UPDATE import_batches SET status = 'matching' WHERE id = $1`, [batchId]);

  const { rows: staged } = await query(
    `SELECT id, recipient_raw
       FROM import_staging_rows
      WHERE batch_id = $1 AND status = 'validated'
      ORDER BY row_index ASC`,
    [batchId]
  );

  const total = staged.length;
  if (onProgress) onProgress({ phase: 'matching', current: 0, total });

  const distinctRaw = [
    ...new Set(staged.map((r) => r.recipient_raw).filter((n) => n && String(n).trim().length)),
  ];

  // --- Phase 1: pattern match ---
  const patternRows = await loadActivePatterns();
  const patternMatches = await applyPatterns(distinctRaw, patternRows);

  // --- Phase 2: fuzzy/exact for rows not resolved by patterns ---
  const unpatternedRaw = distinctRaw.filter((n) => !patternMatches.has(n));
  const fuzzyMatches = await findBestRecipientMatches(unpatternedRaw);

  // --- Build resolved map: raw → resolution info ---
  /** @type {Map<string, { recipientId: number, matchSource: string, matchSimilarity: number|null, matchedPatternId: number|null }>} */
  const resolved = new Map();

  for (const [raw, { recipientId, patternId }] of patternMatches) {
    resolved.set(raw, {
      recipientId,
      matchSource: 'pattern',
      matchSimilarity: null,
      matchedPatternId: patternId,
    });
  }

  for (const [raw, m] of fuzzyMatches) {
    resolved.set(raw, {
      recipientId: m.recipientId,
      matchSource: m.exact ? 'exact' : 'fuzzy',
      matchSimilarity: m.exact ? null : m.similarity,
      matchedPatternId: null,
    });
  }

  // --- Phase 3: upsert new recipients for unresolved names ---
  const unmatched = distinctRaw.filter((n) => !resolved.has(n));
  for (const raw of unmatched) {
    const upperName = String(raw).toUpperCase().trim();
    const normalized = normalizeForMatching(String(raw));
    if (!normalized) continue;

    const upsert = await query(
      `INSERT INTO recipients (name, normalized_name, is_active)
       VALUES ($1, $2, true)
       ON CONFLICT (normalized_name) DO NOTHING
       RETURNING id`,
      [upperName, normalized]
    );

    let id;
    if (upsert.rows.length) {
      id = upsert.rows[0].id;
    } else {
      const existing = await query(
        `SELECT id FROM recipients WHERE normalized_name = $1 LIMIT 1`,
        [normalized]
      );
      if (!existing.rows.length) continue;
      id = existing.rows[0].id;
    }
    resolved.set(raw, { recipientId: id, matchSource: 'new', matchSimilarity: null, matchedPatternId: null });
  }

  // --- Chunked UPDATE of staging rows ---
  let matched = 0;
  let unresolved = 0;
  let seen = 0;

  for (let start = 0; start < staged.length; start += MATCH_UPDATE_CHUNK) {
    const chunk = staged.slice(start, start + MATCH_UPDATE_CHUNK);
    await withTransaction(async (client) => {
      for (const row of chunk) {
        const info = row.recipient_raw ? resolved.get(row.recipient_raw) : null;
        if (info) {
          matched++;
          await client.query(
            `UPDATE import_staging_rows
                SET status             = 'matched',
                    resolved_recipient_id = $2,
                    match_source       = $3,
                    match_similarity   = $4,
                    matched_pattern_id = $5
              WHERE id = $1`,
            [row.id, info.recipientId, info.matchSource, info.matchSimilarity, info.matchedPatternId]
          );
        } else {
          unresolved++;
          await client.query(
            `UPDATE import_staging_rows
                SET status             = 'matched',
                    resolved_recipient_id = NULL,
                    match_source       = NULL,
                    match_similarity   = NULL,
                    matched_pattern_id = NULL
              WHERE id = $1`,
            [row.id]
          );
        }
      }
    });
    seen += chunk.length;
    if (onProgress) onProgress({ phase: 'matching', current: seen, total });
  }

  const matchSourceCounts = { pattern: 0, exact: 0, fuzzy: 0, new: 0 };
  for (const info of resolved.values()) matchSourceCounts[info.matchSource] = (matchSourceCounts[info.matchSource] || 0) + 1;

  logger.info('[pipeline:match] done', { batchId, total, matched, unresolved, ...matchSourceCounts });
  return { matched, unresolved, matchSourceCounts };
}
