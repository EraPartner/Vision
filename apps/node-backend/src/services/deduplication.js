/**
 * Deduplication Service
 */

import crypto from "crypto";
import { query } from "../database/connection.js";
import { logger } from "../config/logger.js";
import { epochMsToUtcYmd } from "../lib/dateFormat.js";

/**
 * @typedef {object} FieldHashInput
 * @property {Date} date genuine UTC-instant Date (see contract note below).
 * @property {number|string} amount
 * @property {string} [recipient]
 * @property {string} [memo]
 * @property {string} [rawData]
 */

// `transactionData.date` must be a genuine UTC-instant Date (e.g. from the
// import pipeline's parseDateFlexibleUtc) — `.toISOString()` extracts its UTC
// calendar day. Do NOT pass a pg-read DATE column here: those parse as
// local-midnight Date objects (see lib/dateFormat.js) and would day-shift the
// hash on any host east of UTC.
/**
 * @param {FieldHashInput} transactionData
 * @returns {string}
 */
export function createTransactionHash(transactionData) {
  let raw = transactionData.rawData;
  if (!raw) {
    raw = `${epochMsToUtcYmd(transactionData.date.getTime())}|${transactionData.amount}|${transactionData.recipient}|${transactionData.memo || ""}`;
  }
  return crypto.createHash("sha256").update(raw, "utf-8").digest("hex");
}

/**
 * @typedef {object} ManualHashInput
 * @property {string|Date} date
 * @property {number|string} amount
 * @property {number|string|null} [recipientId]
 * @property {string|null} [memo]
 * @property {string|null} [bankAccount]
 */

/**
 * Create a hash for a manually added transaction.
 *
 * @param {ManualHashInput} input
 * @returns {string}
 */
export function createManualTransactionHash({
  date,
  amount,
  recipientId,
  memo,
  bankAccount,
}) {
  const raw = `manual|${date}|${amount}|${recipientId}|${(memo || "").toUpperCase()}|${(bankAccount || "").toUpperCase()}`;
  return crypto.createHash("sha256").update(raw, "utf-8").digest("hex");
}

/**
 * @param {FieldHashInput} transactionData
 * @returns {Promise<boolean>}
 */
export async function isDuplicate(transactionData) {
  // Same UTC-instant contract as createTransactionHash above:
  // transactionData.date must be a genuine UTC-instant Date, not a pg-read
  // local-midnight DATE column.
  //
  // Field-based dedup matches date + amount + recipient + memo so two
  // legitimate same-day same-amount same-vendor purchases are not collapsed.
  //
  // Match the recipient by name through a LEFT JOIN rather than a
  // `recipient_id = (SELECT ... LIMIT 1)` subquery: the subquery returned NULL
  // for an unknown name (so an otherwise-identical `recipient_id IS NULL` row
  // was never flagged) and its LIMIT-without-ORDER-BY was non-deterministic on
  // name collisions. COALESCE handles the no-recipient case symmetrically.
  const result = await query(
    `SELECT t.id FROM transactions t
     LEFT JOIN recipients r ON t.recipient_id = r.id
     WHERE t.date = $1 AND t.amount = $2
       AND COALESCE(UPPER(r.name), '') = $3
       AND COALESCE(TRIM(t.memo), '') = $4
       AND t.is_active = true
     LIMIT 1`,
    [
      epochMsToUtcYmd(transactionData.date.getTime()),
      transactionData.amount,
      (transactionData.recipient || "").toUpperCase(),
      (transactionData.memo || "").trim(),
    ],
  );
  return result.rows.length > 0;
}

/**
 * @param {string} date
 * @param {number|string} amount
 * @param {string} [recipientName]
 * @param {string} [memo]
 * @returns {Promise<boolean>}
 */
export async function isDuplicateByFields(date, amount, recipientName, memo) {
  const result = await query(
    `SELECT id FROM transactions t
     LEFT JOIN recipients r ON t.recipient_id = r.id
     WHERE t.date = $1 AND t.amount = $2 AND UPPER(r.name) = $3
       AND COALESCE(TRIM(t.memo), '') = $4 AND t.is_active = true
     LIMIT 1`,
    [date, amount, (recipientName || "").toUpperCase(), (memo || "").trim()],
  );
  return result.rows.length > 0;
}

/**
 * Check if a manually added transaction is a duplicate using the manual_raw_transactions table.
 *
 * @param {ManualHashInput} input
 * @returns {Promise<{ isDuplicate: boolean, existingTransactionId: number|null }>}
 */
export async function isManualDuplicate({
  date,
  amount,
  recipientId,
  memo,
  bankAccount,
}) {
  const hash = createManualTransactionHash({
    date,
    amount,
    recipientId,
    memo,
    bankAccount,
  });

  try {
    // Only a live, active transaction blocks. The FK is ON DELETE SET NULL
    // (migration 0024), so a deleted transaction leaves its hash row behind
    // with transaction_id = NULL — without the join that dangling row would
    // block re-adding the identical transaction forever, with a ConflictError
    // pointing at nothing.
    const result = await query(
      `SELECT m.transaction_id
         FROM manual_raw_transactions m
         JOIN transactions t ON t.id = m.transaction_id AND t.is_active = true
        WHERE m.deduplication_hash = $1
        LIMIT 1`,
      [hash],
    );
    if (result.rows.length > 0) {
      return {
        isDuplicate: true,
        existingTransactionId: result.rows[0].transaction_id,
      };
    }
  } catch (err) {
    if (err.code !== "42P01") {
      logger.warn("Unexpected error in manual dedup hash check", {
        error: err.message,
        code: err.code,
      });
    }
    // Table may not exist yet — fall through to field-based check
  }

  // Fallback: field-based duplicate check (includes memo for accurate match).
  const fieldResult = await query(
    `SELECT id FROM transactions
     WHERE date = $1 AND amount = $2 AND recipient_id = $3
       AND COALESCE(TRIM(memo), '') = $4
       AND COALESCE(UPPER(bank_account), '') = $5
       AND is_active = true
     LIMIT 1`,
    [
      date,
      amount,
      recipientId,
      (memo || "").trim(),
      (bankAccount || "").toUpperCase(),
    ],
  );
  if (fieldResult.rows.length > 0) {
    return { isDuplicate: true, existingTransactionId: fieldResult.rows[0].id };
  }

  return { isDuplicate: false, existingTransactionId: null };
}

/**
 * Record a manually added transaction in the raw table for future dedup.
 *
 * @param {ManualHashInput & { categoryId?: number|string|null, comment?: string|null, transactionId: number|string }} input
 * @returns {Promise<void>}
 */
export async function recordManualRawTransaction({
  date,
  amount,
  recipientId,
  memo,
  bankAccount,
  categoryId,
  comment,
  transactionId,
}) {
  const hash = createManualTransactionHash({
    date,
    amount,
    recipientId,
    memo,
    bankAccount,
  });

  try {
    // DO UPDATE (not DO NOTHING): re-adding a previously deleted transaction
    // re-claims its dangling hash row, so the hash points at the live row again.
    await query(
      `INSERT INTO manual_raw_transactions (deduplication_hash, transaction_id, date, bank_account, recipient_id, amount, memo, currency, category_id, comment)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NULL, $8, $9)
       ON CONFLICT (deduplication_hash) DO UPDATE SET transaction_id = EXCLUDED.transaction_id`,
      [
        hash,
        transactionId,
        date,
        bankAccount,
        recipientId,
        amount,
        memo,
        categoryId,
        comment,
      ],
    );
  } catch (err) {
    if (err.code !== "42P01") {
      logger.warn("Unexpected error recording manual raw transaction", {
        error: err.message,
        code: err.code,
      });
    }
    // Table may not exist yet — silently skip
  }
}
