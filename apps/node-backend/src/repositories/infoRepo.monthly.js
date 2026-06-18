/**
 * Monthly financial summary — materialized-view fast path plus
 * live-query fallback with category/recipient exclusions.
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
  buildMonthlySummary,
  mapRowsForAmountConversion,
  getIncludeTransfers,
} from './infoRepositoryHelpers.js';

export async function getMonthlyFinancialSummary(
  excludedCategoryIds = [],
  targetCurrency = 'EUR',
  excludedRecipientIds = [],
  allTime = false,
) {
  const validIds = excludedCategoryIds.filter(id => Number.isInteger(id) && id > 0 && id < 2147483647);
  const validRecipientIds = (excludedRecipientIds || []).filter(id => Number.isInteger(id) && id > 0 && id < 2147483647);
  logger.debug('getMonthlyFinancialSummary called', { excludedCategoryIds, validIds, validRecipientIds });
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
    const dateFilterClause = `WHERE month_start >= date_trunc('month', CURRENT_DATE - interval '5 months')`;
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
    `);

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

    // Zero-fill months with no transactions so the MV path returns the SAME
    // 6-month set as the live path's generate_series. Without this, toggling an
    // exclusion (which switches paths) changed the dashboard's month set.
    const now = new Date();
    for (let i = 5; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const year = d.getFullYear();
      const month = d.getMonth() + 1;
      const key = formatYearMonthKey(year, month);
      if (!monthMap[key]) {
        monthMap[key] = {
          month, year,
          period_start: `${year}-${String(month).padStart(2, '0')}-01`,
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

  const params = [];
  // Canonical exclusion semantics (match buildExclusionClauses + every other
  // surface): 3-level category COALESCE and alias-aware recipient exclusion.
  const categoryExcludeClause = validIds.length > 0
    ? `AND COALESCE(t.category_id, r.default_category_id, pr.default_category_id) NOT IN (${validIds.map(id => { params.push(id); return `$${params.length}`; }).join(',')})`
    : '';
  const recipientExcludeClause = validRecipientIds.length > 0
    ? `AND COALESCE(r.primary_recipient_id, t.recipient_id) NOT IN (${validRecipientIds.map(id => { params.push(id); return `$${params.length}`; }).join(',')})`
    : '';

  const allTimeStart = allTime
    ? `COALESCE((SELECT MIN(date_trunc('month', date)) FROM transactions WHERE is_active = true), date_trunc('month', CURRENT_DATE))`
    : `date_trunc('month', CURRENT_DATE - interval '5 months')`;

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
        date_trunc('month', CURRENT_DATE),
        interval '1 month'
      )::date AS month_start
    ),
    filtered_transactions AS (
      SELECT
        t.amount,
        t.currency,
        t.date,
        COALESCE(t.category_id, r.default_category_id) AS effective_category_id
      FROM transactions t
      LEFT JOIN recipients r ON t.recipient_id = r.id
      LEFT JOIN recipients pr ON r.primary_recipient_id = pr.id
      WHERE t.is_active = true
      ${includeTransfers ? '' : 'AND t.is_transfer = false'}
      ${categoryExcludeClause}
      ${recipientExcludeClause}
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
    categoryExcludeClause: categoryExcludeClause || '(none)',
    recipientExcludeClause: recipientExcludeClause || '(none)',
    paramCount: params.length,
  });

  const result = await query(sql, params);
  logger.debug('Monthly summary query returned', { rowCount: result.rows.length });

  const dailyRows = result.rows.filter(r => r.date != null);
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

  for (let i = 0; i < dailyRows.length; i += 1) {
    const row = dailyRows[i];
    const key = formatYearMonthKey(row.year, row.month);
    const incomeEur = incomeConverted[i].amount_eur;
    const spendingEur = spendingConverted[i].amount_eur;
    monthMap[key].total_income += incomeEur;
    monthMap[key].total_spending += spendingEur;
    monthMap[key].net_amount += incomeEur + spendingEur;
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
