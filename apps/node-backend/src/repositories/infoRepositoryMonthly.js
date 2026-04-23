/**
 * Info sub-repository: monthly summaries, cashflow comparison,
 * and average-vs-current spending.
 */

import { query } from '../database/connection.js';
import { convertRowsToEur } from '../services/currency/currencyConversionService.js';
import { logger } from '../config/logger.js';
import { toDecimal, toNumber } from '../lib/money.js';
import {
  mvAvailable,
  roundToCents,
  formatDateToYmd,
  formatYearMonthKey,
  extractYearMonth,
  buildMonthlySummary,
  mapRowsForAmountConversion,
  convertRowsWithHistoricalRateFallback,
  batchConvertGroupsWithHistoricalRateFallback,
} from './infoRepositoryHelpers.js';

export const monthlyRepository = {
  async getMonthlyFinancialSummary(excludedCategoryIds = [], targetCurrency = 'EUR', excludedRecipientIds = []) {
    const validIds = excludedCategoryIds.filter(id => Number.isInteger(id) && id > 0 && id < 2147483647);
    const validRecipientIds = (excludedRecipientIds || []).filter(id => Number.isInteger(id) && id > 0 && id < 2147483647);
    logger.debug('getMonthlyFinancialSummary called', { excludedCategoryIds, validIds, validRecipientIds });

    // ── Fast path: read from mv_monthly_summary (only when no exclusions) ──
    if (validIds.length === 0 && validRecipientIds.length === 0 && await mvAvailable('mv_monthly_summary')) {
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

      // Merge income+spending into one array for a single batch conversion
      const mergedRows = [];
      for (const r of mvResult.rows) {
        const dateStr = r.month_start instanceof Date ? formatDateToYmd(r.month_start) : String(r.month_start);
        const monthKey = formatYearMonthKey(r.year, r.month);
        mergedRows.push({ currency: r.currency, amount: toNumber(toDecimal(r.total_income)), _key: monthKey, _type: 'income', _row: r, date: dateStr });
        mergedRows.push({ currency: r.currency, amount: toNumber(toDecimal(r.total_spending)), _key: monthKey, _type: 'spending', _row: r, date: dateStr });
      }
      const mergedConverted = await convertRowsToEur(mergedRows, targetCurrency, { useHistoricalRatesByDate: true, dateField: 'date' });

      const monthMap = {};
      for (const conv of mergedConverted) {
        const key = conv._key;
        const r = conv._row;
        if (!monthMap[key]) {
          monthMap[key] = {
            month: r.month, year: r.year,
            period_start: r.month_start,
            period_end: null,
            total_spending: 0, total_income: 0, net_amount: 0, transaction_count: 0,
          };
        }
        if (conv._type === 'income') monthMap[key].total_income += conv.amount_eur;
        else monthMap[key].total_spending += conv.amount_eur;
        monthMap[key].net_amount = monthMap[key].total_income + monthMap[key].total_spending;
        monthMap[key].transaction_count += parseInt(r.transaction_count, 10);
      }

      // Deduplicate transaction_count (merged rows double-count it)
      for (const m of Object.values(monthMap)) {
        m.transaction_count = Math.round(m.transaction_count / 2);
      }

      const months = Object.values(monthMap)
        .sort((a, b) => a.year !== b.year ? a.year - b.year : a.month - b.month)
        .map(m => ({
          ...m,
          period_end: formatDateToYmd(new Date(m.year, m.month, 0)),
          total_spending: roundToCents(m.total_spending),
          total_income: roundToCents(m.total_income),
          net_amount: roundToCents(m.net_amount),
        }));

      return { months, summary: buildMonthlySummary(months) };
    }

    // ── Fallback: live query with exclusions ──
    const params = [];
    const categoryExcludeClause = validIds.length > 0
      ? `AND COALESCE(t.category_id, r.default_category_id) NOT IN (${validIds.map(id => { params.push(id); return `$${params.length}`; }).join(',')})`
      : '';
    const recipientExcludeClause = validRecipientIds.length > 0
      ? `AND t.recipient_id NOT IN (${validRecipientIds.map(id => { params.push(id); return `$${params.length}`; }).join(',')})`
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
        ${categoryExcludeClause}
        ${recipientExcludeClause}
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
    logger.debug('Monthly summary SQL executing', {
      categoryExcludeClause: categoryExcludeClause || '(none)',
      recipientExcludeClause: recipientExcludeClause || '(none)',
      paramCount: params.length,
    });

    const result = await query(sql, params);
    logger.debug('Monthly summary query returned', { rowCount: result.rows.length });

    const liveConverted = await convertRowsToEur(
      mapRowsForAmountConversion(result.rows.filter(r => r.txn_id != null), 'amount', false),
      targetCurrency,
      { useHistoricalRatesByDate: true, dateField: 'date' }
    );

    const monthMap = {};
    for (const row of result.rows) {
      const key = formatYearMonthKey(row.year, row.month);
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
    }

    for (const row of liveConverted) {
      const key = formatYearMonthKey(row.year, row.month);
      const eur = row.amount_eur;
      monthMap[key].transaction_count++;
      monthMap[key].net_amount += eur;
      if (eur < 0) monthMap[key].total_spending += eur;
      else monthMap[key].total_income += eur;
    }

    const months = Object.values(monthMap)
      .sort((a, b) => a.year !== b.year ? a.year - b.year : a.month - b.month)
      .map(m => ({
        ...m,
        total_spending: roundToCents(m.total_spending),
        total_income: roundToCents(m.total_income),
        net_amount: roundToCents(m.net_amount),
      }));

    return { months, summary: buildMonthlySummary(months) };
  },

  async getAverageVsCurrentSpending(targetCurrency = 'EUR') {
    const sql6m = `
      SELECT t.amount, t.currency, t.date
      FROM transactions t
      WHERE t.is_active = true
        AND t.date >= date_trunc('month', CURRENT_DATE) - interval '6 months'
        AND t.date < date_trunc('month', CURRENT_DATE)
    `;
    const sqlCurrent = `
      SELECT t.amount, t.currency, t.date
      FROM transactions t
      WHERE t.is_active = true
        AND t.date >= date_trunc('month', CURRENT_DATE)
        AND t.date <= CURRENT_DATE
    `;

    // Both queries are independent — run in parallel
    const [past6Result, currentResult] = await Promise.all([
      query(sql6m),
      query(sqlCurrent),
    ]);

    // FX rates are memory-cached (no `useHistoricalRatesByDate`), so two calls are cheap.
    // Convert sequentially to keep the logic readable.
    const past6Converted = await convertRowsToEur(
      mapRowsForAmountConversion(past6Result.rows, 'amount', false),
      targetCurrency
    );

    const monthlySpending = {};
    const monthlyDays = {};
    for (const row of past6Converted) {
      const dateStr = row.date instanceof Date ? formatDateToYmd(row.date) : row.date;
      const eur = row.amount_eur;
      const monthKey = extractYearMonth(dateStr);
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

    const currentConverted = await convertRowsToEur(
      mapRowsForAmountConversion(currentResult.rows, 'amount', false),
      targetCurrency
    );

    const dailyMap = {};
    for (const row of currentConverted) {
      const dateStr = row.date instanceof Date ? formatDateToYmd(row.date) : row.date;
      const eur = row.amount_eur;
      if (!dailyMap[dateStr]) dailyMap[dateStr] = { spending: 0, income: 0 };
      if (eur < 0) dailyMap[dateStr].spending += Math.abs(eur);
      else dailyMap[dateStr].income += eur;
    }

    const dailyData = Object.entries(dailyMap)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, d]) => ({
        date,
        spending: roundToCents(d.spending),
        income: roundToCents(d.income),
      }));

    const totalCurrentSpending = dailyData.reduce((s, d) => s + d.spending, 0);
    const daysElapsed = dailyData.length || 1;
    const now = new Date();
    const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    const projectedTotal = (totalCurrentSpending / daysElapsed) * daysInMonth;

    return {
      past_6_months: {
        avg_daily_spending: roundToCents(avgDailySpending),
        avg_monthly_spending: roundToCents(avgMonthlySpending),
        months_counted: monthsCount,
      },
      current_month: {
        daily_data: dailyData,
        total_spending: roundToCents(totalCurrentSpending),
        days_elapsed: daysElapsed,
        days_in_month: daysInMonth,
      },
      comparison: {
        projected_monthly_total: roundToCents(projectedTotal),
        avg_monthly_spending: roundToCents(avgMonthlySpending),
        variance: roundToCents(projectedTotal - avgMonthlySpending),
        pace: avgDailySpending > 0 ? roundToCents((totalCurrentSpending / daysElapsed) / avgDailySpending) : null,
      },
    };
  },

  /**
   * Cashflow comparison: cumulative daily net cash flow for the current month
   * versus the average daily pattern across the last 24 complete months.
   * X-axis = day of month (1-31). Two variants: with and without planned expenses.
   */
  async getCashflowComparison(excludedCategoryIds = [], excludedRecipientIds = [], targetCurrency = 'EUR') {
    const now = new Date();
    const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    const currentDay = now.getDate();
    const HISTORY_MONTHS = 24;

    const validCatIds = excludedCategoryIds.filter(id => Number.isInteger(id) && id > 0 && id < 2147483647);
    const validRecIds = excludedRecipientIds.filter(id => Number.isInteger(id) && id > 0 && id < 2147483647);

    let categoryExclusionJoin = '';
    let categoryExclusionWhere = '';
    const excludeParams = [];
    let paramIdx = 1;

    if (validCatIds.length > 0 || validRecIds.length > 0) {
      categoryExclusionJoin = `
        LEFT JOIN recipients r ON t.recipient_id = r.id
        LEFT JOIN recipients pr ON r.primary_recipient_id = pr.id
      `;
    }

    if (validCatIds.length > 0) {
      const placeholders = validCatIds.map(() => `$${paramIdx++}`).join(', ');
      categoryExclusionWhere += `
        AND COALESCE(t.category_id, r.default_category_id, pr.default_category_id) NOT IN (${placeholders})
      `;
      excludeParams.push(...validCatIds);
    }

    if (validRecIds.length > 0) {
      const placeholders = validRecIds.map(() => `$${paramIdx++}`).join(', ');
      categoryExclusionWhere += `
        AND COALESCE(r.primary_recipient_id, t.recipient_id) NOT IN (${placeholders})
      `;
      excludeParams.push(...validRecIds);
    }

    // --- Build SQL for all 4 result sets ---
    const sqlPast = `
      SELECT t.amount, t.currency, t.date,
             EXTRACT(DAY FROM t.date)::int AS day_of_month,
             TO_CHAR(date_trunc('month', t.date), 'YYYY-MM') AS month_key
      FROM transactions t
      ${categoryExclusionJoin}
      WHERE t.is_active = true
        AND t.date >= date_trunc('month', CURRENT_DATE) - interval '${HISTORY_MONTHS} months'
        AND t.date < date_trunc('month', CURRENT_DATE)
        ${categoryExclusionWhere}
    `;

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

    const sqlPlannedCurrent = `
      SELECT pt.amount, pt.currency, pt.planned_date,
             EXTRACT(DAY FROM pt.planned_date)::int AS day_of_month
      FROM planned_transactions pt
      WHERE pt.is_active = true
        AND pt.planned_date >= date_trunc('month', CURRENT_DATE)
        AND pt.planned_date <= (date_trunc('month', CURRENT_DATE) + interval '1 month' - interval '1 day')
    `;

    const sqlPlannedHist = `
      SELECT pt.amount, pt.currency, pt.planned_date,
             EXTRACT(DAY FROM pt.planned_date)::int AS day_of_month,
             TO_CHAR(date_trunc('month', pt.planned_date), 'YYYY-MM') AS month_key
      FROM planned_transactions pt
      WHERE pt.is_active = true
        AND pt.planned_date >= date_trunc('month', CURRENT_DATE) - interval '${HISTORY_MONTHS} months'
        AND pt.planned_date < date_trunc('month', CURRENT_DATE)
    `;

    // All 4 DB queries are independent — run in parallel, then batch-convert with one
    // historical-rate lookup instead of four separate exchange_rates queries.
    const [pastResult, currentResult, plannedCurrentResult, plannedHistResult] = await Promise.all([
      query(sqlPast, excludeParams),
      query(sqlCurrent, excludeParams),
      query(sqlPlannedCurrent),
      query(sqlPlannedHist),
    ]);

    // resolveDateFromRow in convertRowsToEur falls back to `planned_date` when `date` is absent,
    // so planned rows don't need the date field normalized before batching.
    const [pastConverted, currentCashflowConverted, plannedCurrentConverted, plannedHistConverted] =
      await batchConvertGroupsWithHistoricalRateFallback(
        [
          mapRowsForAmountConversion(pastResult.rows, 'amount', false),
          mapRowsForAmountConversion(currentResult.rows, 'amount', false),
          mapRowsForAmountConversion(plannedCurrentResult.rows, 'amount', false),
          mapRowsForAmountConversion(plannedHistResult.rows, 'amount', false),
        ],
        targetCurrency,
        'date'
      );

    // --- 1. Historical daily data: last 24 complete months ---
    const monthDayNet = {};
    for (const row of pastConverted) {
      const eur = row.amount_eur;
      const mk = row.month_key;
      if (!monthDayNet[mk]) monthDayNet[mk] = {};
      monthDayNet[mk][row.day_of_month] = (monthDayNet[mk][row.day_of_month] || 0) + eur;
    }

    const monthKeys = Object.keys(monthDayNet);
    const monthCount = monthKeys.length || 1;
    const avgCumulativeByDay = {};
    for (const mk of monthKeys) {
      const dayNet = monthDayNet[mk];
      let cum = 0;
      for (let d = 1; d <= 31; d++) {
        cum += (dayNet[d] || 0);
        avgCumulativeByDay[d] = (avgCumulativeByDay[d] || 0) + cum;
      }
    }
    for (const d of Object.keys(avgCumulativeByDay)) {
      avgCumulativeByDay[d] /= monthCount;
    }

    // --- 2. Current month daily data ---
    const currentDayNet = {};
    for (const row of currentCashflowConverted) {
      currentDayNet[row.day_of_month] = (currentDayNet[row.day_of_month] || 0) + row.amount_eur;
    }

    let currentCum = 0;
    const currentByDay = {};
    for (let d = 1; d <= currentDay; d++) {
      currentCum += (currentDayNet[d] || 0);
      currentByDay[d] = currentCum;
    }

    // --- 3. Planned transactions for current month ---
    const plannedCurrentByDay = {};
    for (const row of plannedCurrentConverted) {
      plannedCurrentByDay[row.day_of_month] = (plannedCurrentByDay[row.day_of_month] || 0) + row.amount_eur;
    }

    const plannedHistMonthDay = {};
    for (const row of plannedHistConverted) {
      const mk = row.month_key;
      if (!plannedHistMonthDay[mk]) plannedHistMonthDay[mk] = {};
      plannedHistMonthDay[mk][row.day_of_month] = (plannedHistMonthDay[mk][row.day_of_month] || 0) + row.amount_eur;
    }

    const plannedHistMonthKeys = Object.keys(plannedHistMonthDay);
    const plannedHistCount = plannedHistMonthKeys.length || 1;
    const avgPlannedCumByDay = {};
    for (const mk of plannedHistMonthKeys) {
      const dayNet = plannedHistMonthDay[mk];
      let cum = 0;
      for (let d = 1; d <= 31; d++) {
        cum += (dayNet[d] || 0);
        avgPlannedCumByDay[d] = (avgPlannedCumByDay[d] || 0) + cum;
      }
    }
    for (const d of Object.keys(avgPlannedCumByDay)) {
      avgPlannedCumByDay[d] /= plannedHistCount;
    }

    // --- 5. Build response: one entry per day of current month ---
    const withoutPlanned = [];
    const withPlanned = [];
    let plannedCum = 0;

    for (let day = 1; day <= daysInMonth; day++) {
      const avg = avgCumulativeByDay[day] !== undefined ? avgCumulativeByDay[day] : (avgCumulativeByDay[day - 1] || 0);
      const current = day <= currentDay ? currentByDay[day] : null;

      withoutPlanned.push({
        day,
        average: roundToCents(avg),
        current: current !== null ? roundToCents(current) : null,
      });

      const avgPlanned = avgPlannedCumByDay[day] !== undefined ? avgPlannedCumByDay[day] : (avgPlannedCumByDay[day - 1] || 0);
      plannedCum += (plannedCurrentByDay[day] || 0);
      const currentWithPlanned = current !== null ? current + plannedCum : null;

      withPlanned.push({
        day,
        average: roundToCents(avg + avgPlanned),
        current: currentWithPlanned !== null ? roundToCents(currentWithPlanned) : null,
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
};
