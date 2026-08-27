/**
 * Monthly financial summary — materialized-view fast path plus
 * live-query fallback with category/recipient exclusions.
 *
 * ONE CLOCK, same rule as infoRepositoryForecast.js and
 * infoRepositoryAverageVsCurrent.js: every month-window edge here is anchored
 * on `todayAppDateString()` — the APP_TIMEZONE calendar day (ADR-009) — read
 * once per call and bound into the SQL as a `::date` parameter. Postgres
 * `CURRENT_DATE` is not used: it follows the DB session's zone (UTC), so with
 * the default APP_TIMEZONE=Europe/Brussels the two disagree on the calendar
 * day for the couple of hours before midnight — and on a month's last day the
 * SQL window set and the JS zero-fill key set disagreed by a whole month.
 */

import { query } from '../database/connection.js';
import { buildExclusionClauses, validateInt4Ids } from '../lib/filterBuilder.js';
import { convertRowsToEur } from '../services/currency/currencyConversionService.js';
import { logger } from '../config/logger.js';
import { toDecimal, toNumber, roundMoney as roundToCents } from '../lib/money.js';
import { formatDateToYmd, toWireDate } from '../lib/dateFormat.js';
import { formatYearMonthKey } from '../lib/dateKeys.js';
import { todayAppDateString, firstOfMonthYmd } from '../lib/timezone.js';
import {
  mvAvailable,
  buildMonthlySummary,
  mapRowsForAmountConversion,
  getIncludeTransfers,
} from './infoRepositoryHelpers.js';

/**
 * @param {number[]} [excludedCategoryIds]
 * @param {string} [targetCurrency]
 * @param {number[]} [excludedRecipientIds]
 * @param {boolean} [allTime]
 */
export async function getMonthlyFinancialSummary(
  excludedCategoryIds = [],
  targetCurrency = 'EUR',
  excludedRecipientIds = [],
  allTime = false,
) {
  const validIds = validateInt4Ids(excludedCategoryIds, 'excludedCategoryIds');
  const validRecipientIds = validateInt4Ids(excludedRecipientIds, 'excludedRecipientIds');
  logger.debug('getMonthlyFinancialSummary called', { excludedCategoryIds, validIds, validRecipientIds });
  // The single clock for this call (ADR-009). Read ONCE, bound into whichever
  // path runs (MV filter or live generate_series) and reused for the JS
  // zero-fill below, so the SQL month set and the JS key set can never
  // straddle a month rollover.
  const todayYmd = todayAppDateString();
  const includeTransfers = await getIncludeTransfers();

  // The MV is grained month×currency, so its fast path converts a whole month's
  // total at the 1st-of-month rate. That only matches the live per-(date,currency)
  // path when NO conversion happens — i.e. every MV row is already in the target
  // currency. If any row differs, fall through to the live path (whose own
  // comment explains intra-month FX varies). Avoids the dashboard's monthly
  // history visibly shifting when an unrelated exclusion toggles the path.
  const mvTarget = (targetCurrency || 'EUR').toUpperCase();
  let mvCurrencyHomogeneous = false;
  const mvUsable = !includeTransfers && !allTime && validIds.length === 0 && validRecipientIds.length === 0 && await mvAvailable('mv_monthly_summary');
  if (mvUsable) {
    const hetero = await query(
      `SELECT 1 FROM mv_monthly_summary WHERE UPPER(currency) <> $1 LIMIT 1`,
      [mvTarget],
    );
    mvCurrencyHomogeneous = hetero.rows.length === 0;
  }

  if (mvUsable && mvCurrencyHomogeneous) {
    // Upper bound matches the live path (whose generate_series ends at the
    // current month) — without it a post-dated transaction adds a future month
    // on the MV path only, so the dashboard month set changed with the code path.
    // Anchored on the bound app date ($1), the same clock as the zero-fill.
    const dateFilterClause = `WHERE month_start >= date_trunc('month', $1::date - interval '5 months')
        AND month_start <= date_trunc('month', $1::date)`;
    const mvResult = await query(`
      SELECT month_start, month, year, currency,
             SUM(transaction_count) AS transaction_count,
             SUM(total_income) AS total_income,
             SUM(total_spending) AS total_spending,
             SUM(net_amount) AS net_amount
      FROM mv_monthly_summary
      ${dateFilterClause}
      GROUP BY month_start, month, year, currency
      ORDER BY month_start
    `, [todayYmd]);

    const mergedRows = [];
    for (const r of mvResult.rows) {
      const dateStr = r.month_start instanceof Date ? formatDateToYmd(r.month_start) : String(r.month_start);
      const monthKey = formatYearMonthKey(r.year, r.month);
      mergedRows.push({ currency: r.currency, amount: toNumber(toDecimal(r.total_income)), _key: monthKey, _type: 'income', _row: r, date: dateStr });
      mergedRows.push({ currency: r.currency, amount: toNumber(toDecimal(r.total_spending)), _key: monthKey, _type: 'spending', _row: r, date: dateStr });
    }
    const mergedConverted = await convertRowsToEur(mergedRows, targetCurrency, { useHistoricalRatesByDate: true, dateField: 'date' });

    /**
     * @type {Record<string, {
     *   month: number, year: number,
     *   period_start: string|null, period_end: string|null,
     *   total_spending: number, total_income: number,
     *   net_amount: number, transaction_count: number,
     * }>}
     */
    const monthMap = {};
    for (const conv of mergedConverted) {
      const key = conv._key;
      const r = conv._row;
      if (!monthMap[key]) {
        monthMap[key] = {
          month: r.month, year: r.year,
          period_start: toWireDate(r.month_start),
          period_end: null,
          total_spending: 0, total_income: 0, net_amount: 0, transaction_count: 0,
        };
      }
      // Decimal accumulation (ADR money-hygiene): summing per-month EUR amounts
      // with native `+=` drifts sub-cent across many rows before the final round.
      if (conv._type === 'income') monthMap[key].total_income = toNumber(toDecimal(monthMap[key].total_income).plus(toDecimal(conv.amount_eur)));
      else monthMap[key].total_spending = toNumber(toDecimal(monthMap[key].total_spending).plus(toDecimal(conv.amount_eur)));
      monthMap[key].net_amount = toNumber(toDecimal(monthMap[key].total_income).plus(toDecimal(monthMap[key].total_spending)));
      monthMap[key].transaction_count += parseInt(r.transaction_count, 10);
    }

    // Zero-fill months with no transactions so the MV path returns the SAME
    // 6-month set as the live path's generate_series. Without this, toggling an
    // exclusion (which switches paths) changed the dashboard's month set.
    // Uses the SAME app-timezone "today" (ADR-009) bound into the SQL above —
    // one clock reading, so the key set and the window set agree by
    // construction, at any hour.
    for (let i = 5; i >= 0; i--) {
      const monthStart = firstOfMonthYmd(todayYmd, -i);
      const year = Number(monthStart.slice(0, 4));
      const month = Number(monthStart.slice(5, 7));
      const key = formatYearMonthKey(year, month);
      if (!monthMap[key]) {
        monthMap[key] = {
          month, year,
          period_start: monthStart,
          period_end: null,
          total_spending: 0, total_income: 0, net_amount: 0, transaction_count: 0,
        };
      }
    }

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

  // Canonical exclusion clauses (lib/filterBuilder.buildExclusionClauses):
  // 3-level category COALESCE and alias-aware recipient exclusion.
  const excl = buildExclusionClauses({ excludedCategoryIds, excludedRecipientIds });
  const params = excl.params;
  const exclusionWhere = excl.whereSql ? `AND ${excl.whereSql}` : '';

  // The app-date anchor rides after the exclusion params; `todayParam` is its
  // placeholder in the SQL below.
  const todayParam = `$${params.length + 1}`;
  params.push(todayYmd);

  const allTimeStart = allTime
    ? `COALESCE((SELECT MIN(date_trunc('month', date)) FROM transactions WHERE is_active = true), date_trunc('month', ${todayParam}::date))`
    : `date_trunc('month', ${todayParam}::date - interval '5 months')`;

  // Aggregate per (date, currency) in SQL instead of streaming every transaction
  // into JS. This path converts at each transaction's historical date rate
  // (useHistoricalRatesByDate below), so we can only collapse rows that share a
  // rate — i.e. the same date+currency. Within such a group every row uses the
  // same rate, and rate > 0 preserves sign, so:
  //   • SUM(amount) FILTER (amount >= 0) converted == Σ converted incomes
  //   • SUM(amount) FILTER (amount <  0) converted == Σ converted spendings
  // making this numerically identical to the old per-transaction loop while
  // pushing the heavy SUM/COUNT into Postgres. (A month-level GROUP BY would NOT
  // be valid here because intra-month FX varies.)
  const sql = `
    WITH months AS (
      SELECT generate_series(
        ${allTimeStart},
        date_trunc('month', ${todayParam}::date),
        interval '1 month'
      )::date AS month_start
    ),
    filtered_transactions AS (
      SELECT
        t.amount,
        t.currency,
        t.date,
        -- Canonical 3-level effective category (own → recipient default →
        -- PRIMARY recipient's default), matching transactionRepository and the
        -- mv_monthly_summary definition. The exclusion clauses above already
        -- resolve 3 levels via buildExclusionClauses, so this column keeps the
        -- CTE's own resolution consistent with them.
        COALESCE(t.category_id, r.default_category_id, pr.default_category_id) AS effective_category_id
      FROM transactions t
      LEFT JOIN recipients r ON t.recipient_id = r.id
      LEFT JOIN recipients pr ON r.primary_recipient_id = pr.id
      WHERE t.is_active = true
      ${includeTransfers ? '' : 'AND t.is_transfer = false'}
      ${exclusionWhere}
    ),
    daily AS (
      SELECT
        date,
        currency,
        COUNT(*) AS cnt,
        COALESCE(SUM(amount) FILTER (WHERE amount >= 0), 0) AS income_amount,
        COALESCE(SUM(amount) FILTER (WHERE amount < 0), 0) AS spending_amount
      FROM filtered_transactions
      GROUP BY date, currency
    )
    SELECT
      EXTRACT(MONTH FROM m.month_start)::int AS month,
      EXTRACT(YEAR FROM m.month_start)::int AS year,
      m.month_start AS period_start,
      (m.month_start + interval '1 month' - interval '1 day')::date AS period_end,
      d.date, d.currency, d.cnt, d.income_amount, d.spending_amount
    FROM months m
    LEFT JOIN daily d ON d.date >= m.month_start
      AND d.date < m.month_start + interval '1 month'
    ORDER BY m.month_start, d.date
  `;
  logger.debug('Monthly summary SQL executing', {
    exclusionWhere: exclusionWhere || '(none)',
    paramCount: params.length,
  });

  const result = await query(sql, params);
  logger.debug('Monthly summary query returned', { rowCount: result.rows.length });

  const dailyRows = result.rows.filter(
    (/** @type {{
      month: number, year: number, period_start: Date, period_end: Date,
      date: Date|null, currency: string|null, cnt: string|null,
      income_amount: string|null, spending_amount: string|null,
    }} */ r) => r.date != null,
  );
  // Convert each (date, currency) income/spending aggregate at that date's rate.
  const [incomeConverted, spendingConverted] = await Promise.all([
    convertRowsToEur(
      mapRowsForAmountConversion(dailyRows, 'income_amount', false),
      targetCurrency,
      { useHistoricalRatesByDate: true, dateField: 'date' },
    ),
    convertRowsToEur(
      mapRowsForAmountConversion(dailyRows, 'spending_amount', false),
      targetCurrency,
      { useHistoricalRatesByDate: true, dateField: 'date' },
    ),
  ]);

  /**
   * @type {Record<string, {
   *   month: number, year: number,
   *   period_start: string|null, period_end: string|null,
   *   total_spending: number, total_income: number,
   *   net_amount: number, transaction_count: number,
   * }>}
   */
  const monthMap = {};
  for (const row of result.rows) {
    const key = formatYearMonthKey(row.year, row.month);
    if (!monthMap[key]) {
      monthMap[key] = {
        month: row.month,
        year: row.year,
        period_start: toWireDate(row.period_start),
        period_end: toWireDate(row.period_end),
        total_spending: 0,
        total_income: 0,
        net_amount: 0,
        transaction_count: 0,
      };
    }
  }

  for (let i = 0; i < dailyRows.length; i += 1) {
    const row = dailyRows[i];
    const key = formatYearMonthKey(row.year, row.month);
    const incomeEur = incomeConverted[i].amount_eur;
    const spendingEur = spendingConverted[i].amount_eur;
    monthMap[key].total_income = toNumber(toDecimal(monthMap[key].total_income).plus(toDecimal(incomeEur)));
    monthMap[key].total_spending = toNumber(toDecimal(monthMap[key].total_spending).plus(toDecimal(spendingEur)));
    monthMap[key].net_amount = toNumber(toDecimal(monthMap[key].total_income).plus(toDecimal(monthMap[key].total_spending)));
    monthMap[key].transaction_count += Number(row.cnt);
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
}
