/**
 * Info sub-repository: planned expenses for next month.
 */

import { query } from '../database/connection.js';
import { convertRowsToEur } from '../services/currency/currencyConversionService.js';
import { toAppTz, toAppDateString } from '../lib/timezone.js';
import { calculateNextDate } from '../services/calculations/recurrence.js';
import { addAll, toDecimal, toNumber } from '../lib/money.js';
import {
  roundToCents,
  formatDateToYmd,
  mapRowsForAmountConversion,
} from './infoRepositoryHelpers.js';

const MAX_OCCURRENCES = 120; // guard against infinite loops on tiny intervals

/**
 * Walk a recurring planned transaction forward from its stored date, emitting
 * each occurrence (as a YYYY-MM-DD string in APP_TIMEZONE) that falls within
 * [startYmd, endYmd). Returns [] for a pattern calculateNextDate can't advance.
 */
function expandRecurringOccurrences(plannedDate, pattern, startYmd, endYmd) {
  const ymds = [];
  if (!pattern) return ymds;
  let current = plannedDate instanceof Date ? new Date(plannedDate.getTime()) : new Date(plannedDate);
  if (Number.isNaN(current.getTime())) return ymds;
  for (let i = 0; i < MAX_OCCURRENCES; i++) {
    const ymd = toAppDateString(current);
    if (ymd >= endYmd) break;
    if (ymd >= startYmd) ymds.push(ymd);
    const next = calculateNextDate(current, pattern);
    if (!next || next.getTime() <= current.getTime()) break;
    current = next;
  }
  return ymds;
}

export const plannedRepository = {
  async getPlannedExpensesNextMonth(targetCurrency = 'EUR') {
    // Anchor the month window to today's calendar month in APP_TIMEZONE.
    // Constructed LOCALLY to pair with formatDateToYmd's local extraction —
    // a UTC-constructed boundary would render as the last day of the previous
    // month on any server west of UTC. (today.month is 1-based, so passing it
    // as the 0-based month argument yields the first of the NEXT month.)
    const today = toAppTz(new Date());
    const nextMonth = new Date(today.year, today.month, 1);
    const monthAfter = new Date(today.year, today.month + 1, 1);
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
        AND pt.is_executed = false
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

    const startYmd = formatDateToYmd(nextMonth);
    const endYmd = formatDateToYmd(monthAfter);

    const dailyMap = {};
    let occurrenceCount = 0;
    // Day totals accumulate as Decimals (monetary-arithmetic rule) and are
    // collapsed to numbers once, after the loop.
    const pushOccurrence = (dateStr, row, eur) => {
      if (!dailyMap[dateStr]) {
        dailyMap[dateStr] = { date: dateStr, total_income: toDecimal(0), total_expenses: toDecimal(0), transactions: [] };
      }
      if (eur >= 0) dailyMap[dateStr].total_income = dailyMap[dateStr].total_income.plus(toDecimal(eur));
      else dailyMap[dateStr].total_expenses = dailyMap[dateStr].total_expenses.plus(toDecimal(eur));
      dailyMap[dateStr].transactions.push({
        id: row.id,
        recipient_name: row.recipient_name,
        amount: roundToCents(eur),
        category_name: row.category_name,
        is_recurring: row.is_recurring,
        recurrence_pattern: row.recurrence_pattern,
      });
      occurrenceCount += 1;
    };

    for (const row of plannedConverted) {
      const eur = row.amount_eur;
      if (row.is_recurring && row.recurrence_pattern) {
        // Expand each recurrence into its actual next-month occurrences instead
        // of counting the row once at its (possibly current-month) stored date.
        for (const ymd of expandRecurringOccurrences(row.planned_date, row.recurrence_pattern, startYmd, endYmd)) {
          pushOccurrence(ymd, row, eur);
        }
      } else {
        const dateStr = row.planned_date instanceof Date
          ? formatDateToYmd(row.planned_date)
          : String(row.planned_date).slice(0, 10);
        // Non-recurring (or pattern-less) rows only count inside the window.
        if (dateStr >= startYmd && dateStr < endYmd) pushOccurrence(dateStr, row, eur);
      }
    }

    const dailyData = Object.values(dailyMap).sort((a, b) => {
      const aTime = new Date(a?.date).getTime();
      const bTime = new Date(b?.date).getTime();
      if (Number.isNaN(aTime) && Number.isNaN(bTime)) return 0;
      if (Number.isNaN(aTime)) return 1;
      if (Number.isNaN(bTime)) return -1;
      return aTime - bTime;
    });

    const totalIncome = addAll(dailyData.map((d) => d.total_income));
    const totalExpenses = addAll(dailyData.map((d) => d.total_expenses));
    for (const day of dailyData) {
      day.total_income = toNumber(day.total_income);
      day.total_expenses = toNumber(day.total_expenses);
    }

    return {
      month: nextMonth.getUTCMonth() + 1,
      year: nextMonth.getUTCFullYear(),
      period_start: formatDateToYmd(nextMonth),
      period_end: formatDateToYmd(lastDay),
      daily_data: dailyData,
      summary: {
        total_income: roundToCents(totalIncome),
        total_expenses: roundToCents(totalExpenses),
        net_amount: roundToCents(totalIncome.plus(totalExpenses)),
        transaction_count: occurrenceCount,
      },
    };
  },
};
