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
  async getPlannedExpensesNextMonth() {
    // Calculate next month boundaries
    const now = new Date();
    const nextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    const monthAfter = new Date(now.getFullYear(), now.getMonth() + 2, 1);
    const lastDay = new Date(monthAfter - 1);

    const sql = `
      SELECT pt.*, r.name AS recipient_name,
             CASE
               WHEN c.id IS NOT NULL THEN c.general || ':' || c.detail
               ELSE NULL
             END AS category_name
      FROM planned_transactions pt
      LEFT JOIN recipients r ON pt.recipient_id = r.id
      LEFT JOIN categories c ON pt.category_id = c.id
      WHERE pt.is_active = true
        AND (
          (pt.is_recurring = true)
          OR (pt.planned_date >= $1 AND pt.planned_date < $2)
        )
      ORDER BY pt.planned_date ASC
    `;

    const result = await query(sql, [
      nextMonth.toISOString().split('T')[0],
      monthAfter.toISOString().split('T')[0],
    ]);

    // Group by date
    const dailyMap = {};
    for (const row of result.rows) {
      const dateStr = row.planned_date instanceof Date
        ? row.planned_date.toISOString().split('T')[0]
        : String(row.planned_date);
      if (!dailyMap[dateStr]) {
        dailyMap[dateStr] = { date: dateStr, total_income: 0, total_expenses: 0, transactions: [] };
      }
      const amt = parseFloat(row.amount);
      if (amt >= 0) dailyMap[dateStr].total_income += amt;
      else dailyMap[dateStr].total_expenses += amt;
      dailyMap[dateStr].transactions.push({
        id: row.id,
        recipient_name: row.recipient_name,
        amount: amt,
        category_name: row.category_name,
        is_recurring: row.is_recurring,
        recurrence_pattern: row.recurrence_pattern,
      });
    }

    const dailyData = Object.values(dailyMap).sort((a, b) => a.date.localeCompare(b.date));

    const totalIncome = dailyData.reduce((s, d) => s + d.total_income, 0);
    const totalExpenses = dailyData.reduce((s, d) => s + d.total_expenses, 0);

    return {
      month: nextMonth.getMonth() + 1,
      year: nextMonth.getFullYear(),
      period_start: nextMonth.toISOString().split('T')[0],
      period_end: lastDay.toISOString().split('T')[0],
      daily_data: dailyData,
      summary: {
        total_income: totalIncome,
        total_expenses: totalExpenses,
        net_amount: totalIncome + totalExpenses,
        transaction_count: result.rows.length,
      },
    };
  },

  async getAverageVsCurrentSpending() {
    // Past 6 complete months average daily spending
    const sql6m = `
      WITH monthly AS (
        SELECT
          date_trunc('month', t.date) AS month,
          SUM(CASE WHEN t.amount < 0 THEN ABS(t.amount) ELSE 0 END) AS spending,
          COUNT(DISTINCT t.date) AS active_days
        FROM transactions t
        WHERE t.is_active = true
          AND t.date >= date_trunc('month', CURRENT_DATE) - interval '6 months'
          AND t.date < date_trunc('month', CURRENT_DATE)
        GROUP BY date_trunc('month', t.date)
      )
      SELECT
        AVG(spending / NULLIF(active_days, 0)) AS avg_daily_spending,
        AVG(spending) AS avg_monthly_spending,
        COUNT(*) AS months_counted
      FROM monthly
    `;
    const past6Result = await query(sql6m);
    const past6 = past6Result.rows[0];

    // Current month daily breakdown
    const sqlCurrent = `
      SELECT t.date,
             SUM(CASE WHEN t.amount < 0 THEN ABS(t.amount) ELSE 0 END) AS spending,
             SUM(CASE WHEN t.amount > 0 THEN t.amount ELSE 0 END) AS income
      FROM transactions t
      WHERE t.is_active = true
        AND t.date >= date_trunc('month', CURRENT_DATE)
        AND t.date <= CURRENT_DATE
      GROUP BY t.date
      ORDER BY t.date
    `;
    const currentResult = await query(sqlCurrent);

    const dailyData = currentResult.rows.map(r => ({
      date: r.date instanceof Date ? r.date.toISOString().split('T')[0] : String(r.date),
      spending: parseFloat(r.spending),
      income: parseFloat(r.income),
    }));

    const totalCurrentSpending = dailyData.reduce((s, d) => s + d.spending, 0);
    const daysElapsed = dailyData.length || 1;
    const avgDaily = parseFloat(past6.avg_daily_spending) || 0;
    const now = new Date();
    const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    const projectedTotal = (totalCurrentSpending / daysElapsed) * daysInMonth;

    return {
      past_6_months: {
        avg_daily_spending: avgDaily,
        avg_monthly_spending: parseFloat(past6.avg_monthly_spending) || 0,
        months_counted: parseInt(past6.months_counted, 10),
      },
      current_month: {
        daily_data: dailyData,
        total_spending: totalCurrentSpending,
        days_elapsed: daysElapsed,
        days_in_month: daysInMonth,
      },
      comparison: {
        projected_monthly_total: projectedTotal,
        avg_monthly_spending: parseFloat(past6.avg_monthly_spending) || 0,
        variance: projectedTotal - (parseFloat(past6.avg_monthly_spending) || 0),
        pace: avgDaily > 0 ? (totalCurrentSpending / daysElapsed) / avgDaily : null,
      },
    };
  },
};

export default infoRepository;
