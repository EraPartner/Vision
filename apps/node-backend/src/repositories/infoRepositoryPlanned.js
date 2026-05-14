/**
 * Info sub-repository: planned expenses for next month.
 */

import { query } from '../database/connection.js';
import { convertRowsToEur } from '../services/currency/currencyConversionService.js';
import { toAppTz } from '../lib/timezone.js';
import {
  roundToCents,
  formatDateToYmd,
  mapRowsForAmountConversion,
} from './infoRepositoryHelpers.js';

export const plannedRepository = {
  async getPlannedExpensesNextMonth(targetCurrency = 'EUR') {
    // Anchor the month window to today's calendar month in APP_TIMEZONE.
    // Server-local `new Date(y, m+1, 1)` serialized via toISOString() could
    // resolve to the last day of the *current* month on a non-UTC server,
    // shifting the whole planned_date SQL range by a month.
    const today = toAppTz(new Date());
    const nextMonth = new Date(Date.UTC(today.year, today.month, 1));
    const monthAfter = new Date(Date.UTC(today.year, today.month + 1, 1));
    const lastDay = new Date(monthAfter.getTime() - 1);

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
      formatDateToYmd(nextMonth),
      formatDateToYmd(monthAfter),
    ]);

    const plannedConverted = await convertRowsToEur(
      mapRowsForAmountConversion(result.rows, 'amount', false),
      targetCurrency
    );

    const dailyMap = {};
    for (const row of plannedConverted) {
      const dateStr = row.planned_date instanceof Date
        ? formatDateToYmd(row.planned_date)
        : String(row.planned_date);
      if (!dailyMap[dateStr]) {
        dailyMap[dateStr] = { date: dateStr, total_income: 0, total_expenses: 0, transactions: [] };
      }
      const eur = row.amount_eur;
      if (eur >= 0) dailyMap[dateStr].total_income += eur;
      else dailyMap[dateStr].total_expenses += eur;
      dailyMap[dateStr].transactions.push({
        id: row.id,
        recipient_name: row.recipient_name,
        amount: roundToCents(eur),
        category_name: row.category_name,
        is_recurring: row.is_recurring,
        recurrence_pattern: row.recurrence_pattern,
      });
    }

    const dailyData = Object.values(dailyMap).sort((a, b) => {
      const aTime = new Date(a?.date).getTime();
      const bTime = new Date(b?.date).getTime();
      if (Number.isNaN(aTime) && Number.isNaN(bTime)) return 0;
      if (Number.isNaN(aTime)) return 1;
      if (Number.isNaN(bTime)) return -1;
      return aTime - bTime;
    });

    const totalIncome = dailyData.reduce((s, d) => s + d.total_income, 0);
    const totalExpenses = dailyData.reduce((s, d) => s + d.total_expenses, 0);

    return {
      month: nextMonth.getUTCMonth() + 1,
      year: nextMonth.getUTCFullYear(),
      period_start: formatDateToYmd(nextMonth),
      period_end: formatDateToYmd(lastDay),
      daily_data: dailyData,
      summary: {
        total_income: roundToCents(totalIncome),
        total_expenses: roundToCents(totalExpenses),
        net_amount: roundToCents(totalIncome + totalExpenses),
        transaction_count: result.rows.length,
      },
    };
  },
};
