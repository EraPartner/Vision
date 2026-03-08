/**
 * Portfolio Transaction Repository - data access for portfolio_transactions table.
 */

import { query } from '../database/connection.js';

export const portfolioTransactionRepository = {
  async getAll({ investmentId = null, type = null, limit = 200, offset = 0 } = {}) {
    let sql = `SELECT * FROM portfolio_transactions WHERE 1=1`;
    const params = [];
    let idx = 1;

    if (investmentId) { sql += ` AND investment_id = $${idx++}`; params.push(investmentId); }
    if (type) { sql += ` AND type = $${idx++}`; params.push(type); }

    sql += ` ORDER BY date DESC, id DESC LIMIT $${idx++} OFFSET $${idx++}`;
    params.push(limit, offset);

    const result = await query(sql, params);
    return result.rows;
  },

  async getCount({ investmentId = null, type = null } = {}) {
    let sql = `SELECT count(*) FROM portfolio_transactions WHERE 1=1`;
    const params = [];
    let idx = 1;

    if (investmentId) { sql += ` AND investment_id = $${idx++}`; params.push(investmentId); }
    if (type) { sql += ` AND type = $${idx++}`; params.push(type); }

    const result = await query(sql, params);
    return parseInt(result.rows[0].count, 10);
  },

  async getById(id) {
    const result = await query('SELECT * FROM portfolio_transactions WHERE id = $1', [id]);
    return result.rows[0] || null;
  },

  async create({ investment_id, type, date, amount, units, price_per_unit, fees, taxes, currency = 'EUR', note, is_recurring, recurrence_interval, recurrence_end_date }) {
    const result = await query(
      `INSERT INTO portfolio_transactions
       (investment_id, type, date, amount, units, price_per_unit, fees, taxes, currency, note, is_recurring, recurrence_interval, recurrence_end_date)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       RETURNING *`,
      [investment_id, type, date, amount, units || null, price_per_unit || null, fees || 0, taxes || 0, currency, note || null, is_recurring || false, recurrence_interval || null, recurrence_end_date || null]
    );
    return result.rows[0];
  },

  async update(id, fields) {
    const allowed = ['type', 'date', 'amount', 'units', 'price_per_unit', 'fees', 'taxes', 'currency', 'note', 'is_recurring', 'recurrence_interval', 'recurrence_end_date'];
    const setClauses = [];
    const params = [];
    let idx = 1;

    for (const [key, value] of Object.entries(fields)) {
      if (allowed.includes(key) && value !== undefined) {
        setClauses.push(`${key} = $${idx++}`);
        params.push(value);
      }
    }

    if (setClauses.length === 0) return this.getById(id);

    params.push(id);
    const sql = `UPDATE portfolio_transactions SET ${setClauses.join(', ')} WHERE id = $${idx} RETURNING *`;
    const result = await query(sql, params);
    return result.rows[0] || null;
  },

  async hardDelete(id) {
    const result = await query('DELETE FROM portfolio_transactions WHERE id = $1', [id]);
    return result.rowCount > 0;
  },

  /** Get summary stats for an investment */
  async getSummary(investmentId) {
    const result = await query(`
      SELECT
        type,
        SUM(amount) as total_amount,
        SUM(units) as total_units,
        SUM(fees) as total_fees,
        SUM(taxes) as total_taxes,
        COUNT(*) as count
      FROM portfolio_transactions
      WHERE investment_id = $1
      GROUP BY type
    `, [investmentId]);
    return result.rows;
  },
};

export default portfolioTransactionRepository;
