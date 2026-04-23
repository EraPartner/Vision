/**
 * Transaction Import Service
 * Mirrors: apps/backend/services/transaction_import_service.py
 *
 * Orchestrates CSV import: parsing, deduplication, recipient creation, persistence.
 *
 * Performance optimisations applied:
 * - textNormalization is imported at module level (not re-imported per call).
 * - getOrCreateRecipient uses INSERT ... ON CONFLICT (normalized_name) DO NOTHING,
 *   reducing the old SELECT + INSERT pattern (2-4 round-trips) to 1-2 round-trips.
 * - Phase 1 (dedup + recipient resolution) runs in parallel batches instead of
 *   sequentially, capped by RESOLVE_CONCURRENCY to avoid DB pool exhaustion.
 * - Batch insert size increased to 250 rows (from 100) for better throughput.
 */

import { createAdapter } from './bankAdapters.js';
import { isDuplicateByFields } from './deduplication.js';
import { query } from '../database/connection.js';
import { logger } from '../config/logger.js';
import { normalizeForMatching } from './textNormalization.js';

// Number of rows to resolve (dedup + recipient) concurrently in phase 1.
// Derived from pool ceiling so we never exhaust connections.
// floor(poolMax / 2) ensures at least half the pool stays available for
// other requests; minimum of 2 keeps progress on very small pools.
// Read directly from process.env to avoid circular/mock issues at module init.
const _poolMax = Math.max(
  parseInt(process.env.DB_POOL_SIZE, 10) || 5,
  parseInt(process.env.DB_MAX_OVERFLOW, 10) || 10,
);
const RESOLVE_CONCURRENCY = Math.max(2, Math.floor(_poolMax / 2));

// Rows per INSERT statement in phase 2; larger = fewer round-trips.
const BATCH_SIZE = 250;

/**
 * Import transactions from a parsed CSV file.
 *
 * @param {string} filePath - Path to the temporary CSV file
 * @param {string} bankName - Bank adapter key
 * @param {Object|null} customConfig - Custom CSV configuration (optional)
 * @returns {Promise<Object>} Import results
 */
export async function importCSV(filePath, bankName, customConfig = null) {
  logger.info('Starting CSV import', { bankName, hasCustomConfig: !!customConfig });

  try {
    const parser = createAdapter(bankName, customConfig);
    const transactionDataList = parser(filePath);

    logger.info(`Parsed ${transactionDataList.length} transactions from CSV`);

    const results = {
      total_processed: transactionDataList.length,
      imported: 0,
      duplicates: 0,
      errors: 0,
    };

    // Phase 1: dedup + recipient resolution in parallel batches.
    // We process RESOLVE_CONCURRENCY rows at a time via Promise.allSettled so one
    // bad row doesn't abort the whole batch. pendingInserts preserves insertion order.
    const pendingInserts = [];

    for (let i = 0; i < transactionDataList.length; i += RESOLVE_CONCURRENCY) {
      const batch = transactionDataList.slice(i, i + RESOLVE_CONCURRENCY);

      const settled = await Promise.allSettled(
        batch.map(async (txData) => {
          const dateStr = txData.date.toISOString().split('T')[0];
          const dup = await isDuplicateByFields(dateStr, txData.amount, txData.recipient, txData.memo);
          if (dup) return { dup: true };

          const recipientId = await getOrCreateRecipient(
            txData.recipient,
            txData.recipientAccount,
            txData.recipientAddress,
            txData.recipientBankName
          );

          return {
            dup: false,
            row: [
              dateStr,
              txData.bankAccount,
              recipientId,
              txData.amount,
              txData.memo || '',
              txData.currency || null,
              txData.balance,
              txData.comment,
            ],
          };
        })
      );

      for (const outcome of settled) {
        if (outcome.status === 'rejected') {
          logger.warn(`Error processing transaction: ${outcome.reason?.message}`);
          results.errors++;
        } else if (outcome.value.dup) {
          results.duplicates++;
        } else {
          pendingInserts.push(outcome.value.row);
        }
      }
    }

    // Phase 2: batch insert resolved transactions (BATCH_SIZE rows per statement).
    for (let i = 0; i < pendingInserts.length; i += BATCH_SIZE) {
      const chunk = pendingInserts.slice(i, i + BATCH_SIZE);
      try {
        const placeholders = chunk.map((_, j) => {
          const b = j * 8;
          return `($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7},$${b + 8},true)`;
        }).join(',');
        await query(
          `INSERT INTO transactions (date,bank_account,recipient_id,amount,memo,currency,balance,comment,is_active)
           VALUES ${placeholders}
           ON CONFLICT DO NOTHING`,
          chunk.flat()
        );
        results.imported += chunk.length;
      } catch (err) {
        logger.warn(`Batch insert failed: ${err.message}`);
        results.errors += chunk.length;
      }
    }

    logger.info('CSV import completed', results);
    return results;
  } catch (err) {
    logger.error('CSV import failed', { error: err.message });
    return {
      total_processed: 0,
      imported: 0,
      duplicates: 0,
      errors: 1,
      status: 'failed',
      error_message: err.message,
    };
  }
}

/**
 * Get or create a recipient by name using a single upsert round-trip.
 *
 * INSERT ... ON CONFLICT (normalized_name) DO NOTHING RETURNING id:
 *  - New recipients: single INSERT → id returned (1 round-trip).
 *  - Existing recipients: conflict → empty RETURNING → one SELECT fallback (2 round-trips).
 */
async function getOrCreateRecipient(name, accountNumber, address, bankName) {
  if (!name) name = 'UNKNOWN';
  const upperName = name.toUpperCase().trim();
  const normalizedName = normalizeForMatching(name);

  const insertResult = await query(
    `INSERT INTO recipients (name, normalized_name, is_active)
     VALUES ($1, $2, true)
     ON CONFLICT (normalized_name) DO NOTHING
     RETURNING id`,
    [upperName, normalizedName]
  );

  let recipientId;
  if (insertResult.rows.length > 0) {
    recipientId = insertResult.rows[0].id;
  } else {
    const existingResult = await query(
      `SELECT id FROM recipients WHERE normalized_name = $1`,
      [normalizedName]
    );
    if (!existingResult.rows.length) {
      throw new Error(`Recipient not found after conflict: ${normalizedName}`);
    }
    recipientId = existingResult.rows[0].id;
  }

  // Link bank account (fire-and-forget on conflict, non-critical)
  if (accountNumber) {
    query(
      `INSERT INTO recipient_bank_accounts (recipient_id, account_number, bank_name, is_primary, is_active)
       VALUES ($1, $2, $3, false, true)
       ON CONFLICT DO NOTHING`,
      [recipientId, accountNumber, bankName || null]
    ).catch(() => {});
  }

  // Store address as notes (fire-and-forget, only when not yet set)
  if (address) {
    query(
      `UPDATE recipients SET notes = $1 WHERE id = $2 AND (notes IS NULL OR notes = '')`,
      [address, recipientId]
    ).catch(() => {});
  }

  return recipientId;
}
