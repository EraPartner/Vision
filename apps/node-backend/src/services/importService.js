/**
 * Transaction Import Service
 * Mirrors: apps/backend/services/transaction_import_service.py
 *
 * Orchestrates CSV import: parsing, deduplication, recipient creation, persistence.
 */

import { createAdapter } from './bankAdapters.js';
import { isDuplicateByFields } from './deduplication.js';
import { query } from '../database/connection.js';
import { logger } from '../config/logger.js';

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

    // Phase 1: dedup + recipient resolution (sequential, order matters)
    const pendingInserts = [];
    for (const txData of transactionDataList) {
      try {
        const dateStr = txData.date.toISOString().split('T')[0];
        const dup = await isDuplicateByFields(dateStr, txData.amount, txData.recipient, txData.memo);
        if (dup) {
          results.duplicates++;
          continue;
        }

        const recipientId = await getOrCreateRecipient(
          txData.recipient,
          txData.recipientAccount,
          txData.recipientAddress,
          txData.recipientBankName
        );

        pendingInserts.push([
          dateStr,
          txData.bankAccount,
          recipientId,
          txData.amount,
          txData.memo || '',
          txData.currency || null,
          txData.balance,
          txData.comment,
        ]);
      } catch (err) {
        logger.warn(`Error processing transaction: ${err.message}`);
        results.errors++;
      }
    }

    // Phase 2: batch insert resolved transactions (100 rows per statement)
    const BATCH_SIZE = 100;
    for (let i = 0; i < pendingInserts.length; i += BATCH_SIZE) {
      const chunk = pendingInserts.slice(i, i + BATCH_SIZE);
      try {
        const placeholders = chunk.map((_, j) => {
          const b = j * 8;
          return `($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7},$${b + 8},true)`;
        }).join(',');
        await query(
          `INSERT INTO transactions (date,bank_account,recipient_id,amount,memo,currency,balance,comment,is_active) VALUES ${placeholders}`,
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
 * Get or create a recipient by name.
 */
async function getOrCreateRecipient(name, accountNumber, address, bankName) {
  if (!name) name = 'UNKNOWN';
  const { normalizeForMatching } = await import('./textNormalization.js');
  const upperName = name.toUpperCase().trim();
  const normalizedName = normalizeForMatching(name);

  // Try find existing
  const existing = await query(
    `SELECT id FROM recipients WHERE normalized_name = $1 LIMIT 1`,
    [normalizedName]
  );

  if (existing.rows.length > 0) {
    const recipientId = existing.rows[0].id;

    // Update bank account if provided and not yet stored
    if (accountNumber) {
      const bankAcctExists = await query(
        `SELECT id FROM recipient_bank_accounts WHERE recipient_id = $1 AND account_number = $2 LIMIT 1`,
        [recipientId, accountNumber]
      );
      if (bankAcctExists.rows.length === 0) {
        await query(
          `INSERT INTO recipient_bank_accounts (recipient_id, account_number, bank_name, is_primary, is_active)
           VALUES ($1, $2, $3, false, true)
           ON CONFLICT DO NOTHING`,
          [recipientId, accountNumber, bankName || null]
        ).catch(() => {/* ignore if table doesn't exist */ });
      }
    }

    return recipientId;
  }

  // Create new recipient
  const result = await query(
    `INSERT INTO recipients (name, normalized_name, is_active) VALUES ($1, $2, true) RETURNING id`,
    [upperName, normalizedName]
  );
  const newId = result.rows[0].id;

  // Store bank account if provided
  if (accountNumber) {
    await query(
      `INSERT INTO recipient_bank_accounts (recipient_id, account_number, bank_name, is_primary, is_active)
       VALUES ($1, $2, $3, true, true)
       ON CONFLICT DO NOTHING`,
      [newId, accountNumber, bankName || null]
    ).catch(() => {/* ignore if table doesn't exist */ });
  }

  // Store address if provided
  if (address) {
    await query(
      `UPDATE recipients SET notes = $1 WHERE id = $2`,
      [address, newId]
    ).catch(() => { });
  }

  return newId;
}
