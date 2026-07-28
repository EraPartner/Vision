/**
 * Rolling statistics: 6-month average vs current-month daily spending.
 */

import { query } from '../database/connection.js';
import { toDecimal, toNumber, addAll } from '../lib/money.js';
import { convertRowsToEur } from '../services/currency/currencyConversionService.js';
import {
  roundToCents,
  formatDateToYmd,
  extractYearMonth,
  mapRowsForAmountConversion,
  getIncludeTransfers,
} from './infoRepositoryHelpers.js';
import { toAppTz } from '../lib/timezone.js';

/** Lookback length: N complete, already-elapsed calendar months. */
const WINDOW_MONTHS = 6;

/**
 * 'YYYY-MM' month key for a pg DATE column (a JS Date via node-postgres, or a
 * string on some paths), or null when the column was NULL/absent.
 * @param {unknown} value
 * @returns {string|null}
 */
function monthKeyFromDbDate(value) {
  if (value == null) return null;
  const ymd = value instanceof Date ? formatDateToYmd(value) : String(value).slice(0, 10);
  return /^\d{4}-\d{2}/.test(ymd) ? ymd.slice(0, 7) : null;
}

/**
 * Denominator for the historical averages — the SAME counting rule
 * `infoRepositoryForecast.countObservedMonths` uses (elapsed months from the
 * ledger's first in-window transaction through the last complete month),
 * applied to this card's 6-month window. Note the forecast card's window is
 * 24 months, so the two cards' divisors legitimately differ for ledgers older
 * than 6 months — what is shared is the rule, not the number. Two failure
 * modes bracket the right answer:
 *
 *  - Dividing by "months that happen to carry rows" (the old behaviour here)
 *    reported a single busy month at FULL weight — one 240-spend month became a
 *    240/month "6-month average" — and let a month whose only rows are INCOME
 *    enter the divisor as a *populated* month, halving the figure with zero
 *    extra spend. An elapsed month is a real observation either way: the user
 *    spent nothing, so it must count as a zero, not be skipped and not be
 *    counted only when some unrelated row lands in it.
 *  - Dividing by the whole window unconditionally deflates a short ledger: a
 *    user who installed last month has no data for month -5 because the app did
 *    not exist for them, not because they spent nothing.
 *
 * So the divisor is the span from the month the ledger started through the last
 * complete month, inclusive, capped at the window. Empty months inside that
 * span count as zero; months before the ledger's first entry are not counted.
 *
 * `ledgerStartMonth` MUST come from an unfiltered probe of `transactions`
 * (sqlLedgerStart below): deriving it from the filtered result set would let the
 * ADR-083 transfer predicate empty the oldest months and silently re-base the
 * divisor.
 *
 * @param {string|null} ledgerStartMonth 'YYYY-MM' of the ledger's first
 *   in-window transaction, or null when it has none.
 * @param {number} lastCompleteMonthIdx Absolute month index (year*12 + month-1)
 *   of the last complete month.
 * @returns {number} Months to divide by; always in [1, WINDOW_MONTHS].
 */
function countObservedMonths(ledgerStartMonth, lastCompleteMonthIdx) {
  if (!ledgerStartMonth) return 1;
  const startIdx = Number(ledgerStartMonth.slice(0, 4)) * 12 + (Number(ledgerStartMonth.slice(5, 7)) - 1);
  const span = lastCompleteMonthIdx - startIdx + 1;
  // Clamp only guarantees the divisor lands in [1, WINDOW_MONTHS]; it does not
  // reconcile the Postgres CURRENT_DATE clock feeding `ledgerStartMonth` with
  // the app-timezone clock feeding `lastCompleteMonthIdx` (same drift noted in
  // infoRepositoryForecast.js). It is here so the span can never be 0.
  return Math.min(WINDOW_MONTHS, Math.max(1, span));
}

export async function getAverageVsCurrentSpending(targetCurrency = 'EUR') {
  // Exclude internal transfers (ADR-083) from spending aggregates unless the
  // user has explicitly opted in. Without this, a checking->savings transfer's
  // outflow leg inflates avg/daily/projected spending — the exact thing ADR-083
  // (and the dropping of mv_cashflow_daily) set out to prevent.
  const includeTransfers = await getIncludeTransfers();
  const transferFilter = includeTransfers ? '' : 'AND t.is_transfer = false';
  // Aggregate in SQL, grouped by (date, currency, sign). The previous
  // row-streaming version capped the scans with LIMIT 10000/5000 and NO ORDER
  // BY — past 10k rows in the window Postgres dropped *arbitrary* heap-order
  // rows, making these dashboard figures nondeterministically wrong. Grouping
  // bounds the result by days x currencies x 2 (no LIMIT needed), keeps one
  // signed `amount` per row so the existing conversion pipeline and sign
  // checks below work unchanged, and moves the summing where it belongs.
  const sql6m = `
    SELECT t.date, t.currency, (t.amount < 0) AS is_spending, SUM(t.amount) AS amount
    FROM transactions t
    WHERE t.is_active = true
      ${transferFilter}
      AND t.date >= date_trunc('month', CURRENT_DATE) - interval '${WINDOW_MONTHS} months'
      AND t.date < date_trunc('month', CURRENT_DATE)
    GROUP BY t.date, t.currency, (t.amount < 0)
  `;
  const sqlCurrent = `
    SELECT t.date, t.currency, (t.amount < 0) AS is_spending, SUM(t.amount) AS amount
    FROM transactions t
    WHERE t.is_active = true
      ${transferFilter}
      AND t.date >= date_trunc('month', CURRENT_DATE)
      AND t.date <= CURRENT_DATE
    GROUP BY t.date, t.currency, (t.amount < 0)
  `;

  // Ledger start for the average denominators (countObservedMonths above).
  // Deliberately UNFILTERED — no transfer predicate — and kept LAST in the
  // Promise.all so the two data queries keep their call order. "When did this
  // ledger start having history" is a property of the ledger, not of this view.
  const sqlLedgerStart = `
    SELECT MIN(t.date) AS first_date
    FROM transactions t
    WHERE t.is_active = true
      AND t.date >= date_trunc('month', CURRENT_DATE) - interval '${WINDOW_MONTHS} months'
  `;

  const [past6Result, currentResult, ledgerStartResult] = await Promise.all([
    query(sql6m),
    query(sqlCurrent),
    query(sqlLedgerStart),
  ]);

  const past6Converted = await convertRowsToEur(
    mapRowsForAmountConversion(past6Result.rows, 'amount', false),
    targetCurrency
  );

  /** @type {Record<string, number>} */
  const monthlySpending = {};
  for (const row of past6Converted) {
    const dateStr = row.date instanceof Date ? formatDateToYmd(row.date) : row.date;
    const eur = row.amount_eur;
    const monthKey = extractYearMonth(dateStr);
    // Income rows contribute nothing at all — not even a month key. The
    // denominator is the observed calendar span (below), never "months that
    // carry a row", so an income-only month must not enter it as a populated
    // month; it is already counted as an elapsed zero-spend month.
    if (eur >= 0) continue;
    if (!monthlySpending[monthKey]) monthlySpending[monthKey] = 0;
    // Decimal accumulation (money-hygiene): native `+=` over many converted
    // rows drifts sub-cent before the final round.
    monthlySpending[monthKey] = toNumber(toDecimal(monthlySpending[monthKey]).plus(toDecimal(Math.abs(eur))));
  }

  const monthKeys = Object.keys(monthlySpending);
  const totalMonthlySpending = toNumber(addAll(monthKeys.map((k) => monthlySpending[k])));

  // Calendar denominators, NOT counts of months/days that happened to have a
  // transaction. Both figures divide the SAME numerator by the SAME window
  // expressed in two units, so `avg_monthly_spending` and `avg_daily_spending`
  // agree by construction: monthly / daily == days-per-month of that window.
  //
  // The window is the observed one (see countObservedMonths): the last
  // `monthsCount` complete months, where `monthsCount` runs from the ledger's
  // first in-window transaction through the last complete month, capped at
  // WINDOW_MONTHS. Empty months inside it are real zeros; months before the
  // ledger existed are not charged as zeros.
  //
  // "Today" is resolved in APP_TIMEZONE (ADR-009), not the server process's
  // local time, so this agrees with the CURRENT_DATE-based SQL above near
  // midnight regardless of host TZ.
  const { year: nowYear, month: nowMonth, day: nowDay } = toAppTz(new Date());
  const lastCompleteMonthIdx = nowYear * 12 + (nowMonth - 1) - 1;
  const monthsCount = countObservedMonths(
    monthKeyFromDbDate(ledgerStartResult.rows[0]?.first_date),
    lastCompleteMonthIdx,
  );
  const avgMonthlySpending = totalMonthlySpending / monthsCount;

  const observedStart = new Date(Date.UTC(nowYear, nowMonth - 1 - monthsCount, 1));
  const currentMonthStart = new Date(Date.UTC(nowYear, nowMonth - 1, 1));
  const calendarDaysObserved = Math.max(1, Math.round((currentMonthStart.getTime() - observedStart.getTime()) / 86400000));
  const avgDailySpending = totalMonthlySpending / calendarDaysObserved;

  const currentConverted = await convertRowsToEur(
    mapRowsForAmountConversion(currentResult.rows, 'amount', false),
    targetCurrency
  );

  /** @type {Record<string, { spending: number, income: number }>} */
  const dailyMap = {};
  for (const row of currentConverted) {
    const dateStr = row.date instanceof Date ? formatDateToYmd(row.date) : row.date;
    const eur = row.amount_eur;
    if (!dailyMap[dateStr]) dailyMap[dateStr] = { spending: 0, income: 0 };
    if (eur < 0) dailyMap[dateStr].spending = toNumber(toDecimal(dailyMap[dateStr].spending).plus(toDecimal(Math.abs(eur))));
    else dailyMap[dateStr].income = toNumber(toDecimal(dailyMap[dateStr].income).plus(toDecimal(eur)));
  }

  const dailyData = Object.entries(dailyMap)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, d]) => ({
      date,
      spending: roundToCents(d.spending),
      income: roundToCents(d.income),
    }));

  const totalCurrentSpending = toNumber(addAll(dailyData.map((d) => d.spending)));
  // Calendar days elapsed this month (not the number of days with a transaction).
  const daysElapsed = nowDay;
  const daysInMonth = new Date(Date.UTC(nowYear, nowMonth, 0)).getUTCDate();
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
