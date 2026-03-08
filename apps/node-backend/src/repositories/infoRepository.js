/**
 * Info/Statistics Repository - data access for statistics and reporting.
 *
 * Mirrors: apps/backend/repositories/info_repository.py
 */

import { query } from '../database/connection.js';

export const infoRepository = {
  async getStatistics() {
    const countResult = await query('SELECT count(*) FROM transactions WHERE is_active = true');
    const sumResult = await query('SELECT COALESCE(sum(amount), 0) as total FROM transactions WHERE is_active = true');
    const categoryResult = await query(`
      SELECT COALESCE(c.general || ':' || c.detail, 'UNCATEGORISED') AS name, count(*) AS count
      FROM transactions t
      LEFT JOIN recipients r ON t.recipient_id = r.id
      LEFT JOIN categories c ON COALESCE(t.category_id, r.default_category_id) = c.id
      WHERE t.is_active = true
      GROUP BY name
      ORDER BY count DESC
    `);

    return {
      total_transactions: parseInt(countResult.rows[0].count, 10),
      total_amount: parseFloat(sumResult.rows[0].total),
      categories: categoryResult.rows.map(r => ({ name: r.name, count: parseInt(r.count, 10) })),
    };
  },

  async getBanks() {
    const result = await query(
      `SELECT DISTINCT bank_account FROM transactions WHERE is_active = true AND bank_account IS NOT NULL ORDER BY bank_account`
    );
    return result.rows.map(r => r.bank_account);
  },

  async getTransactionCount() {
    const result = await query('SELECT count(*) FROM transactions WHERE is_active = true');
    return parseInt(result.rows[0].count, 10);
  },

  async getTransactionSummary({ bankAccount = null, startDate = null, endDate = null } = {}) {
    let sql = `
      SELECT count(*) AS total_count,
             COALESCE(sum(amount), 0) AS total_amount,
             COALESCE(avg(amount), 0) AS average,
             min(amount) AS min,
             max(amount) AS max
      FROM transactions
      WHERE is_active = true
    `;
    const params = [];
    let paramIdx = 1;

    if (bankAccount) { sql += ` AND bank_account ILIKE $${paramIdx++}`; params.push(`%${bankAccount}%`); }
    if (startDate) { sql += ` AND date >= $${paramIdx++}`; params.push(startDate); }
    if (endDate) { sql += ` AND date <= $${paramIdx++}`; params.push(endDate); }

    const result = await query(sql, params);
    const row = result.rows[0];
    return {
      total_count: parseInt(row.total_count, 10),
      total_amount: parseFloat(row.total_amount),
      average: parseFloat(row.average),
      min: row.min != null ? parseFloat(row.min) : null,
      max: row.max != null ? parseFloat(row.max) : null,
    };
  },

  async getMonthlyFinancialSummary(excludedCategoryIds = [9, 22]) {
    const excludeClause = excludedCategoryIds.length > 0
      ? `AND COALESCE(t.category_id, r.default_category_id) NOT IN (${excludedCategoryIds.join(',')})`
      : '';

    const sql = `
      WITH months AS (
        SELECT generate_series(
          date_trunc('month', CURRENT_DATE - interval '5 months'),
          date_trunc('month', CURRENT_DATE),
          interval '1 month'
        )::date AS month_start
      )
      SELECT
        EXTRACT(MONTH FROM m.month_start)::int AS month,
        EXTRACT(YEAR FROM m.month_start)::int AS year,
        m.month_start AS period_start,
        (m.month_start + interval '1 month' - interval '1 day')::date AS period_end,
        COALESCE(SUM(CASE WHEN t.amount < 0 THEN t.amount ELSE 0 END), 0) AS total_spending,
        COALESCE(SUM(CASE WHEN t.amount > 0 THEN t.amount ELSE 0 END), 0) AS total_income,
        COALESCE(SUM(t.amount), 0) AS net_amount,
        COUNT(t.id)::int AS transaction_count
      FROM months m
      LEFT JOIN transactions t ON t.date >= m.month_start
        AND t.date < m.month_start + interval '1 month'
        AND t.is_active = true
        ${excludeClause}
      LEFT JOIN recipients r ON t.recipient_id = r.id
      GROUP BY m.month_start
      ORDER BY m.month_start
    `;
    const result = await query(sql);

    const months = result.rows.map(r => ({
      month: r.month,
      year: r.year,
      period_start: r.period_start,
      period_end: r.period_end,
      total_spending: parseFloat(r.total_spending),
      total_income: parseFloat(r.total_income),
      net_amount: parseFloat(r.net_amount),
      transaction_count: r.transaction_count,
    }));

    const summary = {
      total_spending: months.reduce((s, m) => s + m.total_spending, 0),
      total_income: months.reduce((s, m) => s + m.total_income, 0),
      net_amount: months.reduce((s, m) => s + m.net_amount, 0),
      transaction_count: months.reduce((s, m) => s + m.transaction_count, 0),
      period_start: months[0]?.period_start,
      period_end: months[months.length - 1]?.period_end,
    };

    return { months, summary };
  },
};

export default infoRepository;
