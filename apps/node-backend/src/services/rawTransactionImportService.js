/**
 * Raw Transaction Import Service
 * Mirrors: apps/backend/services/raw_transaction_import_service.py
 *
 * Orchestrates CSV import with raw data preservation:
 * 1. Parse CSV via bank adapters
 * 2. Store raw data in bank-specific tables (with hash dedup)
 * 3. Create normalized Transaction records linked to raw data
 * 4. Maintain audit trail and referential integrity
 */

import { createAdapter } from './bankAdapters.js';
import { query } from '../database/connection.js';
import { logger } from '../config/logger.js';
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
import {
  normalizeForMatching,
  findBestRecipientMatch,
} from './calculations/normalization.js';

const RAW_IMPORT_BATCH_SIZE = 20;

/**
 * Determine bank type from bank name string.
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

/**
 * Parse a raw CSV line into fields (handles quoted fields).
 */
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
      fields.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  fields.push(current);
  return fields;
}

/**
 * Parse decimal from CSV string (handles comma separators, parentheses for negative).
 */
function parseDecimal(value) {
  if (!value) return 0;
  let v = String(value).trim();
  if (v === '') return 0;
  let negative = false;
  if (v.startsWith('(') && v.endsWith(')')) { negative = true; v = v.slice(1, -1); }
  // If both dots and commas: dots are thousands, comma is decimal
  if (v.includes('.') && v.includes(',')) {
    v = v.replace(/\./g, '').replace(',', '.');
  } else {
    v = v.replace(',', '.');
  }
  v = v.replace(/\s/g, '');
  const n = parseFloat(v);
  if (isNaN(n)) return 0;
  return negative ? -n : n;
}

/**
 * Parse date string from CSV into YYYY-MM-DD or full datetime string.
 */
function parseDateStr(value, dateOnly = true) {
  if (!value) return null;
  const s = value.trim();
  // DD/MM/YYYY
  const ddmmyyyy = s.match(/^(\d{2})\/(\d{2})\/(\d{4})/);
  if (ddmmyyyy) {
    const d = `${ddmmyyyy[3]}-${ddmmyyyy[2]}-${ddmmyyyy[1]}`;
    if (dateOnly) return d;
    return s.length > 10 ? `${d} ${s.substring(11)}` : d;
  }
  // YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) {
    return dateOnly ? s.substring(0, 10) : s;
  }
  return null;
}

/**
 * Store a Belfius raw transaction.
 */
async function storeBelfiusRaw(txData, dedupHash) {
  const parsed = parseRawCsvLine(txData.rawData, ';');
  const data = {
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
  };
  return belfiusRawRepo.create(data);
}

/**
 * Store a Revolut raw transaction.
 */
async function storeRevolutRaw(txData, dedupHash) {
  const parsed = parseRawCsvLine(txData.rawData, ',');
  const data = {
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
  };
  return revolutRawRepo.create(data);
}

/**
 * Store a KBC raw transaction.
 */
async function storeKbcRaw(txData, dedupHash) {
  const parsed = parseRawCsvLine(txData.rawData, ';');
  const data = {
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
  };
  return kbcRawRepo.create(data);
}

/**
 * Store a SABB raw transaction.
 */
async function storeSABBRaw(txData, dedupHash) {
  // SABB rawData is Object.values(row).join('|') — parse back by splitting on '|'
  // Columns order (from parseSABB): Transaction date | Posting date | Description | Amount(SAR) | Amount(Other Currency) | Status
  const parts = (txData.rawData || '').split('|');
  const data = {
    deduplication_hash: dedupHash,
    transaction_date: txData.date.toISOString().split('T')[0],
    posting_date: parseDateStr((parts[1] || '').trim()) || null,
    description: (parts[2] || '').trim() || txData.memo || null,
    amount: txData.amount,
    currency: txData.currency || 'SAR',
    status: (parts[5] || '').trim() || null,
    amount_other_currency: (parts[4] || '').trim() || null,
    raw_csv_line: txData.rawData,
  };
  return sabbRawRepo.create(data);
}

/**
 * Store a Wise raw transaction.
 */
async function storeWiseRaw(txData, dedupHash) {
  // Wise rawData is Object.values(row).join('|')
  // Columns order (from parseWise): ID | Status | Direction | Created on | Finished on |
  //   Source name | Source amount (after fees) | Source fee amount | Source fee currency | Source currency |
  //   Target name | Target amount (after fees) | Target currency | Exchange rate | Reference | Batch | Category | Note
  const parts = (txData.rawData || '').split('|');
  const data = {
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
  };
  return wiseRawRepo.create(data);
}

/**
 * Store a Vision raw transaction.
 */
async function storeVisionRaw(txData, dedupHash) {
  // Vision rawData is Object.values(row).join('|')
  // Columns order (from parseVision): Date | Amount | Bank Account | Recipient | Memo | Currency | Balance | Category | Comment
  const parts = (txData.rawData || '').split('|');
  const data = {
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
  };
  return visionRawRepo.create(data);
}

/**
 * Import transactions from CSV with raw data preservation.
 *
 * Architecture mirrors Python RawTransactionImportService:
 * 1. Parse CSV → bank adapter
 * 2. For each row: check raw table dedup → store raw → create normalized → link
 *
 * Falls back to old flow for unsupported bank types (generic).
 */
export async function importCSVWithRawStorage(filePath, bankName, customConfig = null) {
  logger.info('Starting raw transaction CSV import', { bankName, hasCustomConfig: !!customConfig });

  try {
    const parser = createAdapter(bankName, customConfig);
    const transactionDataList = await parser(filePath);
    const bankType = determineBankType(bankName);

    logger.info(`Parsed ${transactionDataList.length} transactions, bank type: ${bankType}`);

    const results = {
      total_processed: transactionDataList.length,
      imported: 0,
      duplicates: 0,
      errors: 0,
    };

    for (let i = 0; i < transactionDataList.length; i += RAW_IMPORT_BATCH_SIZE) {
      const batch = transactionDataList.slice(i, i + RAW_IMPORT_BATCH_SIZE);
      const settled = await Promise.allSettled(batch.map((txData) => processRawImportRow(txData, bankType)));

      for (const outcome of settled) {
        if (outcome.status === 'fulfilled') {
          if (outcome.value === 'imported') results.imported++;
          else if (outcome.value === 'duplicate') results.duplicates++;
          else results.errors++;
        } else {
          logger.warn(`Error processing transaction: ${outcome.reason?.message || outcome.reason}`);
          results.errors++;
        }
      }
    }

    logger.info('Raw transaction CSV import completed', results);
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

async function processRawImportRow(txData, bankType) {
  if (!txData.rawData) {
    return 'error';
  }

  const dedupHash = computeHash(txData.rawData);
  let isDup;
  try {
    isDup = await isRawDuplicate(bankType, txData.rawData);
  } catch {
    const dateStr = txData.date.toISOString().split('T')[0];
    isDup = await isDuplicateByFields(dateStr, txData.amount, txData.recipient, txData.memo);
  }

  if (isDup) {
    return 'duplicate';
  }

  let rawTxn = null;
  try {
    if (bankType === 'belfius') rawTxn = await storeBelfiusRaw(txData, dedupHash);
    else if (bankType === 'revolut') rawTxn = await storeRevolutRaw(txData, dedupHash);
    else if (bankType === 'kbc') rawTxn = await storeKbcRaw(txData, dedupHash);
    else if (bankType === 'sabb') rawTxn = await storeSABBRaw(txData, dedupHash);
    else if (bankType === 'wise') rawTxn = await storeWiseRaw(txData, dedupHash);
    else if (bankType === 'vision') rawTxn = await storeVisionRaw(txData, dedupHash);
  } catch (rawErr) {
    logger.warn(`Raw storage failed (table may not exist): ${rawErr.message}`);
  }

  const recipientId = await getOrCreateRecipient(
    txData.recipient, txData.recipientAccount, txData.recipientAddress, txData.recipientBankName
  );

  const dateStr = txData.date.toISOString().split('T')[0];
  const txResult = await query(
    `INSERT INTO transactions (date, bank_account, recipient_id, amount, memo, currency, balance, comment, is_active)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true) RETURNING id`,
    [dateStr, txData.bankAccount, recipientId, txData.amount, txData.memo || '', txData.currency || null, txData.balance, txData.comment]
  );

  if (rawTxn && txResult.rows[0]) {
    try {
      await rawReferenceRepo.create({
        transactionId: txResult.rows[0].id,
        rawSourceType: bankType,
        rawSourceId: rawTxn.id,
      });
    } catch (refErr) {
      logger.warn(`Raw reference creation failed: ${refErr.message}`);
    }
  }

  return 'imported';
}

/**
 * Get or create a recipient by name.
 *
 * Phase 6: matching now goes through `findBestRecipientMatch` which uses
 * the pg_trgm GIN index (migration 0026) — exact normalized hit preferred,
 * fuzzy fallback at DEFAULT_MATCH_THRESHOLD. Creation uses
 * `INSERT ... ON CONFLICT (normalized_name) DO NOTHING` against the
 * UNIQUE constraint added in migration 0029, so concurrent imports that
 * race on the same normalized name converge on a single recipient row.
 */
async function getOrCreateRecipient(name, accountNumber, address, bankName) {
  if (!name) name = 'UNKNOWN';
  const upperName = name.toUpperCase().trim();
  const normalizedName = normalizeForMatching(name);

  // 1. Try exact + fuzzy match via pg_trgm-backed batch matcher.
  const match = await findBestRecipientMatch(name);
  if (match) {
    const recipientId = match.recipientId;
    if (accountNumber) {
      const bankAcctExists = await query(
        `SELECT id FROM recipient_bank_accounts WHERE recipient_id = $1 AND account_number = $2 LIMIT 1`,
        [recipientId, accountNumber]
      );
      if (bankAcctExists.rows.length === 0) {
        await query(
          `INSERT INTO recipient_bank_accounts (recipient_id, account_number, bank_name, is_primary, is_active)
           VALUES ($1, $2, $3, false, true) ON CONFLICT DO NOTHING`,
          [recipientId, accountNumber, bankName || null]
        ).catch((err) => {
          logger.warn('Recipient bank account insert failed (matched path)', {
            recipientId, accountNumber, error: err.message,
          });
        });
      }
    }
    return recipientId;
  }

  // 2. No match — upsert against UNIQUE(normalized_name). On conflict
  // another concurrent caller won the race; SELECT to retrieve their row.
  const upsert = await query(
    `INSERT INTO recipients (name, normalized_name, is_active)
     VALUES ($1, $2, true)
     ON CONFLICT (normalized_name) DO NOTHING
     RETURNING id`,
    [upperName, normalizedName]
  );

  let newId;
  if (upsert.rows.length > 0) {
    newId = upsert.rows[0].id;
  } else {
    // Conflicting caller's row may not yet be visible; retry briefly.
    let existing = await query(
      `SELECT id FROM recipients WHERE normalized_name = $1 LIMIT 1`,
      [normalizedName]
    );
    let attempts = 0;
    while (!existing.rows.length && attempts < 3) {
      await new Promise((resolve) => setTimeout(resolve, 25 * (attempts + 1)));
      existing = await query(
        `SELECT id FROM recipients WHERE normalized_name = $1 LIMIT 1`,
        [normalizedName]
      );
      attempts += 1;
    }
    if (!existing.rows.length) {
      throw new Error(`Recipient upsert produced no row for ${normalizedName}`);
    }
    newId = existing.rows[0].id;
  }

  if (accountNumber) {
    await query(
      `INSERT INTO recipient_bank_accounts (recipient_id, account_number, bank_name, is_primary, is_active)
       VALUES ($1, $2, $3, true, true) ON CONFLICT DO NOTHING`,
      [newId, accountNumber, bankName || null]
    ).catch((err) => {
      logger.warn('Recipient bank account insert failed (new recipient path)', {
        recipientId: newId, accountNumber, error: err.message,
      });
    });
  }

  if (address) {
    await query(`UPDATE recipients SET notes = $1 WHERE id = $2 AND (notes IS NULL OR notes = '')`, [address, newId])
      .catch((err) => {
        logger.warn('Recipient notes update failed', {
          recipientId: newId, error: err.message,
        });
      });
  }

  return newId;
}
