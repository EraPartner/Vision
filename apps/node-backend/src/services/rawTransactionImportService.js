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
  rawReferenceRepo,
  isRawDuplicate,
} from '../repositories/rawTransactionRepository.js';

/**
 * Determine bank type from bank name string.
 */
function determineBankType(bankName) {
  const lower = bankName.toLowerCase().trim();
  if (lower.includes('belfius')) return 'belfius';
  if (lower.includes('revolut')) return 'revolut';
  if (lower.includes('kbc')) return 'kbc';
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
    const transactionDataList = parser(filePath);
    const bankType = determineBankType(bankName);

    logger.info(`Parsed ${transactionDataList.length} transactions, bank type: ${bankType}`);

    const results = {
      total_processed: transactionDataList.length,
      imported: 0,
      duplicates: 0,
      errors: 0,
    };

    // If bank type is generic (no raw table), fall back to the legacy dedup
    if (bankType === 'generic') {
      logger.warn('No raw table for generic bank type, using legacy import');
      // Import using the old importService
      const { importCSV } = await import('./importService.js');
      return importCSV(filePath, bankName, customConfig);
    }

    for (const txData of transactionDataList) {
      try {
        if (!txData.rawData) {
          // No raw data available — skip raw storage
          results.errors++;
          continue;
        }

        // Step 1: Check raw table deduplication
        const dedupHash = computeHash(txData.rawData);
        let isDup = false;
        try {
          if (bankType === 'belfius') isDup = await belfiusRawRepo.existsByHash(dedupHash);
          else if (bankType === 'revolut') isDup = await revolutRawRepo.existsByHash(dedupHash);
          else if (bankType === 'kbc') isDup = await kbcRawRepo.existsByHash(dedupHash);
        } catch {
          // Raw table may not exist yet — fall back to old dedup
          const { isDuplicateByFields } = await import('./deduplication.js');
          const dateStr = txData.date.toISOString().split('T')[0];
          isDup = await isDuplicateByFields(dateStr, txData.amount, txData.recipient, txData.memo);
        }

        if (isDup) {
          results.duplicates++;
          continue;
        }

        // Step 2: Store in bank-specific raw table
        let rawTxn = null;
        try {
          if (bankType === 'belfius') rawTxn = await storeBelfiusRaw(txData, dedupHash);
          else if (bankType === 'revolut') rawTxn = await storeRevolutRaw(txData, dedupHash);
          else if (bankType === 'kbc') rawTxn = await storeKbcRaw(txData, dedupHash);
        } catch (rawErr) {
          logger.warn(`Raw storage failed (table may not exist): ${rawErr.message}`);
          // Continue without raw storage — still create normalized transaction
        }

        // Step 3: Get or create recipient
        const recipientId = await getOrCreateRecipient(
          txData.recipient, txData.recipientAccount, txData.recipientAddress, txData.recipientBankName
        );

        // Step 4: Create normalized transaction
        const dateStr = txData.date.toISOString().split('T')[0];
        const txResult = await query(
          `INSERT INTO transactions (date, bank_account, recipient_id, amount, memo, currency, balance, comment, is_active)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true) RETURNING id`,
          [dateStr, txData.bankAccount, recipientId, txData.amount, txData.memo || '', txData.currency || null, txData.balance, txData.comment]
        );

        // Step 5: Create raw reference link
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

        results.imported++;
      } catch (err) {
        logger.warn(`Error processing transaction: ${err.message}`);
        results.errors++;
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

/**
 * Get or create a recipient by name (reused from importService).
 */
async function getOrCreateRecipient(name, accountNumber, address, bankName) {
  if (!name) name = 'UNKNOWN';
  const upperName = name.toUpperCase().trim();
  const normalizedName = upperName.replace(/\s+/g, ' ');

  const existing = await query(
    `SELECT id FROM recipients WHERE normalized_name = $1 LIMIT 1`,
    [normalizedName]
  );

  if (existing.rows.length > 0) {
    const recipientId = existing.rows[0].id;
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
        ).catch(() => {});
      }
    }
    return recipientId;
  }

  const result = await query(
    `INSERT INTO recipients (name, normalized_name, is_active) VALUES ($1, $2, true) RETURNING id`,
    [upperName, normalizedName]
  );
  const newId = result.rows[0].id;

  if (accountNumber) {
    await query(
      `INSERT INTO recipient_bank_accounts (recipient_id, account_number, bank_name, is_primary, is_active)
       VALUES ($1, $2, $3, true, true) ON CONFLICT DO NOTHING`,
      [newId, accountNumber, bankName || null]
    ).catch(() => {});
  }

  if (address) {
    await query(`UPDATE recipients SET notes = $1 WHERE id = $2`, [address, newId]).catch(() => {});
  }

  return newId;
}
