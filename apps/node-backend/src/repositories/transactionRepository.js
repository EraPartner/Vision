/**
 * Transaction Repository - data access for transactions table.
 *
 * Mirrors: apps/backend/repositories/transaction_repository.py
 */

import { query } from '../database/connection.js';
import { sanitizeUpdateFields } from '../middleware/validation.js';

// Shared JOIN fragment used by every multi-join query
const TRANSACTION_JOINS = `
  LEFT JOIN recipients r ON t.recipient_id = r.id
  LEFT JOIN recipients pr ON r.primary_recipient_id = pr.id
  LEFT JOIN categories c ON t.category_id = c.id
  LEFT JOIN categories rc ON r.default_category_id = rc.id
  LEFT JOIN categories pc ON pr.default_category_id = pc.id
`;

/**
 * Build the WHERE clause and parameter list from common filter options.
 * Returns { where, params, nextParam } so callers can append further params.
 */
function buildWhereClause({
  startDate = null,
  endDate = null,
  bankAccount = null,
  categoryId = null,
  recipientId = null,
  recipientName = null,
  search = null,
  active = true,
} = {}) {
  const clauses = ['1=1'];
  const params = [];
  let p = 1;

  if (active) clauses.push('t.is_active = true');
  if (startDate) { clauses.push(`t.date >= $${p++}`); params.push(startDate); }
  if (endDate) { clauses.push(`t.date <= $${p++}`); params.push(endDate); }
  if (bankAccount) { clauses.push(`t.bank_account ILIKE $${p++}`); params.push(`%${bankAccount}%`); }
  if (categoryId != null) {
    clauses.push(`COALESCE(t.category_id, r.default_category_id, pr.default_category_id) = $${p++}`);
    params.push(categoryId);
  }
  if (recipientId != null) {
    clauses.push(`(t.recipient_id = $${p} OR r.primary_recipient_id = $${p})`);
    p++;
    params.push(recipientId);
  }
  if (recipientName) { clauses.push(`r.name ILIKE $${p++}`); params.push(`%${recipientName}%`); }
  if (search) {
    clauses.push(`(
      t.memo ILIKE $${p} OR
      t.comment ILIKE $${p} OR
      t.bank_account ILIKE $${p} OR
      t.currency ILIKE $${p} OR
      CAST(t.amount AS TEXT) ILIKE $${p} OR
      r.name ILIKE $${p} OR
      pr.name ILIKE $${p} OR
      c.general ILIKE $${p} OR
      c.detail ILIKE $${p} OR
      rc.general ILIKE $${p} OR
      rc.detail ILIKE $${p} OR
      pc.general ILIKE $${p} OR
      pc.detail ILIKE $${p}
    )`);
    p++;
    params.push(`%${search}%`);
  }

  return { where: clauses.join(' AND '), params, nextParam: p };
}

export const transactionRepository = {
  /**
   * Get transactions with pagination and filtering.
   */
  async getAll({
    limit = 50,
    offset = 0,
    startDate = null,
    endDate = null,
    bankAccount = null,
    categoryId = null,
    recipientId = null,
    recipientName = null,
    search = null,
    active = true,
  } = {}) {
    const { where, params, nextParam: p } = buildWhereClause({
      startDate, endDate, bankAccount, categoryId, recipientId, recipientName, search, active,
    });

    const sql = `
      SELECT t.*,
             COALESCE(pr.name, r.name) AS recipient_name,
             COALESCE(t.category_id, r.default_category_id, pr.default_category_id) AS effective_category_id,
             CASE
               WHEN c.id IS NOT NULL THEN c.general || ':' || c.detail
               WHEN pc.id IS NOT NULL THEN pc.general || ':' || pc.detail
               WHEN rc.id IS NOT NULL THEN rc.general || ':' || rc.detail
               ELSE NULL
             END AS category_name
      FROM transactions t
      ${TRANSACTION_JOINS}
      WHERE ${where}
      ORDER BY t.date DESC LIMIT $${p} OFFSET $${p + 1}
    `;
    params.push(limit, offset);

    const result = await query(sql, params);
    return result.rows;
  },

  /**
   * Get total count with optional filters (reuses the same WHERE builder as getAll).
   */
  async getCount({
    startDate = null,
    endDate = null,
    bankAccount = null,
    categoryId = null,
    recipientId = null,
    recipientName = null,
    search = null,
    active = true,
  } = {}) {
    const { where, params } = buildWhereClause({
      startDate, endDate, bankAccount, categoryId, recipientId, recipientName, search, active,
    });

    const sql = `
      SELECT count(*) FROM transactions t
      ${TRANSACTION_JOINS}
      WHERE ${where}
    `;

    const result = await query(sql, params);
    return parseInt(result.rows[0].count, 10);
  },

  /**
   * Get uncategorised transactions (recipient has no default category and transaction has no category).
   */
  async getUncategorised({ limit = 50, offset = 0, startDate = null, endDate = null, bankAccount = null, recipientId = null, recipientName = null } = {}) {
    let sql = `
      SELECT t.*,
             r.name AS recipient_name,
             NULL AS category_name
      FROM transactions t
      LEFT JOIN recipients r ON t.recipient_id = r.id
      WHERE t.is_active = true
        AND t.category_id IS NULL
        AND (r.default_category_id IS NULL)
    `;
    const params = [];
    let paramIdx = 1;

    if (startDate) { sql += ` AND t.date >= $${paramIdx++}`; params.push(startDate); }
    if (endDate) { sql += ` AND t.date <= $${paramIdx++}`; params.push(endDate); }
    if (bankAccount) { sql += ` AND t.bank_account ILIKE $${paramIdx++}`; params.push(`%${bankAccount}%`); }
    if (recipientId != null) { sql += ` AND t.recipient_id = $${paramIdx++}`; params.push(recipientId); }
    if (recipientName) { sql += ` AND r.name ILIKE $${paramIdx++}`; params.push(`%${recipientName}%`); }

    sql += ` ORDER BY t.date DESC LIMIT $${paramIdx++} OFFSET $${paramIdx++}`;
    params.push(limit, offset);

    const result = await query(sql, params);
    return result.rows;
  },

  /**
   * Get a single transaction by ID.
   */
  async getById(id) {
    const sql = `
      SELECT t.*,
             r.name AS recipient_name,
             CASE
               WHEN c.id IS NOT NULL THEN c.general || ':' || c.detail
               WHEN rc.id IS NOT NULL THEN rc.general || ':' || rc.detail
               ELSE NULL
             END AS category_name
      FROM transactions t
      LEFT JOIN recipients r ON t.recipient_id = r.id
      LEFT JOIN categories c ON t.category_id = c.id
      LEFT JOIN categories rc ON r.default_category_id = rc.id
      WHERE t.id = $1
    `;
    const result = await query(sql, [id]);
    return result.rows[0] || null;
  },

  /**
   * Create a new transaction.
   */
  async create({ transaction_date, bank_account, recipient_id, amount, memo, currency, balance, category_id, comment }) {
    const sql = `
      INSERT INTO transactions (date, bank_account, recipient_id, amount, memo, currency, balance, category_id, comment, is_active)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, true)
      RETURNING *
    `;
    const params = [
      transaction_date,
      bank_account ? bank_account.toUpperCase() : null,
      recipient_id,
      amount,
      memo ? memo.toUpperCase() : null,
      currency ? currency.toUpperCase() : null,
      balance,
      category_id,
      comment,
    ];
    const result = await query(sql, params);
    // Re-fetch with joins to get names
    return this.getById(result.rows[0].id);
  },

  /**
   * Update a transaction.
   */
  async update(id, fields) {
    // Sanitize field names to prevent SQL injection via column names
    const sanitized = sanitizeUpdateFields('transactions', fields);
    const setClauses = [];
    const params = [];
    let paramIdx = 1;

    for (const [key, value] of Object.entries(sanitized)) {
      if (value === undefined) continue;
      // Map frontend field names to DB columns
      const dbCol = key === 'transaction_date' ? 'date' : key;
      setClauses.push(`"${dbCol}" = $${paramIdx++}`);
      params.push(value);
    }

    if (setClauses.length === 0) return this.getById(id);

    setClauses.push(`updated_at = NOW()`);
    params.push(id);

    const sql = `UPDATE transactions SET ${setClauses.join(', ')} WHERE id = $${paramIdx} RETURNING *`;
    const result = await query(sql, params);
    if (result.rows.length === 0) return null;
    return this.getById(id);
  },

  /**
   * Hard delete a transaction.
   */
  async hardDelete(id) {
    const result = await query('DELETE FROM transactions WHERE id = $1', [id]);
    return result.rowCount > 0;
  },
};

export default transactionRepository;
