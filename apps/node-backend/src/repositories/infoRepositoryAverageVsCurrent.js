/**
 * Rolling statistics: 6-month average vs current-month daily spending.
 *
 * ONE CLOCK, same rule as infoRepositoryForecast.js: every window edge and
 * every piece of month/day arithmetic here is anchored on
 * `todayAppDateString()` — the APP_TIMEZONE calendar day (ADR-009) — read once
 * per call and bound into the SQL as `$1::date`. Postgres `CURRENT_DATE` is not
 * used: it follows the DB session's zone (UTC), so with the default
 * APP_TIMEZONE=Europe/Brussels the two disagree on the calendar day for the
 * couple of hours before midnight, and on a month's last day that is a whole
 * month of arithmetic — the divisor counted a month whose rows the window had
 * already excluded. `WINDOW_MONTHS` is bound too ($2), so no value is
 * template-interpolated into the SQL text.
 */

import { query } from '../database/connection.js';
import { toDecimal, toNumber, addAll, roundMoney as roundToCents } from '../lib/money.js';
import { formatDateToYmd } from '../lib/dateFormat.js';
import { extractYearMonth } from '../lib/dateKeys.js';
import { convertRowsToEur } from '../services/currency/currencyConversionService.js';
import {
  mapRowsForAmountConversion,
  getIncludeTransfers,
} from './infoRepositoryHelpers.js';
import { todayAppDateString } from '../lib/timezone.js';
import { countObservedMonths, monthKeyFromDbDate } from '../lib/observedMonths.js';

/** Lookback length: N complete, already-elapsed calendar months. */
const WINDOW_MONTHS = 6;

/*
 * Denominator for the historical averages — the shared observed-month rule
 * counts elapsed months from the ledger's first in-window transaction through
 * the last complete month, applied here to this card's 6-month window. The
 * forecast card's window is 24 months, so the two cards' divisors differ for
 * ledgers older than 6 months — what is shared is the rule, not the number. Two failure
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
 * The implementation lives in lib/observedMonths.js; this caller passes
 * its own six-month window while the forecast caller passes 24 months.
 */
export async function getAverageVsCurrentSpending(targetCurrency = 'EUR') {
  // The single clock for this call (ADR-009). Read ONCE, bound into all three
  // queries as $1 and reused for the month/day arithmetic further down, so the
  // window edges and the divisor can never straddle a month rollover.
  const todayYmd = todayAppDateString();
  const nowYear = Number(todayYmd.slice(0, 4));
  const nowMonth = Number(todayYmd.slice(5, 7));
  const nowDay = Number(todayYmd.slice(8, 10));

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
      AND t.date >= date_trunc('month', $1::date) - make_interval(months => $2::int)
      AND t.date < date_trunc('month', $1::date)
    GROUP BY t.date, t.currency, (t.amount < 0)
  `;
  const sqlCurrent = `
    SELECT t.date, t.currency, (t.amount < 0) AS is_spending, SUM(t.amount) AS amount
    FROM transactions t
    WHERE t.is_active = true
      ${transferFilter}
      AND t.date >= date_trunc('month', $1::date)
      AND t.date <= $1::date
    GROUP BY t.date, t.currency, (t.amount < 0)
  `;

  // Ledger start for the average denominators (countObservedMonths above).
  // Deliberately UNFILTERED — no transfer predicate — and kept LAST in the
  // Promise.all so the two data queries keep their call order. "When did this
  // ledger start having history" is a property of the ledger, not of this view.
  // "Unfiltered" means no predicates; the two bound values are the window
  // itself, anchored on the same app date as everything else.
  const sqlLedgerStart = `
    SELECT MIN(t.date) AS first_date
    FROM transactions t
    WHERE t.is_active = true
      AND t.date >= date_trunc('month', $1::date) - make_interval(months => $2::int)
  `;

  const [past6Result, currentResult, ledgerStartResult] = await Promise.all([
    query(sql6m, [todayYmd, WINDOW_MONTHS]),
    query(sqlCurrent, [todayYmd]),
    query(sqlLedgerStart, [todayYmd, WINDOW_MONTHS]),
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
  // "Today" is resolved in APP_TIMEZONE (ADR-009) at the top of this function
  // and bound into the SQL above, so the window edges and this month index are
  // two readings of one clock — not the host's, and not the DB session's.
  const lastCompleteMonthIdx = nowYear * 12 + (nowMonth - 1) - 1;
  const monthsCount = countObservedMonths(
    monthKeyFromDbDate(ledgerStartResult.rows[0]?.first_date),
    lastCompleteMonthIdx,
    WINDOW_MONTHS,
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
