/**
 * Transaction Repository - data access for transactions table.
 *
 * Mirrors: apps/backend/repositories/transaction_repository.py
 */

import { query } from '../database/connection.js';
import { sanitizeUpdateFields } from '../middleware/validation.js';

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
    let sql = `
      SELECT t.*,
             COALESCE(pr.name, r.name) AS recipient_name,
             CASE
               WHEN c.id IS NOT NULL THEN c.general || ':' || c.detail
               WHEN pc.id IS NOT NULL THEN pc.general || ':' || pc.detail
               WHEN rc.id IS NOT NULL THEN rc.general || ':' || rc.detail
               ELSE NULL
             END AS category_name
      FROM transactions t
      LEFT JOIN recipients r ON t.recipient_id = r.id
      LEFT JOIN recipients pr ON r.primary_recipient_id = pr.id
      LEFT JOIN categories c ON t.category_id = c.id
      LEFT JOIN categories rc ON r.default_category_id = rc.id
      LEFT JOIN categories pc ON pr.default_category_id = pc.id
      WHERE 1=1
    `;
    const params = [];
    let paramIdx = 1;

    if (active) {
      sql += ` AND t.is_active = true`;
    }
    if (startDate) {
      sql += ` AND t.date >= $${paramIdx++}`;
      params.push(startDate);
    }
    if (endDate) {
      sql += ` AND t.date <= $${paramIdx++}`;
      params.push(endDate);
    }
    if (bankAccount) {
      sql += ` AND t.bank_account ILIKE $${paramIdx++}`;
      params.push(`%${bankAccount}%`);
    }
    if (categoryId != null) {
      sql += ` AND t.category_id = $${paramIdx++}`;
      params.push(categoryId);
    }
    if (recipientId != null) {
      sql += ` AND t.recipient_id = $${paramIdx++}`;
      params.push(recipientId);
    }
    if (recipientName) {
      sql += ` AND r.name ILIKE $${paramIdx++}`;
      params.push(`%${recipientName}%`);
    }
    if (search) {
      const searchParam = `%${search}%`;
      sql += ` AND (
        t.memo ILIKE $${paramIdx} OR
        t.comment ILIKE $${paramIdx} OR
        t.bank_account ILIKE $${paramIdx} OR
        t.currency ILIKE $${paramIdx} OR
        CAST(t.amount AS TEXT) ILIKE $${paramIdx} OR
        r.name ILIKE $${paramIdx} OR
        c.general ILIKE $${paramIdx} OR
        c.detail ILIKE $${paramIdx} OR
        rc.general ILIKE $${paramIdx} OR
        rc.detail ILIKE $${paramIdx}
      )`;
      paramIdx++;
      params.push(searchParam);
    }

    sql += ` ORDER BY t.date DESC LIMIT $${paramIdx++} OFFSET $${paramIdx++}`;
    params.push(limit, offset);

    const result = await query(sql, params);
    return result.rows;
  },

  /**
   * Get total count with optional filters.
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
    let sql = `
      SELECT count(*) FROM transactions t
      LEFT JOIN recipients r ON t.recipient_id = r.id
      LEFT JOIN categories c ON t.category_id = c.id
      LEFT JOIN categories rc ON r.default_category_id = rc.id
      WHERE 1=1
    `;
    const params = [];
    let paramIdx = 1;

    if (active) {
      sql += ` AND t.is_active = true`;
    }
    if (startDate) {
      sql += ` AND t.date >= $${paramIdx++}`;
      params.push(startDate);
    }
    if (endDate) {
      sql += ` AND t.date <= $${paramIdx++}`;
      params.push(endDate);
    }
    if (bankAccount) {
      sql += ` AND t.bank_account ILIKE $${paramIdx++}`;
      params.push(`%${bankAccount}%`);
    }
    if (categoryId != null) {
      sql += ` AND t.category_id = $${paramIdx++}`;
      params.push(categoryId);
    }
    if (recipientId != null) {
      sql += ` AND t.recipient_id = $${paramIdx++}`;
      params.push(recipientId);
    }
    if (recipientName) {
      sql += ` AND r.name ILIKE $${paramIdx++}`;
      params.push(`%${recipientName}%`);
    }
    if (search) {
      const searchParam = `%${search}%`;
      sql += ` AND (
        t.memo ILIKE $${paramIdx} OR
        t.comment ILIKE $${paramIdx} OR
        t.bank_account ILIKE $${paramIdx} OR
        t.currency ILIKE $${paramIdx} OR
        CAST(t.amount AS TEXT) ILIKE $${paramIdx} OR
        r.name ILIKE $${paramIdx} OR
        c.general ILIKE $${paramIdx} OR
        c.detail ILIKE $${paramIdx} OR
        rc.general ILIKE $${paramIdx} OR
        rc.detail ILIKE $${paramIdx}
      )`;
      paramIdx++;
      params.push(searchParam);
    }

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
