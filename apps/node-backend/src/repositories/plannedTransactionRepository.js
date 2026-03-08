/**
 * Planned Transaction Repository - data access for planned_transactions table.
 *
 * Mirrors: apps/backend/repositories/planned_transaction_repository.py
 */

import { query } from '../database/connection.js';
import { sanitizeUpdateFields } from '../middleware/validation.js';

export const plannedTransactionRepository = {
  async getAll({
    limit = 50, offset = 0, startDate = null, endDate = null,
    bankAccount = null, categoryId = null, recipientId = null,
    isRecurring = null, isExecuted = null, active = true,
  } = {}) {
    let sql = `
      SELECT pt.*,
             r.name AS recipient_name,
             CASE
               WHEN c.id IS NOT NULL THEN c.general || ':' || c.detail
               WHEN rc.id IS NOT NULL THEN rc.general || ':' || rc.detail
               ELSE NULL
             END AS category_name,
             (SELECT count(*) FROM planned_transaction_executions pte WHERE pte.planned_transaction_id = pt.id) AS execution_count
      FROM planned_transactions pt
      LEFT JOIN recipients r ON pt.recipient_id = r.id
      LEFT JOIN categories c ON pt.category_id = c.id
      LEFT JOIN categories rc ON r.default_category_id = rc.id
      WHERE 1=1
    `;
    const params = [];
    let paramIdx = 1;

    if (active) sql += ` AND pt.is_active = true`;
    if (startDate) { sql += ` AND pt.planned_date >= $${paramIdx++}`; params.push(startDate); }
    if (endDate) { sql += ` AND pt.planned_date <= $${paramIdx++}`; params.push(endDate); }
    if (bankAccount) { sql += ` AND pt.bank_account ILIKE $${paramIdx++}`; params.push(`%${bankAccount}%`); }
    if (categoryId != null) { sql += ` AND pt.category_id = $${paramIdx++}`; params.push(categoryId); }
    if (recipientId != null) { sql += ` AND pt.recipient_id = $${paramIdx++}`; params.push(recipientId); }
    if (isRecurring != null) { sql += ` AND pt.is_recurring = $${paramIdx++}`; params.push(isRecurring); }
    if (isExecuted != null) { sql += ` AND pt.is_executed = $${paramIdx++}`; params.push(isExecuted); }

    // Count query
    let countSql = sql.replace(/SELECT pt\.\*[\s\S]*?FROM/, 'SELECT count(*) FROM');
    const countResult = await query(countSql, params);
    const total = parseInt(countResult.rows[0].count, 10);

    sql += ` ORDER BY pt.planned_date DESC LIMIT $${paramIdx++} OFFSET $${paramIdx++}`;
    params.push(limit, offset);

    const result = await query(sql, params);

    // Fetch executions for each
    for (const row of result.rows) {
      const execResult = await query(
        `SELECT * FROM planned_transaction_executions WHERE planned_transaction_id = $1 ORDER BY execution_date DESC`,
        [row.id]
      );
      row.executions = execResult.rows;
      row.executed_transaction_id = execResult.rows.length > 0 ? execResult.rows[0].executed_transaction_id : null;
    }

    return { items: result.rows, total };
  },

  async getById(id) {
    const sql = `
      SELECT pt.*,
             r.name AS recipient_name,
             CASE
               WHEN c.id IS NOT NULL THEN c.general || ':' || c.detail
               WHEN rc.id IS NOT NULL THEN rc.general || ':' || rc.detail
               ELSE NULL
             END AS category_name
      FROM planned_transactions pt
      LEFT JOIN recipients r ON pt.recipient_id = r.id
      LEFT JOIN categories c ON pt.category_id = c.id
      LEFT JOIN categories rc ON r.default_category_id = rc.id
      WHERE pt.id = $1
    `;
    const result = await query(sql, [id]);
    if (result.rows.length === 0) return null;

    const row = result.rows[0];
    const execResult = await query(
      `SELECT * FROM planned_transaction_executions WHERE planned_transaction_id = $1 ORDER BY execution_date DESC`,
      [id]
    );
    row.executions = execResult.rows;
    row.execution_count = execResult.rows.length;
    row.executed_transaction_id = execResult.rows.length > 0 ? execResult.rows[0].executed_transaction_id : null;

    return row;
  },

  async create({ planned_date, bank_account, recipient_id, amount, memo, currency, category_id, comment, url, is_recurring, recurrence_pattern }) {
    const sql = `
      INSERT INTO planned_transactions (planned_date, bank_account, recipient_id, amount, memo, currency, category_id, comment, url, is_recurring, recurrence_pattern, is_executed, is_active)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, false, true)
      RETURNING *
    `;
    const params = [
      planned_date,
      bank_account ? bank_account.toUpperCase() : null,
      recipient_id, amount,
      memo ? memo.toUpperCase() : null,
      currency ? currency.toUpperCase() : null,
      category_id, comment, url || null,
      is_recurring || false,
      recurrence_pattern || null,
    ];
    const result = await query(sql, params);
    return this.getById(result.rows[0].id);
  },

  async update(id, fields) {
    const setClauses = [];
    const params = [];
    let paramIdx = 1;

    for (const [key, value] of Object.entries(fields)) {
      if (value === undefined) continue;
      setClauses.push(`${key} = $${paramIdx++}`);
      params.push(value);
    }

    if (setClauses.length === 0) return this.getById(id);

    setClauses.push(`updated_at = NOW()`);
    params.push(id);
    const sql = `UPDATE planned_transactions SET ${setClauses.join(', ')} WHERE id = $${paramIdx} RETURNING *`;
    await query(sql, params);
    return this.getById(id);
  },

  async hardDelete(id) {
    const result = await query('DELETE FROM planned_transactions WHERE id = $1', [id]);
    return result.rowCount > 0;
  },

  async addExecution(plannedTransactionId, executedTransactionId, executionDate) {
    await query(
      `INSERT INTO planned_transaction_executions (planned_transaction_id, executed_transaction_id, execution_date)
       VALUES ($1, $2, $3)`,
      [plannedTransactionId, executedTransactionId, executionDate || new Date().toISOString().split('T')[0]]
    );
  },
};

export default plannedTransactionRepository;
