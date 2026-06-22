/**
 * Rolling statistics: 6-month average vs current-month daily spending.
 */

import { query } from '../database/connection.js';
import { convertRowsToEur } from '../services/currency/currencyConversionService.js';
import {
  roundToCents,
  formatDateToYmd,
  extractYearMonth,
  mapRowsForAmountConversion,
  getIncludeTransfers,
} from './infoRepositoryHelpers.js';

export async function getAverageVsCurrentSpending(targetCurrency = 'EUR') {
  // Exclude internal transfers (ADR-083) from spending aggregates unless the
  // user has explicitly opted in. Without this, a checking->savings transfer's
  // outflow leg inflates avg/daily/projected spending — the exact thing ADR-083
  // (and the dropping of mv_cashflow_daily) set out to prevent.
  const includeTransfers = await getIncludeTransfers();
  const transferFilter = includeTransfers ? '' : 'AND t.is_transfer = false';
  const sql6m = `
    SELECT t.amount, t.currency, t.date
    FROM transactions t
    WHERE t.is_active = true
      ${transferFilter}
      AND t.date >= date_trunc('month', CURRENT_DATE) - interval '6 months'
      AND t.date < date_trunc('month', CURRENT_DATE)
    LIMIT 10000
  `;
  const sqlCurrent = `
    SELECT t.amount, t.currency, t.date
    FROM transactions t
    WHERE t.is_active = true
      ${transferFilter}
      AND t.date >= date_trunc('month', CURRENT_DATE)
      AND t.date <= CURRENT_DATE
    LIMIT 5000
  `;

  const [past6Result, currentResult] = await Promise.all([
    query(sql6m),
    query(sqlCurrent),
  ]);

  const past6Converted = await convertRowsToEur(
    mapRowsForAmountConversion(past6Result.rows, 'amount', false),
    targetCurrency
  );

  const monthlySpending = {};
  for (const row of past6Converted) {
    const dateStr = row.date instanceof Date ? formatDateToYmd(row.date) : row.date;
    const eur = row.amount_eur;
    const monthKey = extractYearMonth(dateStr);
    if (!monthlySpending[monthKey]) monthlySpending[monthKey] = 0;
    if (eur < 0) monthlySpending[monthKey] += Math.abs(eur);
  }

  const monthKeys = Object.keys(monthlySpending);
  const monthsCount = monthKeys.length || 1;
  const totalMonthlySpending = monthKeys.reduce((s, k) => s + monthlySpending[k], 0);
  const avgMonthlySpending = totalMonthlySpending / monthsCount;

  const now = new Date();
  // Calendar-day denominators, NOT counts of days that happened to have a
  // transaction. The 6-month window is 6 complete prior months; dividing by
  // transaction-day counts overstated the per-day rate (and the projection
  // below multiplied a per-active-day rate by full calendar days).
  const sixMonthStart = new Date(now.getFullYear(), now.getMonth() - 6, 1);
  const currentMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const calendarDays6m = Math.max(1, Math.round((currentMonthStart.getTime() - sixMonthStart.getTime()) / 86400000));
  const avgDailySpending = totalMonthlySpending / calendarDays6m;

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
  // Calendar days elapsed this month (not the number of days with a transaction).
  const daysElapsed = now.getDate();
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
}
