/**
 * Import pipeline — COMMIT
 *
 * Drains 'matched' staging rows into canonical `transactions`. Performs
 * per-row field-based dedup (date+amount+recipient+memo) against
 * `transactions`. Uses chunked BEGIN/COMMIT so partial failures roll back
 * cleanly on a chunk boundary without losing prior committed chunks.
 *
 * Post-chunk: updates `import_batches` counters (`rows_imported`,
 * `rows_duplicate`, `rows_error`).
 */

import { query, withTransaction } from '../../database/connection.js';
import { logger } from '../../config/logger.js';
import { refreshAggregations } from '../aggregationRefresh.js';
import { autoLinkTransactions } from '../plannedMatchService.js';

const COMMIT_CHUNK = 1000;

export async function commitBatch({ batchId, onProgress }) {
  await query(`UPDATE import_batches SET status = 'committing' WHERE id = $1`, [batchId]);

  const { rows: matched } = await query(
    `SELECT isr.id,
            isr.row_index,
            to_char(isr.tx_date, 'YYYY-MM-DD') AS tx_date,
            isr.bank_account,
            isr.recipient_raw,
            isr.memo,
            isr.amount,
            isr.currency,
            isr.balance,
            isr.comment,
            isr.tx_hash,
            isr.resolved_recipient_id,
            isr.user_override_recipient_id,
            isr.matched_pattern_id,
            isr.override_category_id,
            r.default_category_id AS recipient_default_category_id
       FROM import_staging_rows isr
       LEFT JOIN recipients r
         ON r.id = COALESCE(isr.user_override_recipient_id, isr.resolved_recipient_id)
      WHERE isr.batch_id = $1 AND isr.status = 'matched'
      ORDER BY isr.row_index ASC`,
    [batchId]
  );

  const total = matched.length;
  let seen = 0;
  let imported = 0;
  let duplicates = 0;
  let errors = 0;
  // tx_hashes already written to `transactions` by this run — guards against
  // two identical rows inside the same CSV both passing the field-based dup
  // check (neither is in `transactions` yet when the first is processed).
  const committedHashes = new Set();
  // Inserted rows fed to planned-payment auto-link after the whole batch
  // commits (so matching sees the full import — both ambiguity directions).
  const insertedRows = [];

  if (onProgress) onProgress({ phase: 'committing', current: 0, total });

  for (let start = 0; start < total; start += COMMIT_CHUNK) {
    const chunk = matched.slice(start, start + COMMIT_CHUNK);
    // Chunk-local counters: only folded into the running totals (and the
    // import_batches checkpoint) *after* withTransaction resolves, so a chunk
    // that rolls back doesn't leave the JS counters — and the persisted
    // checkpoint — inflated past what's actually in `transactions`.
    let chunkImported = 0;
    let chunkDuplicates = 0;
    let chunkErrors = 0;
    let chunkInserted = [];
    await withTransaction(async (client) => {
      // Reset inside the callback so a withTransaction retry recounts cleanly.
      chunkImported = 0;
      chunkDuplicates = 0;
      chunkErrors = 0;
      chunkInserted = [];
      for (const row of chunk) {
        // tx_date arrives as a 'YYYY-MM-DD' string (the SELECT uses to_char).
        // The Date branch is defensive only: node-postgres parses DATE columns
        // into a server-local-midnight Date, so use LOCAL getters — toISOString()
        // would roll back a day for any TZ east of UTC.
        const dateStr = row.tx_date instanceof Date
          ? `${row.tx_date.getFullYear()}-${String(row.tx_date.getMonth() + 1).padStart(2, '0')}-${String(row.tx_date.getDate()).padStart(2, '0')}`
          : String(row.tx_date).slice(0, 10);

        const effectiveRecipientId = row.user_override_recipient_id ?? row.resolved_recipient_id ?? null;

        // Intra-batch dedup: a row whose tx_hash was already committed by an
        // earlier row in this same run is a duplicate even though it is not
        // yet visible to the field-based check below.
        if (row.tx_hash && committedHashes.has(row.tx_hash)) {
          chunkDuplicates++;
          await client.query(
            `UPDATE import_staging_rows SET status = 'duplicate' WHERE id = $1`,
            [row.id]
          );
          continue;
        }

        // Field-based duplicate check against canonical transactions.
        // Includes memo so two legitimate same-day same-amount same-recipient
        // purchases (e.g. two coffees) are not falsely deduped — but memo does
        // NOT discriminate card payments (Revolut stamps the identical
        // "CARD_PAYMENT - CURRENT" on every one), so two more guards:
        //  - same account only (bank_account): an identical purchase on a
        //    DIFFERENT account is a distinct transaction, not a duplicate;
        //  - when both rows carry a tx_hash and the hashes DIFFER, the hash is
        //    the identity and the rows are distinct (two same-day card
        //    payments differ by running balance → different hash). Equal
        //    hashes never reach here (intra-batch set + ON CONFLICT below).
        //    Without this, the second of two identical same-batch card
        //    payments field-matched the first inside the same DB transaction
        //    and a REAL transaction was silently dropped.
        const memoNorm = (row.memo ?? '').trim();
        const dupCheck = await client.query(
          `SELECT t.id
             FROM transactions t
            WHERE t.date = $1
              AND t.amount = $2
              AND (
                ($3::integer IS NOT NULL AND t.recipient_id = $3)
                OR ($3::integer IS NULL AND t.recipient_id IS NULL)
              )
              AND COALESCE(TRIM(t.memo), '') = $4
              AND t.bank_account IS NOT DISTINCT FROM $5
              AND NOT (t.tx_hash IS NOT NULL AND $6::text IS NOT NULL AND t.tx_hash <> $6)
              AND t.is_active = true
            LIMIT 1`,
          [dateStr, row.amount, effectiveRecipientId, memoNorm, row.bank_account || null, row.tx_hash || null]
        );

        if (dupCheck.rows.length > 0) {
          chunkDuplicates++;
          await client.query(
            `UPDATE import_staging_rows SET status = 'duplicate' WHERE id = $1`,
            [row.id]
          );
          continue;
        }

        // SAVEPOINT per row: if insert fails the txn stays usable for remaining rows.
        // import_staging_rows.id is BIGSERIAL — the pg driver returns BIGINT
        // values as strings to preserve int64 precision, so the value here is
        // a string of digits (or, defensively, a JS integer). Validate against
        // a digits-only regex to keep the interpolated savepoint identifier
        // safe from injection without falsely rejecting string-form bigints.
        const idStr = String(row.id);
        if (!/^\d+$/.test(idStr)) {
          chunkErrors++;
          continue;
        }
        const sp = `sp_row_${idStr}`;
        await client.query(`SAVEPOINT ${sp}`);
        try {
          // When overridden, clear matched_pattern_id — the link is now manual.
          const effectivePatternId = row.user_override_recipient_id ? null : (row.matched_pattern_id ?? null);

          // ADR-046: per-row override beats recipient default. Both may be null
          // (truly uncategorized), in which case the runtime COALESCE in
          // transactionRepository falls back to the recipient default at read.
          const effectiveCategoryId =
            row.override_category_id ?? row.recipient_default_category_id ?? null;

          // ON CONFLICT on the partial unique index over tx_hash makes the
          // insert race-safe — a concurrent import that slipped past the
          // field-based check above can't double-insert.
          const insertResult = await client.query(
            `INSERT INTO transactions
                (date, bank_account, recipient_id, category_id, amount, memo, currency, balance, comment,
                 import_batch_id, matched_pattern_id, tx_hash, is_active)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, true)
             ON CONFLICT (tx_hash) WHERE tx_hash IS NOT NULL DO NOTHING
             RETURNING id`,
            [
              dateStr,
              row.bank_account || null,
              effectiveRecipientId,
              effectiveCategoryId,
              row.amount,
              row.memo || '',
              // currency is NOT NULL at the DB level (migration 0046); default
              // a missing import currency to EUR rather than writing NULL.
              row.currency || 'EUR',
              row.balance != null ? row.balance : null,
              row.comment || null,
              batchId,
              effectivePatternId,
              row.tx_hash || null,
            ]
          );

          if (insertResult.rows.length === 0) {
            // tx_hash conflict — another row/import already has this hash.
            chunkDuplicates++;
            await client.query(
              `UPDATE import_staging_rows SET status = 'duplicate' WHERE id = $1`,
              [row.id]
            );
            await client.query(`RELEASE SAVEPOINT ${sp}`);
            continue;
          }

          chunkImported++;
          chunkInserted.push({
            id: insertResult.rows[0].id,
            recipient_id: effectiveRecipientId,
            amount: row.amount,
            transaction_date: dateStr,
          });
          if (row.tx_hash) committedHashes.add(row.tx_hash);
          await client.query(
            `UPDATE import_staging_rows SET status = 'committed' WHERE id = $1`,
            [row.id]
          );
          await client.query(`RELEASE SAVEPOINT ${sp}`);
        } catch (err) {
          await client.query(`ROLLBACK TO SAVEPOINT ${sp}`);
          chunkErrors++;
          await client.query(
            `UPDATE import_staging_rows SET status = 'error', error_message = $2 WHERE id = $1`,
            [row.id, err?.message?.slice(0, 500) || 'insert failed']
          );
        }
      }
    });

    // Transaction committed — only now is it safe to fold the chunk's counts
    // into the running totals and the persisted checkpoint.
    imported += chunkImported;
    duplicates += chunkDuplicates;
    errors += chunkErrors;
    insertedRows.push(...chunkInserted);
    seen += chunk.length;

    // Checkpoint counters per chunk so a crash mid-import leaves recoverable
    // state in import_batches. Increment by chunk-local delta to preserve
    // any rows_error already set by earlier pipeline phases (validate).
    await query(
      `UPDATE import_batches
          SET rows_imported = COALESCE(rows_imported, 0) + $2,
              rows_duplicate = COALESCE(rows_duplicate, 0) + $3,
              rows_error = COALESCE(rows_error, 0) + $4
        WHERE id = $1`,
      [batchId, chunkImported, chunkDuplicates, chunkErrors]
    );

    if (onProgress) {
      onProgress({ phase: 'committing', current: seen, total, imported, duplicates, errors });
    }
  }

  logger.info('[pipeline:commit] done', { batchId, total, imported, duplicates, errors });

  if (imported > 0) {
    try {
      await refreshAggregations();
    } catch (err) {
      logger.warn('[pipeline:commit] post-import aggregation refresh failed', {
        batchId,
        error: err?.message,
      });
    }
  }

  // Auto-clear matching planned payments for the just-imported transactions.
  // Runs after commit (rows are durable) and never fails the import.
  let autoLinkedCount = 0;
  if (insertedRows.length > 0) {
    try {
      const auto = await autoLinkTransactions(insertedRows);
      autoLinkedCount = auto.autoLinkedCount;
      if (autoLinkedCount > 0) {
        logger.info('[pipeline:commit] auto-linked planned payments', { batchId, autoLinkedCount });
      }
    } catch (err) {
      logger.warn('[pipeline:commit] planned auto-link failed', { batchId, error: err?.message });
    }
  }

  return { imported, duplicates, errors, autoLinkedCount };
}
