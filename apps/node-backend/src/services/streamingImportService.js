/**
 * Streaming Import Service
 *
 * Processes CSV files using bank adapters and inserts transactions into the database.
 * Emits progress events via a callback.
 *
 * Performance optimisations applied:
 * - textNormalization is imported at module level (not re-imported per row).
 * - Per-row dedup: replaced existsByHash + separate create (2 round-trips) with
 *   repo.create() which uses INSERT ... ON CONFLICT DO NOTHING RETURNING * in a
 *   single round-trip. A null return means the row was a duplicate.
 * - getOrCreateRecipient: replaced SELECT + INSERT (2-4 round-trips) with a
 *   single INSERT ... ON CONFLICT (normalized_name) DO NOTHING RETURNING id,
 *   falling back to one SELECT only when the row already existed.
 * - Rows are processed in parallel batches (IMPORT_BATCH_SIZE) using Promise.all
 *   so multiple rows hit the DB concurrently instead of sequentially. Concurrency
 *   is capped to avoid overloading the connection pool.
 * - transaction + raw-reference inserts are pipelined per row without blocking
 *   the batch (rawReference creation is fire-and-forget after transaction insert).
 */

import fs from 'fs';
import { createAdapter } from './bankAdapters.js';
import { query } from '../database/connection.js';
import { logger } from '../config/logger.js';
import { normalizeForMatching } from './textNormalization.js';
import {
  computeHash,
  belfiusRawRepo,
  revolutRawRepo,
  kbcRawRepo,
  sabbRawRepo,
  wiseRawRepo,
  visionRawRepo,
  rawReferenceRepo,
  isRawDuplicate,
} from '../repositories/rawTransactionRepository.js';
import { isDuplicateByFields } from './deduplication.js';

// Number of rows processed concurrently within each import batch.
// Derived from pool ceiling so concurrent rows never exhaust connections.
// floor(poolMax / 2) ensures at least half the pool stays available for
// other requests; minimum of 2 keeps progress on very small pools.
// Read directly from process.env to avoid circular/mock issues at module init.
const _poolMax = Math.max(
  parseInt(process.env.DB_POOL_SIZE, 10) || 5,
  parseInt(process.env.DB_MAX_OVERFLOW, 10) || 10,
);
const IMPORT_BATCH_SIZE = Math.max(2, Math.floor(_poolMax / 2));

// ─── Utilities ───────────────────────────────────────────────────────────────

/**
 * Count lines in a file for progress calculation (fast, streams the file).
 */
async function countLines(filePath) {
  return new Promise((resolve, reject) => {
    let count = 0;
    const stream = fs.createReadStream(filePath, { encoding: 'utf-8' });
    stream.on('data', (chunk) => {
      for (let i = 0; i < chunk.length; i++) {
        if (chunk[i] === '\n') count++;
      }
    });
    stream.on('end', () => resolve(count + 1));
    stream.on('error', reject);
  });
}

/**
 * Determine bank type from bank name.
 */
function determineBankType(bankName) {
  const lower = bankName.toLowerCase().trim();
  if (lower.includes('belfius')) return 'belfius';
  if (lower.includes('revolut')) return 'revolut';
  if (lower.includes('kbc')) return 'kbc';
  if (lower.includes('sabb')) return 'sabb';
  if (lower.includes('wise')) return 'wise';
  if (lower.includes('vision')) return 'vision';
  return 'generic';
}

// ─── Recipient upsert ─────────────────────────────────────────────────────────

/**
 * Get or create a recipient in a single upsert round-trip.
 *
 * Uses INSERT ... ON CONFLICT (normalized_name) DO NOTHING RETURNING id.
 * If the row already existed (empty RETURNING), falls back to a single SELECT.
 * Total DB calls: 1 (new recipients) or 2 (existing recipients), down from 2-4.
 */
async function getOrCreateRecipient(name, accountNumber, address, bankName) {
  if (!name) name = 'UNKNOWN';
  const upperName = name.toUpperCase().trim();
  const normalizedName = normalizeForMatching(name);

  // Upsert recipient
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
    const selectResult = await query(
      `SELECT id FROM recipients WHERE normalized_name = $1`,
      [normalizedName]
    );
    if (!selectResult.rows.length) {
      throw new Error(`Recipient not found after conflict: ${normalizedName}`);
    }
    recipientId = selectResult.rows[0].id;
  }

  // Optionally link a bank account
  if (accountNumber) {
    await query(
      `INSERT INTO recipient_bank_accounts (recipient_id, account_number, bank_name, is_primary, is_active)
       VALUES ($1, $2, $3, false, true)
       ON CONFLICT DO NOTHING`,
      [recipientId, accountNumber, bankName || null]
    ).catch((err) => {
      logger.warn('Recipient bank account insert failed', { recipientId, accountNumber, error: err.message });
    });
  }

  // Optionally store address as notes
  if (address) {
    await query(
      `UPDATE recipients SET notes = $1 WHERE id = $2 AND (notes IS NULL OR notes = '')`,
      [address, recipientId]
    ).catch((err) => {
      logger.warn('Recipient notes update failed', { recipientId, error: err.message });
    });
  }

  return recipientId;
}

// ─── Single-row import ────────────────────────────────────────────────────────

/**
 * Process a single transaction row. Returns 'imported' | 'duplicate' | 'error'.
 */
async function processRow(txData, bankType) {
  try {
    if (bankType !== 'generic' && txData.rawData) {
      const dedupHash = computeHash(txData.rawData);

      // Single-round-trip insert with ON CONFLICT dedup.
      // Returns null if the hash already exists (duplicate).
      let rawTxn = null;
      try {
        if (bankType === 'belfius') rawTxn = await storeBelfiusRaw(txData, dedupHash);
        else if (bankType === 'revolut') rawTxn = await storeRevolutRaw(txData, dedupHash);
        else if (bankType === 'kbc') rawTxn = await storeKbcRaw(txData, dedupHash);
        else if (bankType === 'sabb') rawTxn = await storeSABBRaw(txData, dedupHash);
        else if (bankType === 'wise') rawTxn = await storeWiseRaw(txData, dedupHash);
        else if (bankType === 'vision') rawTxn = await storeVisionRaw(txData, dedupHash);
      } catch (rawErr) {
        logger.warn(`Raw storage failed: ${rawErr.message}`);
      }

      // null from create() means the hash already existed — duplicate row
      if (rawTxn === null) return 'duplicate';

      // Insert transaction and link raw reference
      const recipientId = await getOrCreateRecipient(
        txData.recipient, txData.recipientAccount, txData.recipientAddress, txData.recipientBankName
      );
      if (!(txData.date instanceof Date)) throw new Error(`Invalid date for transaction: ${txData.date}`);
      const dateStr = txData.date.toISOString().split('T')[0];
      const txResult = await query(
        `INSERT INTO transactions (date, bank_account, recipient_id, amount, memo, currency, balance, comment, is_active)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true)
         ON CONFLICT DO NOTHING
         RETURNING id`,
        [dateStr, txData.bankAccount, recipientId, txData.amount, txData.memo || '', txData.currency || null, txData.balance, txData.comment]
      );

      if (rawTxn && txResult.rows[0]) {
        rawReferenceRepo.create({
          transactionId: txResult.rows[0].id,
          rawSourceType: bankType,
          rawSourceId: rawTxn.id,
        }).catch((err) => {
          logger.warn('Raw reference creation failed', { txId: txResult.rows[0].id, error: err.message });
        });
      }

      return 'imported';
    }

    // Generic / legacy path — use field-based dedup
    if (!(txData.date instanceof Date)) throw new Error(`Invalid date for transaction: ${txData.date}`);
    const dateStr = txData.date.toISOString().split('T')[0];
    const isDup = await isRawDuplicate(bankType, txData.rawData).catch(async () => {
      return isDuplicateByFields(dateStr, txData.amount, txData.recipient, txData.memo);
    });

    if (isDup) return 'duplicate';

    const recipientId = await getOrCreateRecipient(
      txData.recipient, txData.recipientAccount, txData.recipientAddress, txData.recipientBankName
    );
    await query(
      `INSERT INTO transactions (date, bank_account, recipient_id, amount, memo, currency, balance, comment, is_active)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true)`,
      [dateStr, txData.bankAccount, recipientId, txData.amount, txData.memo || '', txData.currency || null, txData.balance, txData.comment]
    );
    return 'imported';
  } catch (err) {
    logger.warn(`Error processing transaction: ${err.message}`);
    return 'error';
  }
}

// ─── Main export ──────────────────────────────────────────────────────────────

/**
 * Import a CSV file with progress reporting.
 *
 * Rows are processed in parallel batches of IMPORT_BATCH_SIZE. Each batch
 * fires DB operations concurrently and waits for all to settle before moving
 * to the next batch (Promise.allSettled), so one bad row can't stall others.
 *
 * @param {string} filePath - Path to CSV file
 * @param {string} bankName - Bank adapter key
 * @param {Object|null} customConfig - Custom CSV config
 * @param {Function} [onProgress] - Callback: (progress) => void
 * @returns {Promise<Object>} Final results
 */
export async function importCSVStreaming(filePath, bankName, customConfig = null, onProgress = null) {
  const emitProgress = (data) => {
    if (onProgress) {
      try {
        onProgress(data);
      } catch (err) {
        logger.warn('onProgress callback failed', { error: err?.message });
      }
    }
  };

  try {
    emitProgress({ phase: 'counting', current: 0, total: 0, imported: 0, duplicates: 0, errors: 0, percent: 0 });
    const lineCount = await countLines(filePath);
    logger.info(`File has ~${lineCount} lines`);

    emitProgress({ phase: 'parsing', current: 0, total: lineCount, imported: 0, duplicates: 0, errors: 0, percent: 5 });
    const parser = createAdapter(bankName, customConfig);
    const transactionDataList = await parser(filePath);
    const bankType = determineBankType(bankName);
    const total = transactionDataList.length;

    logger.info(`Parsed ${total} transactions, bank type: ${bankType}`);
    emitProgress({ phase: 'importing', current: 0, total, imported: 0, duplicates: 0, errors: 0, percent: 10 });

    const results = { total_processed: total, imported: 0, duplicates: 0, errors: 0 };

    // Process in parallel batches
    for (let batchStart = 0; batchStart < total; batchStart += IMPORT_BATCH_SIZE) {
      const batchEnd = Math.min(batchStart + IMPORT_BATCH_SIZE, total);
      const batch = transactionDataList.slice(batchStart, batchEnd);

      // All rows in the batch run concurrently; use allSettled so one failure
      // doesn't short-circuit the rest.
      const settled = await Promise.allSettled(
        batch.map((txData) => processRow(txData, bankType))
      );

      for (const outcome of settled) {
        if (outcome.status === 'fulfilled') {
          if (outcome.value === 'imported') results.imported++;
          else if (outcome.value === 'duplicate') results.duplicates++;
          else results.errors++;
        } else {
          results.errors++;
        }
      }

      emitProgress({
        phase: 'importing',
        current: batchEnd,
        total,
        ...results,
        // eslint-disable-next-line vision-local-money/no-raw-money-arithmetic
        percent: Math.round(10 + (batchEnd / total) * 85),
      });
    }

    emitProgress({ phase: 'complete', current: total, total, ...results, percent: 100 });
    logger.info('Streaming CSV import completed', results);
    return results;
  } catch (err) {
    logger.error('Streaming CSV import failed', { error: err.message });
    const errorResult = {
      total_processed: 0, imported: 0, duplicates: 0, errors: 1,
      status: 'failed', error_message: err.message,
    };
    emitProgress({ phase: 'error', current: 0, total: 0, ...errorResult, percent: 0 });
    return errorResult;
  }
}

// ─── Raw storage helpers ──────────────────────────────────────────────────────

function parseRawCsvLine(rawLine, delimiter = ',') {
  if (!rawLine) return [];
  const fields = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < rawLine.length; i++) {
    const ch = rawLine[i];
    if (ch === '"') {
      if (inQuotes && rawLine[i + 1] === '"') { current += '"'; i++; }
      else inQuotes = !inQuotes;
    } else if (ch === delimiter && !inQuotes) {
      fields.push(current); current = '';
    } else {
      current += ch;
    }
  }
  fields.push(current);
  return fields;
}

function parseDecimal(value) {
  if (!value) return 0;
  let v = String(value).trim();
  if (v === '') return 0;
  let negative = false;
  if (v.startsWith('(') && v.endsWith(')')) { negative = true; v = v.slice(1, -1); }
  if (v.includes('.') && v.includes(',')) { v = v.replace(/\./g, '').replace(',', '.'); }
  else { v = v.replace(',', '.'); }
  v = v.replace(/\s/g, '');
  const n = parseFloat(v);
  if (isNaN(n)) return 0;
  return negative ? -n : n;
}

function parseDateStr(value, dateOnly = true) {
  if (!value) return null;
  const s = value.trim();
  const ddmmyyyy = s.match(/^(\d{2})\/(\d{2})\/(\d{4})/);
  if (ddmmyyyy) {
    const d = `${ddmmyyyy[3]}-${ddmmyyyy[2]}-${ddmmyyyy[1]}`;
    return dateOnly ? d : (s.length > 10 ? `${d} ${s.substring(11)}` : d);
  }
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return dateOnly ? s.substring(0, 10) : s;
  return null;
}

async function storeBelfiusRaw(txData, dedupHash) {
  const parsed = parseRawCsvLine(txData.rawData, ';');
  return belfiusRawRepo.create({
    deduplication_hash: dedupHash,
    account_number: (parsed[0] || '').trim(),
    transaction_date: parseDateStr((parsed[1] || '').trim()) || txData.date.toISOString().split('T')[0],
    statement_number: (parsed[2] || '').trim() || null,
    transaction_number: (parsed[3] || '').trim() || null,
    recipient_account: (parsed[4] || '').trim() || null,
    recipient_name: (parsed[5] || '').trim() || null,
    recipient_street: (parsed[6] || '').trim() || null,
    recipient_location: (parsed[7] || '').trim() || null,
    transaction_description: (parsed[8] || '').trim() || null,
    value_date: parseDateStr((parsed[9] || '').trim()) || null,
    amount: parsed[10] ? parseDecimal(parsed[10]) : txData.amount,
    currency: (parsed[11] || '').trim() || txData.currency || 'EUR',
    balance: txData.balance != null ? txData.balance : null,
    recipient_bic: (parsed[12] || '').trim() || null,
    recipient_country: (parsed[13] || '').trim() || null,
    additional_message: (parsed[14] || '').trim() || null,
    raw_csv_line: txData.rawData,
  });
}

async function storeRevolutRaw(txData, dedupHash) {
  const parsed = parseRawCsvLine(txData.rawData, ',');
  return revolutRawRepo.create({
    deduplication_hash: dedupHash,
    transaction_type: (parsed[0] || '').trim(),
    product: (parsed[1] || '').trim(),
    started_date: parseDateStr((parsed[2] || '').trim(), false) || null,
    completed_date: parseDateStr((parsed[3] || '').trim(), false) || txData.date.toISOString(),
    description: (parsed[4] || '').trim() || txData.recipient,
    amount: parsed[5] ? parseDecimal(parsed[5]) : txData.amount,
    fee: (parsed[6] || '').trim() || null,
    currency: (parsed[7] || '').trim() || txData.currency,
    state: (parsed[8] || '').trim() || 'COMPLETED',
    balance: parsed[9] ? parseDecimal(parsed[9]) : (txData.balance != null ? txData.balance : null),
    raw_csv_line: txData.rawData,
  });
}

async function storeKbcRaw(txData, dedupHash) {
  const parsed = parseRawCsvLine(txData.rawData, ';');
  return kbcRawRepo.create({
    deduplication_hash: dedupHash,
    account_number: (parsed[0] || '').trim(),
    category_name: (parsed[1] || '').trim() || null,
    account_holder_name: (parsed[2] || '').trim() || null,
    currency: (parsed[3] || '').trim() || txData.currency || 'EUR',
    statement_number: (parsed[4] || '').trim() || null,
    transaction_date: parseDateStr((parsed[5] || '').trim()) || txData.date.toISOString().split('T')[0],
    value_date: parseDateStr((parsed[7] || '').trim()) || null,
    description: (parsed[6] || '').trim() || null,
    amount: parsed[8] ? parseDecimal(parsed[8]) : txData.amount,
    balance: parsed[9] ? parseDecimal(parsed[9]) : (txData.balance != null ? txData.balance : null),
    credit_amount: parsed[10] ? parseDecimal(parsed[10]) : null,
    debit_amount: parsed[11] ? parseDecimal(parsed[11]) : null,
    counterparty_account: (parsed[12] || '').trim() || null,
    counterparty_bic: (parsed[13] || '').trim() || null,
    counterparty_name: (parsed[14] || '').trim() || null,
    counterparty_address: (parsed[15] || '').trim() || null,
    structured_communication: (parsed[16] || '').trim() || null,
    free_communication: (parsed[17] || '').trim() || null,
    raw_csv_line: txData.rawData,
  });
}

async function storeSABBRaw(txData, dedupHash) {
  const parts = (txData.rawData || '').split('|');
  return sabbRawRepo.create({
    deduplication_hash: dedupHash,
    transaction_date: txData.date.toISOString().split('T')[0],
    posting_date: parseDateStr((parts[1] || '').trim()) || null,
    description: (parts[2] || '').trim() || txData.memo || null,
    amount: txData.amount,
    currency: txData.currency || 'SAR',
    status: (parts[5] || '').trim() || null,
    amount_other_currency: (parts[4] || '').trim() || null,
    raw_csv_line: txData.rawData,
  });
}

async function storeWiseRaw(txData, dedupHash) {
  const parts = (txData.rawData || '').split('|');
  return wiseRawRepo.create({
    deduplication_hash: dedupHash,
    transfer_id: (parts[0] || '').trim() || null,
    status: (parts[1] || '').trim() || 'COMPLETED',
    direction: (parts[2] || '').trim() || null,
    finished_on: parseDateStr((parts[4] || '').trim(), false) || txData.date.toISOString(),
    source_name: (parts[5] || '').trim() || null,
    source_amount: parts[6] ? parseDecimal(parts[6]) : null,
    source_fee_amount: parts[7] ? parseDecimal(parts[7]) : null,
    source_fee_currency: (parts[8] || '').trim() || null,
    source_currency: (parts[9] || '').trim() || null,
    target_name: (parts[10] || '').trim() || null,
    target_amount: parts[11] ? parseDecimal(parts[11]) : txData.amount,
    target_currency: (parts[12] || '').trim() || txData.currency || null,
    exchange_rate: parts[13] ? parseDecimal(parts[13]) : null,
    reference: (parts[14] || '').trim() || null,
    batch: (parts[15] || '').trim() || null,
    raw_csv_line: txData.rawData,
  });
}

async function storeVisionRaw(txData, dedupHash) {
  const parts = (txData.rawData || '').split('|');
  return visionRawRepo.create({
    deduplication_hash: dedupHash,
    transaction_date: txData.date.toISOString().split('T')[0],
    bank_account: txData.bankAccount || (parts[2] || '').trim() || null,
    recipient: txData.recipient || (parts[3] || '').trim() || null,
    memo: txData.memo || (parts[4] || '').trim() || null,
    amount: txData.amount,
    currency: txData.currency || (parts[5] || '').trim() || 'EUR',
    balance: txData.balance != null ? txData.balance : null,
    category: (parts[7] || '').trim() || null,
    comment: txData.comment || (parts[8] || '').trim() || null,
    raw_csv_line: txData.rawData,
  });
}
