/**
 * Deduplication Service
 * Mirrors: apps/backend/services/deduplication_service.py
 */

import crypto from 'crypto';
import { query } from '../database/connection.js';
import { logger } from '../config/logger.js';

export function createTransactionHash(transactionData) {
  let raw = transactionData.rawData;
  if (!raw) {
    raw = `${transactionData.date.toISOString().split('T')[0]}|${transactionData.amount}|${transactionData.recipient}|${transactionData.memo || ''}`;
  }
  return crypto.createHash('sha256').update(raw, 'utf-8').digest('hex');
}

/**
 * Create a hash for a manually added transaction.
 */
export function createManualTransactionHash({ date, amount, recipientId, memo, bankAccount }) {
  const raw = `manual|${date}|${amount}|${recipientId}|${(memo || '').toUpperCase()}|${(bankAccount || '').toUpperCase()}`;
  return crypto.createHash('sha256').update(raw, 'utf-8').digest('hex');
}

export async function isDuplicate(transactionData) {
  // Field-based dedup: matches on date + amount + recipient.
  // Hash-based dedup is performed separately by callers using the raw_transactions tables.
  const result = await query(
    `SELECT id FROM transactions
     WHERE date = $1 AND amount = $2 AND recipient_id = (
       SELECT id FROM recipients WHERE UPPER(name) = $3 LIMIT 1
     ) AND is_active = true
     LIMIT 1`,
    [
      transactionData.date.toISOString().split('T')[0],
      transactionData.amount,
      (transactionData.recipient || '').toUpperCase(),
    ]
  );
  return result.rows.length > 0;
}

export async function isDuplicateByFields(date, amount, recipientName, memo) {
  const result = await query(
    `SELECT id FROM transactions t
     LEFT JOIN recipients r ON t.recipient_id = r.id
     WHERE t.date = $1 AND t.amount = $2 AND UPPER(r.name) = $3 AND t.is_active = true
     LIMIT 1`,
    [date, amount, (recipientName || '').toUpperCase()]
  );
  return result.rows.length > 0;
}

/**
 * Check if a manually added transaction is a duplicate using the manual_raw_transactions table.
 * Returns { isDuplicate: boolean, existingTransactionId: number|null }
 */
export async function isManualDuplicate({ date, amount, recipientId, memo, bankAccount }) {
  const hash = createManualTransactionHash({ date, amount, recipientId, memo, bankAccount });
  
  try {
    const result = await query(
      `SELECT transaction_id FROM manual_raw_transactions WHERE deduplication_hash = $1 LIMIT 1`,
      [hash]
    );
    if (result.rows.length > 0) {
      return { isDuplicate: true, existingTransactionId: result.rows[0].transaction_id };
    }
  } catch (err) {
    if (err.code !== '42P01') {
      logger.warn('Unexpected error in manual dedup hash check', { error: err.message, code: err.code });
    }
    // Table may not exist yet — fall through to field-based check
  }

  // Fallback: field-based duplicate check
  const fieldResult = await query(
    `SELECT id FROM transactions
     WHERE date = $1 AND amount = $2 AND recipient_id = $3 AND is_active = true
     LIMIT 1`,
    [date, amount, recipientId]
  );
  if (fieldResult.rows.length > 0) {
    return { isDuplicate: true, existingTransactionId: fieldResult.rows[0].id };
  }

  return { isDuplicate: false, existingTransactionId: null };
}

/**
 * Record a manually added transaction in the raw table for future dedup.
 */
export async function recordManualRawTransaction({ date, amount, recipientId, memo, bankAccount, categoryId, comment, transactionId }) {
  const hash = createManualTransactionHash({ date, amount, recipientId, memo, bankAccount });
  
  try {
    await query(
      `INSERT INTO manual_raw_transactions (deduplication_hash, transaction_id, date, bank_account, recipient_id, amount, memo, currency, category_id, comment)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NULL, $8, $9)
       ON CONFLICT (deduplication_hash) DO NOTHING`,
      [hash, transactionId, date, bankAccount, recipientId, amount, memo, categoryId, comment]
    );
  } catch (err) {
    if (err.code !== '42P01') {
      logger.warn('Unexpected error recording manual raw transaction', { error: err.message, code: err.code });
    }
    // Table may not exist yet — silently skip
  }
}
