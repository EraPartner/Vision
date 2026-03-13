/**
 * Raw Transaction Repositories - data access for bank-specific raw transaction tables.
 *
 * Mirrors: apps/backend/repositories/raw_transaction_repositories.py
 *
 * Each bank has its own immutable, append-only table for preserving original CSV data.
 * Uses SHA256 hash-based deduplication at the source level.
 *
 * Performance notes:
 * - All create() methods use INSERT ... ON CONFLICT (deduplication_hash) DO NOTHING RETURNING *
 *   to collapse the old existsByHash + create two-round-trip pattern into a single query.
 *   If the hash already exists the insert is skipped and null is returned (caller treats as duplicate).
 * - existsByHash() is retained for callers that need a boolean check without inserting.
 */

import crypto from 'crypto';
import { query } from '../database/connection.js';

/**
 * Compute SHA256 hash for raw CSV line deduplication.
 */
export function computeHash(rawCsvLine) {
  return crypto.createHash('sha256').update(rawCsvLine, 'utf-8').digest('hex');
}

// ─── Belfius Raw Transaction Repository ───

export const belfiusRawRepo = {
  /**
   * Insert a new raw row. Returns the inserted row, or null if the hash already exists.
   * Single DB round-trip via ON CONFLICT DO NOTHING.
   */
  async create(data) {
    const sql = `
      INSERT INTO belfius_raw_transactions (
        deduplication_hash, account_number, transaction_date, statement_number,
        transaction_number, recipient_account, recipient_name, recipient_street,
        recipient_location, recipient_bic, recipient_country, transaction_description,
        value_date, amount, currency, balance, additional_message, raw_csv_line
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
      ON CONFLICT (deduplication_hash) DO NOTHING
      RETURNING *
    `;
    const result = await query(sql, [
      data.deduplication_hash, data.account_number, data.transaction_date,
      data.statement_number, data.transaction_number, data.recipient_account,
      data.recipient_name, data.recipient_street, data.recipient_location,
      data.recipient_bic, data.recipient_country, data.transaction_description,
      data.value_date, data.amount, data.currency, data.balance,
      data.additional_message, data.raw_csv_line,
    ]);
    return result.rows[0] ?? null; // null means duplicate skipped
  },

  async existsByHash(hash) {
    const result = await query(
      `SELECT id FROM belfius_raw_transactions WHERE deduplication_hash = $1 LIMIT 1`,
      [hash]
    );
    return result.rows.length > 0;
  },

  async findByAccountAndDateRange(accountNumber, startDate, endDate) {
    const result = await query(
      `SELECT * FROM belfius_raw_transactions
       WHERE account_number = $1 AND transaction_date >= $2 AND transaction_date <= $3
       ORDER BY transaction_date, id`,
      [accountNumber, startDate, endDate]
    );
    return result.rows;
  },

  async getLatestBalance(accountNumber) {
    const result = await query(
      `SELECT balance FROM belfius_raw_transactions
       WHERE account_number = $1 AND balance IS NOT NULL
       ORDER BY transaction_date DESC, id DESC LIMIT 1`,
      [accountNumber]
    );
    return result.rows[0]?.balance ? parseFloat(result.rows[0].balance) : null;
  },
};

// ─── Revolut Raw Transaction Repository ───

export const revolutRawRepo = {
  async create(data) {
    const sql = `
      INSERT INTO revolut_raw_transactions (
        deduplication_hash, transaction_type, product, started_date,
        completed_date, description, amount, fee, currency, state,
        balance, raw_csv_line
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
      ON CONFLICT (deduplication_hash) DO NOTHING
      RETURNING *
    `;
    const result = await query(sql, [
      data.deduplication_hash, data.transaction_type, data.product,
      data.started_date, data.completed_date, data.description,
      data.amount, data.fee, data.currency, data.state,
      data.balance, data.raw_csv_line,
    ]);
    return result.rows[0] ?? null;
  },

  async existsByHash(hash) {
    const result = await query(
      `SELECT id FROM revolut_raw_transactions WHERE deduplication_hash = $1 LIMIT 1`,
      [hash]
    );
    return result.rows.length > 0;
  },

  async findByProductAndDateRange(product, startDate, endDate) {
    const result = await query(
      `SELECT * FROM revolut_raw_transactions
       WHERE product = $1 AND completed_date >= $2 AND completed_date <= $3 AND state = 'COMPLETED'
       ORDER BY completed_date, id`,
      [product, startDate, endDate]
    );
    return result.rows;
  },

  async getLatestBalance(product) {
    const result = await query(
      `SELECT balance FROM revolut_raw_transactions
       WHERE product = $1 AND state = 'COMPLETED' AND balance IS NOT NULL
       ORDER BY completed_date DESC, id DESC LIMIT 1`,
      [product]
    );
    return result.rows[0]?.balance ? parseFloat(result.rows[0].balance) : null;
  },
};

// ─── KBC Raw Transaction Repository ───

export const kbcRawRepo = {
  async create(data) {
    const sql = `
      INSERT INTO kbc_raw_transactions (
        deduplication_hash, account_number, category_name, account_holder_name,
        currency, statement_number, transaction_date, value_date,
        description, amount, balance, credit_amount, debit_amount,
        counterparty_account, counterparty_bic, counterparty_name,
        counterparty_address, structured_communication, free_communication,
        raw_csv_line
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
      ON CONFLICT (deduplication_hash) DO NOTHING
      RETURNING *
    `;
    const result = await query(sql, [
      data.deduplication_hash, data.account_number, data.category_name,
      data.account_holder_name, data.currency, data.statement_number,
      data.transaction_date, data.value_date, data.description,
      data.amount, data.balance, data.credit_amount, data.debit_amount,
      data.counterparty_account, data.counterparty_bic, data.counterparty_name,
      data.counterparty_address, data.structured_communication,
      data.free_communication, data.raw_csv_line,
    ]);
    return result.rows[0] ?? null;
  },

  async existsByHash(hash) {
    const result = await query(
      `SELECT id FROM kbc_raw_transactions WHERE deduplication_hash = $1 LIMIT 1`,
      [hash]
    );
    return result.rows.length > 0;
  },

  async findByAccountAndDateRange(accountNumber, startDate, endDate) {
    const result = await query(
      `SELECT * FROM kbc_raw_transactions
       WHERE account_number = $1 AND transaction_date >= $2 AND transaction_date <= $3
       ORDER BY transaction_date, id`,
      [accountNumber, startDate, endDate]
    );
    return result.rows;
  },

  async getLatestBalance(accountNumber) {
    const result = await query(
      `SELECT balance FROM kbc_raw_transactions
       WHERE account_number = $1 AND balance IS NOT NULL
       ORDER BY transaction_date DESC, id DESC LIMIT 1`,
      [accountNumber]
    );
    return result.rows[0]?.balance ? parseFloat(result.rows[0].balance) : null;
  },
};

// ─── SABB Raw Transaction Repository ───

export const sabbRawRepo = {
  async create(data) {
    const sql = `
      INSERT INTO sabb_raw_transactions (
        deduplication_hash, transaction_date, posting_date, description,
        amount, currency, status, amount_other_currency, raw_csv_line
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      ON CONFLICT (deduplication_hash) DO NOTHING
      RETURNING *
    `;
    const result = await query(sql, [
      data.deduplication_hash, data.transaction_date, data.posting_date,
      data.description, data.amount, data.currency, data.status,
      data.amount_other_currency, data.raw_csv_line,
    ]);
    return result.rows[0] ?? null;
  },

  async existsByHash(hash) {
    const result = await query(
      `SELECT id FROM sabb_raw_transactions WHERE deduplication_hash = $1 LIMIT 1`,
      [hash]
    );
    return result.rows.length > 0;
  },
};

// ─── Wise Raw Transaction Repository ───

export const wiseRawRepo = {
  async create(data) {
    const sql = `
      INSERT INTO wise_raw_transactions (
        deduplication_hash, transfer_id, direction, status, finished_on,
        source_name, source_amount, source_currency,
        target_name, target_amount, target_currency,
        exchange_rate, source_fee_amount, source_fee_currency,
        reference, batch, raw_csv_line
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
      ON CONFLICT (deduplication_hash) DO NOTHING
      RETURNING *
    `;
    const result = await query(sql, [
      data.deduplication_hash, data.transfer_id, data.direction, data.status,
      data.finished_on, data.source_name, data.source_amount, data.source_currency,
      data.target_name, data.target_amount, data.target_currency,
      data.exchange_rate, data.source_fee_amount, data.source_fee_currency,
      data.reference, data.batch, data.raw_csv_line,
    ]);
    return result.rows[0] ?? null;
  },

  async existsByHash(hash) {
    const result = await query(
      `SELECT id FROM wise_raw_transactions WHERE deduplication_hash = $1 LIMIT 1`,
      [hash]
    );
    return result.rows.length > 0;
  },
};

// ─── Vision Raw Transaction Repository ───

export const visionRawRepo = {
  async create(data) {
    const sql = `
      INSERT INTO vision_raw_transactions (
        deduplication_hash, transaction_date, bank_account, recipient,
        memo, amount, currency, balance, category, comment, raw_csv_line
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
      ON CONFLICT (deduplication_hash) DO NOTHING
      RETURNING *
    `;
    const result = await query(sql, [
      data.deduplication_hash, data.transaction_date, data.bank_account,
      data.recipient, data.memo, data.amount, data.currency,
      data.balance, data.category, data.comment, data.raw_csv_line,
    ]);
    return result.rows[0] ?? null;
  },

  async existsByHash(hash) {
    const result = await query(
      `SELECT id FROM vision_raw_transactions WHERE deduplication_hash = $1 LIMIT 1`,
      [hash]
    );
    return result.rows.length > 0;
  },
};

// ─── Raw Reference Repository ───

export const rawReferenceRepo = {
  async create({ transactionId, rawSourceType, rawSourceId }) {
    const result = await query(
      `INSERT INTO transaction_raw_references (transaction_id, raw_source_type, raw_source_id)
       VALUES ($1, $2, $3)
       ON CONFLICT DO NOTHING
       RETURNING *`,
      [transactionId, rawSourceType, rawSourceId]
    );
    return result.rows[0] ?? null;
  },

  async getByTransactionId(transactionId) {
    const result = await query(
      `SELECT * FROM transaction_raw_references WHERE transaction_id = $1`,
      [transactionId]
    );
    return result.rows[0] || null;
  },
};

/**
 * Check if a raw transaction is a duplicate for any bank type.
 */
export async function isRawDuplicate(bankType, rawCsvLine) {
  const hash = computeHash(rawCsvLine);
  const bankLower = bankType.toLowerCase();

  if (bankLower === 'belfius') return belfiusRawRepo.existsByHash(hash);
  if (bankLower === 'revolut') return revolutRawRepo.existsByHash(hash);
  if (bankLower === 'kbc') return kbcRawRepo.existsByHash(hash);
  if (bankLower === 'sabb') return sabbRawRepo.existsByHash(hash);
  if (bankLower === 'wise') return wiseRawRepo.existsByHash(hash);
  if (bankLower === 'vision') return visionRawRepo.existsByHash(hash);

  throw new Error(`Unsupported bank type for raw dedup: ${bankType}`);
}
