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
} from './infoRepositoryHelpers.js';

export async function getAverageVsCurrentSpending(targetCurrency = 'EUR') {
  const sql6m = `
    SELECT t.amount, t.currency, t.date
    FROM transactions t
    WHERE t.is_active = true
      AND t.date >= date_trunc('month', CURRENT_DATE) - interval '6 months'
      AND t.date < date_trunc('month', CURRENT_DATE)
    LIMIT 10000
  `;
  const sqlCurrent = `
    SELECT t.amount, t.currency, t.date
    FROM transactions t
    WHERE t.is_active = true
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
}
