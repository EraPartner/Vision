/**
 * Info/Statistics Repository - data access for statistics and reporting.
 *
 * Uses materialized views (mv_*) for pre-computed aggregates when possible,
 * falling back to live queries for filtered / parameterised requests.
 *
 * All monetary aggregations convert amounts to EUR using the currency
 * conversion service, matching the Python backend behaviour.
 */

import { query } from '../database/connection.js';
import { convertToEur } from '../services/currencyConversionService.js';
import { logger } from '../config/logger.js';

/**
 * Helper: check if a materialized view exists and has rows.
 * Returns false if the view doesn't exist (first startup before schema init).
 */
async function mvAvailable(viewName) {
  try {
    const r = await query(`SELECT 1 FROM ${viewName} LIMIT 1`);
    return r.rows.length > 0;
  } catch {
    return false;
  }
}

export const infoRepository = {
  async getStatistics() {
    // ── Fast path: read from materialized views ──
    if (await mvAvailable('mv_category_totals')) {
      const countResult = await query('SELECT count(*) FROM transactions WHERE is_active = true');

      // Category totals from MV (already grouped)
      const catResult = await query('SELECT * FROM mv_category_totals ORDER BY count DESC');
      const categories = [];
      let totalEur = 0;

      for (const row of catResult.rows) {
        const total = parseFloat(row.total || 0);
        const eur = await convertToEur(total, row.currency, new Date().toISOString().split('T')[0]);
        totalEur += eur;
        // Merge same category across currencies
        const existing = categories.find(c => c.id === (row.category_id === -1 ? null : row.category_id));
        if (existing) {
          existing.count += parseInt(row.count, 10);
          existing.total += Math.round(eur * 100) / 100;
        } else {
          categories.push({
            id: row.category_id === -1 ? null : parseInt(row.category_id, 10),
            name: row.name,
            count: parseInt(row.count, 10),
            total: Math.round(eur * 100) / 100,
          });
        }
      }

      return {
        total_transactions: parseInt(countResult.rows[0].count, 10),
        total_amount: Math.round(totalEur * 100) / 100,
        categories,
      };
    }

    // ── Fallback: live query ──
    const countResult = await query('SELECT count(*) FROM transactions WHERE is_active = true');

    const txResult = await query(`
      SELECT t.amount, t.currency, t.date
      FROM transactions t
      WHERE t.is_active = true
    `);

    let totalEur = 0;
    for (const row of txResult.rows) {
      const amt = parseFloat(row.amount);
      const dateStr = row.date instanceof Date ? row.date.toISOString().split('T')[0] : row.date;
      totalEur += await convertToEur(amt, row.currency, dateStr);
    }

    const categoryAmountResult = await query(`
      SELECT COALESCE(c.id, -1) AS category_id,
             COALESCE(c.general || ':' || c.detail, 'UNCATEGORISED') AS name,
             t.amount,
             t.currency,
             t.date
      FROM transactions t
      LEFT JOIN recipients r ON t.recipient_id = r.id
      LEFT JOIN categories c ON COALESCE(t.category_id, r.default_category_id) = c.id
      WHERE t.is_active = true
    `);

    const categories = [];
    const catMap = {};
    for (const row of categoryAmountResult.rows) {
      const catId = row.category_id === -1 ? null : parseInt(row.category_id, 10);
      const amt = parseFloat(row.amount);
      const dateStr = row.date instanceof Date ? row.date.toISOString().split('T')[0] : row.date;
      const eur = await convertToEur(amt, row.currency, dateStr);
      const key = catId ?? 'null';
      if (!catMap[key]) {
        catMap[key] = { id: catId, name: row.name, count: 0, total: 0 };
      }
      catMap[key].count++;
      catMap[key].total += eur;
    }
    for (const cat of Object.values(catMap)) {
      categories.push({ ...cat, total: Math.round(cat.total * 100) / 100 });
    }
    categories.sort((a, b) => b.count - a.count);

    return {
      total_transactions: parseInt(countResult.rows[0].count, 10),
      total_amount: Math.round(totalEur * 100) / 100,
      categories,
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
      SELECT t.amount, t.currency, t.date
      FROM transactions t
      WHERE t.is_active = true
    `;
    const params = [];
    let paramIdx = 1;

    if (bankAccount) { sql += ` AND t.bank_account ILIKE $${paramIdx++}`; params.push(`%${bankAccount}%`); }
    if (startDate) { sql += ` AND t.date >= $${paramIdx++}`; params.push(startDate); }
    if (endDate) { sql += ` AND t.date <= $${paramIdx++}`; params.push(endDate); }

    const result = await query(sql, params);

    if (result.rows.length === 0) {
      return { total_count: 0, total_amount: 0, average: 0, min: null, max: null };
    }

    let total = 0;
    let min = Infinity;
    let max = -Infinity;
    for (const row of result.rows) {
      const amt = parseFloat(row.amount);
      const dateStr = row.date instanceof Date ? row.date.toISOString().split('T')[0] : row.date;
      const eur = await convertToEur(amt, row.currency, dateStr);
      total += eur;
      if (eur < min) min = eur;
      if (eur > max) max = eur;
    }

    const count = result.rows.length;
    return {
      total_count: count,
      total_amount: Math.round(total * 100) / 100,
      average: Math.round((total / count) * 100) / 100,
      min: Math.round(min * 100) / 100,
      max: Math.round(max * 100) / 100,
    };
  },

  async getMonthlyFinancialSummary(excludedCategoryIds = [9, 22]) {
    const validIds = excludedCategoryIds.filter(id => Number.isInteger(id) && id > 0 && id < 2147483647);
    logger.debug('getMonthlyFinancialSummary called', { excludedCategoryIds, validIds });

    // ── Fast path: read from mv_monthly_summary ──
    if (validIds.length === 0 && await mvAvailable('mv_monthly_summary')) {
      const mvResult = await query(`
        SELECT month_start, month, year, currency,
               SUM(transaction_count) AS transaction_count,
               SUM(total_income) AS total_income,
               SUM(total_spending) AS total_spending,
               SUM(net_amount) AS net_amount
        FROM mv_monthly_summary
        WHERE month_start >= date_trunc('month', CURRENT_DATE - interval '5 months')
        GROUP BY month_start, month, year, currency
        ORDER BY month_start
      `);

      const monthMap = {};
      for (const row of mvResult.rows) {
        const key = `${row.year}-${String(row.month).padStart(2, '0')}`;
        if (!monthMap[key]) {
          monthMap[key] = {
            month: row.month, year: row.year,
            period_start: row.month_start,
            period_end: null,
            total_spending: 0, total_income: 0, net_amount: 0, transaction_count: 0,
          };
        }
        const dateStr = row.month_start instanceof Date ? row.month_start.toISOString().split('T')[0] : String(row.month_start);
        const income = await convertToEur(parseFloat(row.total_income), row.currency, dateStr);
        const spending = await convertToEur(parseFloat(row.total_spending), row.currency, dateStr);

        monthMap[key].total_income += income;
        monthMap[key].total_spending += spending;
        monthMap[key].net_amount += income + spending;
        monthMap[key].transaction_count += parseInt(row.transaction_count, 10);
      }

      const months = Object.values(monthMap)
        .sort((a, b) => a.year !== b.year ? a.year - b.year : a.month - b.month)
        .map(m => ({
          ...m,
          period_end: new Date(m.year, m.month, 0).toISOString().split('T')[0],
          total_spending: Math.round(m.total_spending * 100) / 100,
          total_income: Math.round(m.total_income * 100) / 100,
          net_amount: Math.round(m.net_amount * 100) / 100,
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
    }

    // ── Fallback: live query with exclusions ──
    const excludeClause = validIds.length > 0
      ? `AND COALESCE(t.category_id, r.default_category_id) NOT IN (${validIds.map((_, i) => `$${i + 1}`).join(',')})`
      : '';

    const sql = `
      WITH months AS (
        SELECT generate_series(
          date_trunc('month', CURRENT_DATE - interval '5 months'),
          date_trunc('month', CURRENT_DATE),
          interval '1 month'
        )::date AS month_start
      ),
      filtered_transactions AS (
        SELECT
          t.id,
          t.amount,
          t.currency,
          t.date,
          COALESCE(t.category_id, r.default_category_id) AS effective_category_id
        FROM transactions t
        LEFT JOIN recipients r ON t.recipient_id = r.id
        WHERE t.is_active = true
        ${excludeClause}
      )
      SELECT
        EXTRACT(MONTH FROM m.month_start)::int AS month,
        EXTRACT(YEAR FROM m.month_start)::int AS year,
        m.month_start AS period_start,
        (m.month_start + interval '1 month' - interval '1 day')::date AS period_end,
        t.amount, t.currency, t.date, t.id AS txn_id
      FROM months m
      LEFT JOIN filtered_transactions t ON t.date >= m.month_start
        AND t.date < m.month_start + interval '1 month'
      ORDER BY m.month_start, t.date
    `;
    logger.debug('Monthly summary SQL executing', { excludeClause: excludeClause || '(none)', paramCount: validIds.length });
    const result = await query(sql, validIds);
    logger.debug('Monthly summary query returned', { rowCount: result.rows.length });

    // Group by month and convert amounts
    const monthMap = {};
    for (const row of result.rows) {
      const key = `${row.year}-${String(row.month).padStart(2, '0')}`;
      if (!monthMap[key]) {
        monthMap[key] = {
          month: row.month,
          year: row.year,
          period_start: row.period_start,
          period_end: row.period_end,
          total_spending: 0,
          total_income: 0,
          net_amount: 0,
          transaction_count: 0,
        };
      }
      if (row.txn_id == null) continue;

      const amt = parseFloat(row.amount);
      const dateStr = row.date instanceof Date ? row.date.toISOString().split('T')[0] : row.date;
      const eur = await convertToEur(amt, row.currency, dateStr);

      monthMap[key].transaction_count++;
      monthMap[key].net_amount += eur;
      if (eur < 0) monthMap[key].total_spending += eur;
      else monthMap[key].total_income += eur;
    }

    const months = Object.values(monthMap)
      .sort((a, b) => {
        if (a.year !== b.year) return a.year - b.year;
        return a.month - b.month;
      })
      .map(m => ({
        ...m,
        total_spending: Math.round(m.total_spending * 100) / 100,
        total_income: Math.round(m.total_income * 100) / 100,
        net_amount: Math.round(m.net_amount * 100) / 100,
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

    // Group by date, converting amounts to EUR
    const dailyMap = {};
    for (const row of result.rows) {
      const dateStr = row.planned_date instanceof Date
        ? row.planned_date.toISOString().split('T')[0]
        : String(row.planned_date);
      if (!dailyMap[dateStr]) {
        dailyMap[dateStr] = { date: dateStr, total_income: 0, total_expenses: 0, transactions: [] };
      }
      const amt = parseFloat(row.amount);
      const eur = await convertToEur(amt, row.currency, dateStr);
      if (eur >= 0) dailyMap[dateStr].total_income += eur;
      else dailyMap[dateStr].total_expenses += eur;
      dailyMap[dateStr].transactions.push({
        id: row.id,
        recipient_name: row.recipient_name,
        amount: Math.round(eur * 100) / 100,
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
        total_income: Math.round(totalIncome * 100) / 100,
        total_expenses: Math.round(totalExpenses * 100) / 100,
        net_amount: Math.round((totalIncome + totalExpenses) * 100) / 100,
        transaction_count: result.rows.length,
      },
    };
  },

  async getAverageVsCurrentSpending() {
    // Past 6 complete months — fetch raw amounts with currency for conversion
    const sql6m = `
      SELECT t.amount, t.currency, t.date
      FROM transactions t
      WHERE t.is_active = true
        AND t.date >= date_trunc('month', CURRENT_DATE) - interval '6 months'
        AND t.date < date_trunc('month', CURRENT_DATE)
    `;
    const past6Result = await query(sql6m);

    // Convert and group by month
    const monthlySpending = {};
    const monthlyDays = {};
    for (const row of past6Result.rows) {
      const amt = parseFloat(row.amount);
      const dateStr = row.date instanceof Date ? row.date.toISOString().split('T')[0] : row.date;
      const eur = await convertToEur(amt, row.currency, dateStr);
      const monthKey = dateStr.substring(0, 7);
      if (!monthlySpending[monthKey]) { monthlySpending[monthKey] = 0; monthlyDays[monthKey] = new Set(); }
      if (eur < 0) monthlySpending[monthKey] += Math.abs(eur);
      monthlyDays[monthKey].add(dateStr);
    }

    const monthKeys = Object.keys(monthlySpending);
    const monthsCount = monthKeys.length || 1;
    const totalMonthlySpending = monthKeys.reduce((s, k) => s + monthlySpending[k], 0);
    const avgMonthlySpending = totalMonthlySpending / monthsCount;
    const totalDays = monthKeys.reduce((s, k) => s + monthlyDays[k].size, 0) || 1;
    const avgDailySpending = totalMonthlySpending / totalDays;

    // Current month daily breakdown
    const sqlCurrent = `
      SELECT t.amount, t.currency, t.date
      FROM transactions t
      WHERE t.is_active = true
        AND t.date >= date_trunc('month', CURRENT_DATE)
        AND t.date <= CURRENT_DATE
    `;
    const currentResult = await query(sqlCurrent);

    const dailyMap = {};
    for (const row of currentResult.rows) {
      const amt = parseFloat(row.amount);
      const dateStr = row.date instanceof Date ? row.date.toISOString().split('T')[0] : row.date;
      const eur = await convertToEur(amt, row.currency, dateStr);
      if (!dailyMap[dateStr]) dailyMap[dateStr] = { spending: 0, income: 0 };
      if (eur < 0) dailyMap[dateStr].spending += Math.abs(eur);
      else dailyMap[dateStr].income += eur;
    }

    const dailyData = Object.entries(dailyMap)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, d]) => ({
        date,
        spending: Math.round(d.spending * 100) / 100,
        income: Math.round(d.income * 100) / 100,
      }));

    const totalCurrentSpending = dailyData.reduce((s, d) => s + d.spending, 0);
    const daysElapsed = dailyData.length || 1;
    const now = new Date();
    const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    const projectedTotal = (totalCurrentSpending / daysElapsed) * daysInMonth;

    return {
      past_6_months: {
        avg_daily_spending: Math.round(avgDailySpending * 100) / 100,
        avg_monthly_spending: Math.round(avgMonthlySpending * 100) / 100,
        months_counted: monthsCount,
      },
      current_month: {
        daily_data: dailyData,
        total_spending: Math.round(totalCurrentSpending * 100) / 100,
        days_elapsed: daysElapsed,
        days_in_month: daysInMonth,
      },
      comparison: {
        projected_monthly_total: Math.round(projectedTotal * 100) / 100,
        avg_monthly_spending: Math.round(avgMonthlySpending * 100) / 100,
        variance: Math.round((projectedTotal - avgMonthlySpending) * 100) / 100,
        pace: avgDailySpending > 0 ? Math.round(((totalCurrentSpending / daysElapsed) / avgDailySpending) * 100) / 100 : null,
      },
    };
  },

  /**
   * Cashflow comparison: cumulative daily net cash flow.
   * Returns average of last 6 months (day 1-31) and current month (day 1-today).
   * Two variants: with and without planned expenses.
   *
   * Note: This query operates on daily aggregates where mixed-currency sums
   * within a single day are rare. For simplicity the SQL aggregation is kept
   * as-is (amounts are in the DB's predominant currency, typically EUR).
   * Full per-row conversion would require fetching all raw rows which is
   * expensive for this endpoint. If multi-currency accuracy is critical here,
   * this can be refactored later.
   */
  async getCashflowComparison(excludedCategoryIds = []) {
    const now = new Date();
    const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    const currentDay = now.getDate();

    const validIds = excludedCategoryIds.filter(id => Number.isInteger(id) && id > 0 && id < 2147483647);

    // Build category exclusion clause
    let categoryExclusionJoin = '';
    let categoryExclusionWhere = '';
    const excludeParams = [];
    if (validIds.length > 0) {
      categoryExclusionJoin = `
        LEFT JOIN recipients r ON t.recipient_id = r.id
        LEFT JOIN recipients pr ON r.primary_recipient_id = pr.id
      `;
      const placeholders = validIds.map((_, i) => `$${i + 1}`).join(', ');
      categoryExclusionWhere = `
        AND COALESCE(t.category_id, r.default_category_id, pr.default_category_id) IS DISTINCT FROM ALL(ARRAY[${placeholders}])
      `;
      excludeParams.push(...validIds);
    }

    // --- 1. Average daily cumulative from last 6 complete months (with EUR conversion) ---
    const sqlPast = `
      SELECT t.amount, t.currency, t.date,
             EXTRACT(DAY FROM t.date)::int AS day_of_month,
             TO_CHAR(date_trunc('month', t.date), 'YYYY-MM') AS month_key
      FROM transactions t
      ${categoryExclusionJoin}
      WHERE t.is_active = true
        AND t.date >= date_trunc('month', CURRENT_DATE) - interval '6 months'
        AND t.date < date_trunc('month', CURRENT_DATE)
        ${categoryExclusionWhere}
    `;
    const pastResult = await query(sqlPast, excludeParams);

    // Convert each row and group by month+day
    const monthDayNet = {}; // { monthKey: { day: netEur } }
    for (const row of pastResult.rows) {
      const amt = parseFloat(row.amount);
      const dateStr = row.date instanceof Date ? row.date.toISOString().split('T')[0] : row.date;
      const eur = await convertToEur(amt, row.currency, dateStr);
      const mk = row.month_key;
      if (!monthDayNet[mk]) monthDayNet[mk] = {};
      monthDayNet[mk][row.day_of_month] = (monthDayNet[mk][row.day_of_month] || 0) + eur;
    }

    // Build cumulative per month, then average across months
    const monthKeys = Object.keys(monthDayNet);
    const monthCount = monthKeys.length || 1;
    const avgCumulativeByDay = {};
    for (const mk of monthKeys) {
      const dayNet = monthDayNet[mk];
      const days = Object.keys(dayNet).map(Number).sort((a, b) => a - b);
      let cum = 0;
      const cumByDay = {};
      for (const d of days) {
        cum += dayNet[d];
        cumByDay[d] = cum;
      }
      // Fill forward for missing days
      let last = 0;
      for (let d = 1; d <= 31; d++) {
        if (cumByDay[d] !== undefined) last = cumByDay[d];
        else cumByDay[d] = last;
        avgCumulativeByDay[d] = (avgCumulativeByDay[d] || 0) + cumByDay[d];
      }
    }
    for (const d of Object.keys(avgCumulativeByDay)) {
      avgCumulativeByDay[d] /= monthCount;
    }

    // --- 2. Current month daily cumulative (with EUR conversion) ---
    const sqlCurrent = `
      SELECT t.amount, t.currency, t.date,
             EXTRACT(DAY FROM t.date)::int AS day_of_month
      FROM transactions t
      ${categoryExclusionJoin}
      WHERE t.is_active = true
        AND t.date >= date_trunc('month', CURRENT_DATE)
        AND t.date <= CURRENT_DATE
        ${categoryExclusionWhere}
    `;
    const currentResult = await query(sqlCurrent, excludeParams);

    const currentDayNet = {};
    for (const row of currentResult.rows) {
      const amt = parseFloat(row.amount);
      const dateStr = row.date instanceof Date ? row.date.toISOString().split('T')[0] : row.date;
      const eur = await convertToEur(amt, row.currency, dateStr);
      const d = row.day_of_month;
      currentDayNet[d] = (currentDayNet[d] || 0) + eur;
    }

    let currentCumulative = 0;
    const currentByDay = {};
    for (let d = 1; d <= currentDay; d++) {
      currentCumulative += (currentDayNet[d] || 0);
      currentByDay[d] = currentCumulative;
    }

    // --- 3. Planned expenses for current month (with EUR conversion) ---
    const sqlPlanned = `
      SELECT pt.amount, pt.currency, pt.planned_date,
             EXTRACT(DAY FROM pt.planned_date)::int AS day_of_month
      FROM planned_transactions pt
      WHERE pt.is_active = true
        AND pt.planned_date >= date_trunc('month', CURRENT_DATE)
        AND pt.planned_date <= (date_trunc('month', CURRENT_DATE) + interval '1 month' - interval '1 day')
    `;
    const plannedResult = await query(sqlPlanned);

    const plannedByDay = {};
    for (const row of plannedResult.rows) {
      const amt = parseFloat(row.amount);
      const dateStr = row.planned_date instanceof Date ? row.planned_date.toISOString().split('T')[0] : String(row.planned_date);
      const eur = await convertToEur(amt, row.currency, dateStr);
      const d = row.day_of_month;
      plannedByDay[d] = (plannedByDay[d] || 0) + eur;
    }

    // --- 4. Historical planned impact on past 6 months (with EUR conversion) ---
    const sqlPlannedHist = `
      SELECT pt.amount, pt.currency, pt.planned_date,
             EXTRACT(DAY FROM pt.planned_date)::int AS day_of_month,
             TO_CHAR(date_trunc('month', pt.planned_date), 'YYYY-MM') AS month_key
      FROM planned_transactions pt
      WHERE pt.is_active = true
        AND pt.planned_date >= date_trunc('month', CURRENT_DATE) - interval '6 months'
        AND pt.planned_date < date_trunc('month', CURRENT_DATE)
    `;
    const plannedHistResult = await query(sqlPlannedHist);

    const plannedHistMonthDay = {};
    for (const row of plannedHistResult.rows) {
      const amt = parseFloat(row.amount);
      const dateStr = row.planned_date instanceof Date ? row.planned_date.toISOString().split('T')[0] : String(row.planned_date);
      const eur = await convertToEur(amt, row.currency, dateStr);
      const mk = row.month_key;
      if (!plannedHistMonthDay[mk]) plannedHistMonthDay[mk] = {};
      plannedHistMonthDay[mk][row.day_of_month] = (plannedHistMonthDay[mk][row.day_of_month] || 0) + eur;
    }

    const plannedHistMonthCount = Object.keys(plannedHistMonthDay).length || 1;
    const avgPlannedCumByDay = {};
    for (const mk of Object.keys(plannedHistMonthDay)) {
      const dayNet = plannedHistMonthDay[mk];
      const days = Object.keys(dayNet).map(Number).sort((a, b) => a - b);
      let cum = 0;
      for (const d of days) {
        cum += dayNet[d];
        avgPlannedCumByDay[d] = (avgPlannedCumByDay[d] || 0) + cum;
      }
    }
    for (const d of Object.keys(avgPlannedCumByDay)) {
      avgPlannedCumByDay[d] /= plannedHistMonthCount;
    }

    // --- Build response ---
    const withoutPlanned = [];
    const withPlanned = [];
    let lastAvg = 0;
    let lastCurrent = null;
    let plannedCumulative = 0;

    for (let day = 1; day <= daysInMonth; day++) {
      const avgVal = avgCumulativeByDay[day] !== undefined ? avgCumulativeByDay[day] : lastAvg;
      lastAvg = avgVal;

      const currentVal = day <= currentDay ? (currentByDay[day] !== undefined ? currentByDay[day] : (lastCurrent !== null ? lastCurrent : 0)) : null;
      if (currentVal !== null) lastCurrent = currentVal;

      withoutPlanned.push({
        day,
        average: Math.round(avgVal * 100) / 100,
        current: currentVal !== null ? Math.round(currentVal * 100) / 100 : null,
      });

      // With planned
      const plannedHistVal = avgPlannedCumByDay[day] || 0;
      const avgWithPlanned = avgVal + plannedHistVal;

      plannedCumulative += (plannedByDay[day] || 0);
      const currentWithPlanned = currentVal !== null ? currentVal + plannedCumulative : null;

      withPlanned.push({
        day,
        average: Math.round(avgWithPlanned * 100) / 100,
        current: currentWithPlanned !== null ? Math.round(currentWithPlanned * 100) / 100 : null,
      });
    }

    return {
      days_in_month: daysInMonth,
      current_day: currentDay,
      month: now.getMonth() + 1,
      year: now.getFullYear(),
      without_planned: withoutPlanned,
      with_planned: withPlanned,
    };
  },

  /**
   * Get current balance per bank account and monthly historical balances.
   * Uses the balance field from the single most recent transaction (by date)
   * per bank account, matching the old Python backend behavior.
   */
  async getBankBalances() {
    const accounts = [];
    let totalNetPosition = 0;

    // For each bank account, get the balance from the single latest transaction by date
    const latestBalanceResult = await query(`
      SELECT DISTINCT ON (bank_account)
             bank_account,
             COALESCE(currency, 'EUR') AS currency,
             balance,
             date,
             COUNT(*) OVER (PARTITION BY bank_account) AS transaction_count,
             MIN(date) OVER (PARTITION BY bank_account) AS first_transaction,
             MAX(date) OVER (PARTITION BY bank_account) AS last_transaction
      FROM transactions
      WHERE is_active = true
        AND bank_account IS NOT NULL
        AND balance IS NOT NULL
      ORDER BY bank_account, date DESC, id DESC
    `);

    for (const row of latestBalanceResult.rows) {
      const dateStr = row.date instanceof Date ? row.date.toISOString().split('T')[0] : row.date;
      const currency = row.currency || 'EUR';
      const eur = await convertToEur(parseFloat(row.balance), currency, dateStr);
      const balance = Math.round(eur * 100) / 100;

      accounts.push({
        bank_account: row.bank_account,
        balance,
        transaction_count: parseInt(row.transaction_count, 10),
        first_transaction: row.first_transaction,
        last_transaction: row.last_transaction,
      });
      totalNetPosition += balance;
    }

    // Historical monthly balances — use the single latest transaction per account at end of each month
    const historyResult = await query(`
      WITH months AS (
        SELECT generate_series(
          date_trunc('month', CURRENT_DATE - interval '11 months'),
          date_trunc('month', CURRENT_DATE),
          interval '1 month'
        )::date AS month_start
      ),
      account_list AS (
        SELECT DISTINCT bank_account
        FROM transactions
        WHERE is_active = true AND bank_account IS NOT NULL
      ),
      ranked AS (
        SELECT
          a.bank_account,
          m.month_start,
          COALESCE(t.currency, 'EUR') AS currency,
          t.balance,
          t.date,
          ROW_NUMBER() OVER (
            PARTITION BY a.bank_account, m.month_start
            ORDER BY t.date DESC, t.id DESC
          ) AS rn
        FROM months m
        CROSS JOIN account_list a
        LEFT JOIN transactions t ON t.bank_account = a.bank_account
          AND t.date <= (m.month_start + interval '1 month' - interval '1 day')::date
          AND t.is_active = true
          AND t.balance IS NOT NULL
      )
      SELECT bank_account, month_start, currency, balance, date
      FROM ranked
      WHERE rn = 1 AND balance IS NOT NULL
      ORDER BY bank_account, month_start
    `);

    // Group monthly history by account, converting to EUR
    const historyMap = {};
    for (const row of historyResult.rows) {
      if (!row.bank_account) continue;
      const key = row.bank_account;
      if (!historyMap[key]) historyMap[key] = [];

      const currency = row.currency || 'EUR';
      const monthStr = row.month_start instanceof Date
        ? row.month_start.toISOString().split('T')[0]
        : row.month_start;
      const dateForRate = row.date instanceof Date ? row.date.toISOString().split('T')[0] : (row.date || monthStr);

      const eur = await convertToEur(parseFloat(row.balance), currency, dateForRate);

      const monthKey = monthStr.substring(0, 7);
      historyMap[key].push({ month: monthKey, balance: Math.round(eur * 100) / 100 });
    }

    // Sort each account's history
    for (const key of Object.keys(historyMap)) {
      historyMap[key].sort((a, b) => a.month.localeCompare(b.month));
    }

    // Also compute total net position history
    const totalHistory = [];
    const allMonths = [...new Set(Object.values(historyMap).flat().map(h => h.month))].sort();
    for (const month of allMonths) {
      let total = 0;
      for (const acct of Object.values(historyMap)) {
        const entry = acct.find(h => h.month === month);
        if (entry) total += entry.balance;
      }
      totalHistory.push({ month, balance: Math.round(total * 100) / 100 });
    }

    return {
      accounts,
      total_net_position: Math.round(totalNetPosition * 100) / 100,
      history: historyMap,
      total_history: totalHistory,
    };
  },

  /**
   * Net Worth — combines liquid assets (bank balances) + investments (portfolio)
   * into monthly snapshots over time.
   */
  async getNetWorth() {
    // 1. Get bank balance history (reuse existing method)
    const bankData = await this.getBankBalances();
    const bankHistory = bankData.total_history || []; // [{month, balance}]

    // 2. Compute portfolio value history from portfolio transactions
    // For each month, calculate the cumulative invested + income value
    const portfolioSql = `
      WITH months AS (
        SELECT generate_series(
          LEAST(
            (SELECT MIN(date_trunc('month', date)) FROM portfolio_transactions),
            date_trunc('month', CURRENT_DATE) - interval '11 months'
          ),
          date_trunc('month', CURRENT_DATE),
          interval '1 month'
        )::date AS month_start
      )
      SELECT
        to_char(m.month_start, 'YYYY-MM') AS month,
        COALESCE(SUM(CASE WHEN pt.type = 'buy' THEN pt.amount ELSE 0 END), 0) AS cum_buys,
        COALESCE(SUM(CASE WHEN pt.type = 'sell' THEN pt.amount ELSE 0 END), 0) AS cum_sells,
        COALESCE(SUM(CASE WHEN pt.type IN ('dividend','interest','rent_income') THEN pt.amount ELSE 0 END), 0) AS cum_income,
        COALESCE(SUM(CASE WHEN pt.type = 'appreciation' THEN pt.amount ELSE 0 END), 0) AS cum_appreciation,
        COALESCE(SUM(CASE WHEN pt.type = 'fee' THEN pt.amount ELSE 0 END), 0) AS cum_fees,
        COALESCE(SUM(CASE WHEN pt.type = 'tax' THEN pt.amount ELSE 0 END), 0) AS cum_taxes
      FROM months m
      LEFT JOIN portfolio_transactions pt ON pt.date <= (m.month_start + interval '1 month' - interval '1 day')::date
      GROUP BY m.month_start
      ORDER BY m.month_start
    `;

    const portfolioResult = await query(portfolioSql);

    // Build portfolio value per month (invested - sells + income + appreciation - fees - taxes)
    const portfolioByMonth = {};
    for (const row of portfolioResult.rows) {
      const invested = parseFloat(row.cum_buys) - parseFloat(row.cum_sells);
      const income = parseFloat(row.cum_income);
      const appreciation = parseFloat(row.cum_appreciation);
      const costs = parseFloat(row.cum_fees) + parseFloat(row.cum_taxes);
      portfolioByMonth[row.month] = Math.round((invested + income + appreciation - costs) * 100) / 100;
    }

    // 3. Get current portfolio market value for the latest month
    // (uses current_price * units for market-priced assets)
    const currentValueSql = `
      SELECT
        i.id, i.asset_class, i.current_price,
        COALESCE(SUM(CASE WHEN pt.type = 'buy' THEN pt.units ELSE 0 END), 0) -
        COALESCE(SUM(CASE WHEN pt.type = 'sell' THEN pt.units ELSE 0 END), 0) AS total_units,
        COALESCE(SUM(CASE WHEN pt.type = 'buy' THEN pt.amount ELSE 0 END), 0) -
        COALESCE(SUM(CASE WHEN pt.type = 'sell' THEN pt.amount ELSE 0 END), 0) AS net_invested,
        COALESCE(SUM(CASE WHEN pt.type IN ('interest','dividend','rent_income') THEN pt.amount ELSE 0 END), 0) AS total_income,
        COALESCE(SUM(CASE WHEN pt.type = 'appreciation' THEN pt.amount ELSE 0 END), 0) AS total_appreciation
      FROM investments i
      LEFT JOIN portfolio_transactions pt ON pt.investment_id = i.id
      WHERE i.is_active = true
      GROUP BY i.id
    `;
    const currentValueResult = await query(currentValueSql);

    let currentPortfolioValue = 0;
    for (const row of currentValueResult.rows) {
      const units = parseFloat(row.total_units);
      const price = parseFloat(row.current_price || 0);
      const invested = parseFloat(row.net_invested);
      const income = parseFloat(row.total_income);
      const appreciation = parseFloat(row.total_appreciation);

      if (['stock', 'etf', 'crypto'].includes(row.asset_class) && price > 0) {
        currentPortfolioValue += price * units;
      } else if (row.asset_class === 'real_estate') {
        currentPortfolioValue += invested + appreciation;
      } else {
        currentPortfolioValue += invested + income;
      }
    }
    currentPortfolioValue = Math.round(currentPortfolioValue * 100) / 100;

    // 4. Merge into net worth snapshots
    const allMonths = new Set([
      ...bankHistory.map(h => h.month),
      ...Object.keys(portfolioByMonth),
    ]);
    const sortedMonths = [...allMonths].sort();

    const currentMonth = new Date().toISOString().substring(0, 7);

    const snapshots = sortedMonths.map(month => {
      const bankEntry = bankHistory.find(h => h.month === month);
      const liquid = bankEntry ? bankEntry.balance : 0;
      // For current month, use market-value-based portfolio; for past months use cost-basis
      const portfolio = month === currentMonth ? currentPortfolioValue : (portfolioByMonth[month] || 0);

      return {
        month,
        liquid: Math.round(liquid * 100) / 100,
        investments: Math.round(portfolio * 100) / 100,
        netWorth: Math.round((liquid + portfolio) * 100) / 100,
      };
    });

    // Current totals
    const latest = snapshots[snapshots.length - 1] || { liquid: 0, investments: 0, netWorth: 0 };
    const previous = snapshots.length >= 2 ? snapshots[snapshots.length - 2] : null;
    const monthlyChange = previous ? latest.netWorth - previous.netWorth : 0;
    const monthlyChangePercent = previous && previous.netWorth !== 0
      ? (monthlyChange / Math.abs(previous.netWorth)) * 100 : 0;

    return {
      current: {
        liquid: latest.liquid,
        investments: currentPortfolioValue,
        netWorth: Math.round((latest.liquid + currentPortfolioValue) * 100) / 100,
      },
      monthlyChange: Math.round(monthlyChange * 100) / 100,
      monthlyChangePercent: Math.round(monthlyChangePercent * 100) / 100,
      snapshots,
    };
  },

  /**
   * Recipient / Merchant Insights
   *
   * Returns:
   * - top merchants by total spend (top 10)
   * - spending frequency & average per recipient
   * - month-over-month comparison alerts ("You spent X% more at …")
   */
  async getRecipientInsights() {
    // Fetch raw rows with currency for EUR conversion
    const topRawResult = await query(`
      SELECT
        COALESCE(pr.name, r.name) AS recipient_name,
        COALESCE(pr.id, r.id)     AS recipient_id,
        ABS(t.amount)             AS abs_amount,
        t.currency,
        t.date,
        MIN(t.date) OVER (PARTITION BY COALESCE(pr.id, r.id)) AS first_seen,
        MAX(t.date) OVER (PARTITION BY COALESCE(pr.id, r.id)) AS last_seen
      FROM transactions t
      JOIN recipients r ON t.recipient_id = r.id
      LEFT JOIN recipients pr ON r.primary_recipient_id = pr.id
      WHERE t.amount < 0
        AND t.is_active = true
    `);

    // Convert and aggregate by recipient
    const recipientAgg = {};
    for (const row of topRawResult.rows) {
      const rid = row.recipient_id;
      const dateStr = row.date instanceof Date ? row.date.toISOString().split('T')[0] : row.date;
      const eur = await convertToEur(parseFloat(row.abs_amount), row.currency, dateStr);

      if (!recipientAgg[rid]) {
        recipientAgg[rid] = {
          recipientId: rid,
          name: row.recipient_name,
          totalSpend: 0,
          transactionCount: 0,
          firstSeen: row.first_seen,
          lastSeen: row.last_seen,
        };
      }
      recipientAgg[rid].totalSpend += eur;
      recipientAgg[rid].transactionCount++;
    }

    const topMerchants = Object.values(recipientAgg)
      .sort((a, b) => b.totalSpend - a.totalSpend)
      .slice(0, 20)
      .map(r => ({
        ...r,
        totalSpend: Math.round(r.totalSpend * 100) / 100,
        avgAmount: Math.round((r.totalSpend / r.transactionCount) * 100) / 100,
      }));

    // Month-over-month comparison (current vs previous month) with EUR conversion
    const momRawResult = await query(`
      SELECT
        COALESCE(pr.id, r.id) AS recipient_id,
        COALESCE(pr.name, r.name) AS recipient_name,
        TO_CHAR(t.date, 'YYYY-MM') AS period,
        ABS(t.amount) AS abs_amount,
        t.currency,
        t.date
      FROM transactions t
      JOIN recipients r ON t.recipient_id = r.id
      LEFT JOIN recipients pr ON r.primary_recipient_id = pr.id
      WHERE t.amount < 0
        AND t.is_active = true
        AND t.date >= (DATE_TRUNC('month', CURRENT_DATE) - INTERVAL '1 month')
    `);

    const currentPeriod = new Date().toISOString().substring(0, 7);
    const prevDate = new Date();
    prevDate.setMonth(prevDate.getMonth() - 1);
    const prevPeriod = prevDate.toISOString().substring(0, 7);

    const momAgg = {}; // { recipientId: { name, current: eurTotal, previous: eurTotal } }
    for (const row of momRawResult.rows) {
      const rid = row.recipient_id;
      const dateStr = row.date instanceof Date ? row.date.toISOString().split('T')[0] : row.date;
      const eur = await convertToEur(parseFloat(row.abs_amount), row.currency, dateStr);

      if (!momAgg[rid]) momAgg[rid] = { name: row.recipient_name, current: 0, previous: 0 };
      if (row.period === currentPeriod) momAgg[rid].current += eur;
      else if (row.period === prevPeriod) momAgg[rid].previous += eur;
    }

    const monthOverMonth = Object.entries(momAgg)
      .filter(([, v]) => v.previous > 0 && v.current > 0)
      .map(([rid, v]) => ({
        recipientId: parseInt(rid, 10),
        name: v.name,
        currentSpend: Math.round(v.current * 100) / 100,
        previousSpend: Math.round(v.previous * 100) / 100,
        changePercent: Math.round(((v.current - v.previous) / v.previous * 100) * 10) / 10,
      }))
      .sort((a, b) => b.currentSpend - a.currentSpend)
      .slice(0, 10);

    return { topMerchants, monthOverMonth };
  },
};

export default infoRepository;
