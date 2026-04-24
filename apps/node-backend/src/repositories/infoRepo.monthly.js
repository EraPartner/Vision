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

  if (!allTime && validIds.length === 0 && validRecipientIds.length === 0 && await mvAvailable('mv_monthly_summary')) {
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
  const categoryExcludeClause = validIds.length > 0
    ? `AND COALESCE(t.category_id, r.default_category_id) NOT IN (${validIds.map(id => { params.push(id); return `$${params.length}`; }).join(',')})`
    : '';
  const recipientExcludeClause = validRecipientIds.length > 0
    ? `AND t.recipient_id NOT IN (${validRecipientIds.map(id => { params.push(id); return `$${params.length}`; }).join(',')})`
    : '';

  const allTimeStart = allTime
    ? `COALESCE((SELECT MIN(date_trunc('month', date)) FROM transactions WHERE is_active = true), date_trunc('month', CURRENT_DATE))`
    : `date_trunc('month', CURRENT_DATE - interval '5 months')`;

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
}
