/**
 * Info sub-repository: planned expenses for next month.
 */

import { query } from '../database/connection.js';
import { convertRowsToEur } from '../services/currency/currencyConversionService.js';
import { toAppDateString, todayAppDateString, firstOfMonthYmd, addDaysYmd } from '../lib/timezone.js';
import { calculateNextDate } from '../lib/calculations/recurrence.js';
import { addAll, toDecimal, toNumber } from '../lib/money.js';
import {
  roundToCents,
  formatDateToYmd,
  mapRowsForAmountConversion,
} from './infoRepositoryHelpers.js';

const MAX_OCCURRENCES = 120; // guard against infinite loops on tiny intervals

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Fixed day-step for the day-based recurrence patterns, or null for the
 * month-based ones (monthly/quarterly/yearly), whose step length varies.
 *
 * @param {string|null|undefined} pattern
 * @returns {number|null}
 */
function dayStepForPattern(pattern) {
  const p = String(pattern || '').toLowerCase().trim();
  if (p === 'daily') return 1;
  if (p === 'weekly') return 7;
  if (p === 'biweekly') return 14;
  const match = p.match(/^every\s+(\d+)\s+days?$/);
  if (match) {
    const days = parseInt(match[1], 10);
    return days >= 1 ? days : null;
  }
  return null;
}

/**
 * Walk a recurring planned transaction forward from its stored date, emitting
 * each occurrence (as a YYYY-MM-DD string in APP_TIMEZONE) that falls within
 * [startYmd, endYmd). Returns [] for a pattern calculateNextDate can't advance.
 *
 * Day-stepped patterns fast-forward to just before the window in one jump: a
 * stale fast-cadence row (e.g. daily, last advanced >120 days ago) used to
 * exhaust MAX_OCCURRENCES before reaching next month and silently vanish from
 * the forecast. The jump is whole-step ms arithmetic — exactly equivalent to N
 * sequential calculateNextDate hops for these patterns — landing at least one
 * step before the window so the boundary occurrence is never skipped.
 * Month-based patterns keep the plain walk (120 monthly hops = 10 years, far
 * beyond any realistic staleness, and bulk month jumps would change the
 * sequential month-end clamping semantics).
 *
 * @param {Date|string} plannedDate DATE column — a `Date` from pg.
 * @param {string} pattern
 * @param {string} startYmd 'YYYY-MM-DD' (inclusive)
 * @param {string} endYmd 'YYYY-MM-DD' (exclusive)
 * @returns {string[]} occurrence days as 'YYYY-MM-DD'
 */
function expandRecurringOccurrences(plannedDate, pattern, startYmd, endYmd) {
  /** @type {string[]} */
  const ymds = [];
  if (!pattern) return ymds;
  let current = plannedDate instanceof Date ? new Date(plannedDate.getTime()) : new Date(plannedDate);
  if (Number.isNaN(current.getTime())) return ymds;

  const stepDays = dayStepForPattern(pattern);
  if (stepDays) {
    const [y, m, d] = startYmd.split('-').map((s) => parseInt(s, 10));
    const windowStartMs = Date.UTC(y, m - 1, d);
    const stepMs = stepDays * MS_PER_DAY;
    const deficitMs = windowStartMs - current.getTime();
    if (deficitMs > stepMs) {
      const hops = Math.floor(deficitMs / stepMs) - 1;
      if (hops > 0) current = new Date(current.getTime() + hops * stepMs);
    }
  }

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
    // Anchor the month window to today's calendar month in APP_TIMEZONE and
    // keep it as YYYY-MM-DD strings throughout (ADR-009 helpers: pure calendar
    // math, host-timezone independent).
    //
    // The boundaries used to be `Date`s built with LOCAL getters
    // (`new Date(today.year, today.month, 1)`) but read back with UTC ones
    // (`getUTCMonth()`/`getUTCFullYear()`) for the `month`/`year` fields. East
    // of UTC — including the default APP_TIMEZONE=Europe/Brussels — local
    // midnight of the 1st is still the PREVIOUS month in UTC, so the response
    // named one month while `period_start` (formatted with local getters)
    // named the next: month=7 alongside period_start='2026-08-01'.
    const todayYmd = todayAppDateString();
    const startYmd = firstOfMonthYmd(todayYmd, 1); // first of next month
    const endYmd = firstOfMonthYmd(todayYmd, 2); // first of the month after (exclusive)
    const lastDayYmd = addDaysYmd(endYmd, -1);
    const [nextMonthYear, nextMonthMonth] = startYmd.split('-').map((s) => parseInt(s, 10));

    const sql = `
      SELECT pt.*, r.name AS recipient_name,
             -- Same 3-level resolution as plannedTransactionRepository (and as
             -- transactionRepository's CATEGORY_NAME_SQL): own (c) → recipient
             -- default (rc) → PRIMARY recipient default (pc). This site
             -- resolved c ONLY, joining neither rc nor pc, so a planned row
             -- that inherits its category from the recipient reported
             -- category_name: null here while its sibling repository — reading
             -- the same table for the same row — categorised it.
             CASE
               WHEN c.id IS NOT NULL THEN c.general || ':' || c.detail
               WHEN rc.id IS NOT NULL THEN rc.general || ':' || rc.detail
               WHEN pc.id IS NOT NULL THEN pc.general || ':' || pc.detail
               ELSE NULL
             END AS category_name
      FROM planned_transactions pt
      LEFT JOIN recipients r ON pt.recipient_id = r.id
      LEFT JOIN recipients pr ON r.primary_recipient_id = pr.id
      LEFT JOIN categories c ON pt.category_id = c.id
      LEFT JOIN categories rc ON r.default_category_id = rc.id
      LEFT JOIN categories pc ON pr.default_category_id = pc.id
      WHERE pt.is_active = true
        AND pt.is_executed = false
        AND (
          (pt.is_recurring = true)
          OR (pt.planned_date >= $1 AND pt.planned_date < $2)
        )
      ORDER BY pt.planned_date ASC
    `;

    const result = await query(sql, [startYmd, endYmd]);

    const plannedConverted = await convertRowsToEur(
      mapRowsForAmountConversion(result.rows, 'amount', false),
      targetCurrency
    );

    /**
     * `total_income` / `total_expenses` are deliberately `any`: they hold
     * Decimals during the accumulation loop and are collapsed IN PLACE to
     * numbers after it (see below) — a union type would reject one of the two
     * phases without a runtime change.
     *
     * @type {Record<string, {
     *   date: string,
     *   total_income: any,
     *   total_expenses: any,
     *   transactions: Array<{
     *     id: number,
     *     recipient_name: string|null,
     *     amount: number,
     *     category_name: string|null,
     *     is_recurring: boolean,
     *     recurrence_pattern: string|null,
     *   }>,
     * }>}
     */
    const dailyMap = {};
    let occurrenceCount = 0;
    // Day totals accumulate as Decimals (monetary-arithmetic rule) and are
    // collapsed to numbers once, after the loop.
    /**
     * @param {string} dateStr 'YYYY-MM-DD'
     * @param {any} row Converted planned row (`PlannedForecastRow`-ish + `amount_eur`).
     * @param {number} eur
     */
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
      month: nextMonthMonth,
      year: nextMonthYear,
      period_start: startYmd,
      period_end: lastDayYmd,
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
