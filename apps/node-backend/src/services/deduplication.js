/**
 * Deduplication Service
 * Mirrors: apps/backend/services/deduplication_service.py
 */

import crypto from 'crypto';
import { query } from '../database/connection.js';

export function createTransactionHash(transactionData) {
  let raw = transactionData.rawData;
  if (!raw) {
    raw = `${transactionData.date.toISOString().split('T')[0]}|${transactionData.amount}|${transactionData.recipient}|${transactionData.memo || ''}`;
  }
  return crypto.createHash('sha256').update(raw, 'utf-8').digest('hex');
}

export async function isDuplicate(transactionData) {
  const hash = createTransactionHash(transactionData);
  // Check if a transaction with this hash exists in the DB
  // We check by matching date + amount + recipient as fallback
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
