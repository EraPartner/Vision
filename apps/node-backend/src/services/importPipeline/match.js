/**
 * Import pipeline — MATCH
 *
 * Reads validated staging rows, batch-resolves `recipient_raw` to recipient
 * ids using pg_trgm via `findBestRecipientMatches`, and upserts unmatched
 * names into the canonical `recipients` table. Writes the resolved id back
 * onto the staging row and marks it 'matched'.
 */

import { query, withTransaction } from '../../database/connection.js';
import { logger } from '../../config/logger.js';
import {
  findBestRecipientMatches,
  normalizeForMatching,
} from '../calculations/normalization.js';

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

  // Collect distinct non-null raw names.
  const distinctRaw = [...new Set(staged.map((r) => r.recipient_raw).filter((n) => n && String(n).trim().length))];

  // 1. Batch fuzzy/exact match against existing recipients.
  const matches = await findBestRecipientMatches(distinctRaw);

  // 2. Upsert the un-matched names so every distinct recipient_raw resolves to an id.
  const resolved = new Map(); // raw -> recipientId
  for (const [raw, m] of matches) resolved.set(raw, m.recipientId);

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
    resolved.set(raw, id);
  }

  // 3. Chunked UPDATE of staging rows.
  let matched = 0;
  let unresolved = 0;
  let seen = 0;

  for (let start = 0; start < staged.length; start += MATCH_UPDATE_CHUNK) {
    const chunk = staged.slice(start, start + MATCH_UPDATE_CHUNK);
    await withTransaction(async (client) => {
      for (const row of chunk) {
        const recipientId = row.recipient_raw ? resolved.get(row.recipient_raw) : null;
        if (recipientId) {
          matched++;
          await client.query(
            `UPDATE import_staging_rows
                SET status = 'matched', resolved_recipient_id = $2
              WHERE id = $1`,
            [row.id, recipientId]
          );
        } else {
          // No recipient (blank raw name) — still advance to 'matched' so commit sees it.
          unresolved++;
          await client.query(
            `UPDATE import_staging_rows
                SET status = 'matched', resolved_recipient_id = NULL
              WHERE id = $1`,
            [row.id]
          );
        }
      }
    });
    seen += chunk.length;
    if (onProgress) onProgress({ phase: 'matching', current: seen, total });
  }

  logger.info('[pipeline:match] done', { batchId, total, matched, unresolved });
  return { matched, unresolved };
}
