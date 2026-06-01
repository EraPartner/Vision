/**
 * Info sub-repository: category statistics and transaction summaries.
 */

import { query, queryPrepared } from '../database/connection.js';
import { convertRowsToEur } from '../services/currency/currencyConversionService.js';
import { toDecimal, toNumber } from '../lib/money.js';
import {
  mvAvailable,
  roundToCents,
  mapRowsForAmountConversion,
  buildCategoryFromConvertedRows,
} from './infoRepositoryHelpers.js';

export const statisticsRepository = {
  async getStatistics(targetCurrency = 'EUR') {
    // ── Fast path: materialized views ──
    if (await mvAvailable('mv_category_totals')) {
      const countResult = await query('SELECT count(*) FROM transactions WHERE is_active = true');
      const catResult = await query('SELECT * FROM mv_category_totals ORDER BY count DESC LIMIT 500');

      const convertedRows = await convertRowsToEur(
        mapRowsForAmountConversion(catResult.rows, 'total', true),
        targetCurrency
      );

      const categories = buildCategoryFromConvertedRows(convertedRows);
      const totalEur = toNumber(categories.reduce((sum, cat) => sum.plus(toDecimal(cat.total)), toDecimal(0)));

      return {
        total_transactions: parseInt(countResult.rows[0].count, 10),
        total_amount: roundToCents(totalEur),
        categories,
      };
    }

    // ── Fallback: live query ──
    // The category query below already selects every active transaction's
    // amount/currency/date, so the grand total is derived from the same
    // converted rows instead of issuing a second identical full-table scan.
    const countResult = await query('SELECT count(*) FROM transactions WHERE is_active = true');

    const categoryAmountResult = await query(`
      SELECT COALESCE(c.id, -1) AS category_id,
             COALESCE(c.general || ':' || c.detail, 'UNCATEGORISED') AS name,
             t.amount,
             t.currency,
             t.date
      FROM transactions t
      LEFT JOIN recipients r ON t.recipient_id = r.id
      LEFT JOIN categories c ON COALESCE(t.category_id, r.default_category_id) = c.id
      WHERE t.is_active = true
    `);

    const catConverted = await convertRowsToEur(
      mapRowsForAmountConversion(categoryAmountResult.rows, 'amount', false),
      targetCurrency
    );

    const totalEur = catConverted.reduce((s, r) => s + r.amount_eur, 0);

    const catMap = {};
    for (const row of catConverted) {
      const catId = row.category_id === -1 ? null : parseInt(row.category_id, 10);
      const eur = row.amount_eur;
      const key = catId ?? 'null';
      if (!catMap[key]) catMap[key] = { id: catId, name: row.name, count: 0, total: 0 };
      catMap[key].count++;
      catMap[key].total += eur;
    }
    const categories = Object.values(catMap)
      .map(cat => ({ ...cat, total: roundToCents(cat.total) }))
      .sort((a, b) => b.count - a.count);

    return {
      total_transactions: parseInt(countResult.rows[0].count, 10),
      total_amount: roundToCents(totalEur),
      categories,
    };
  },

  async getCategoryBreakdown(targetCurrency = 'EUR') {
    if (await mvAvailable('mv_category_totals')) {
      const catResult = await query('SELECT * FROM mv_category_totals ORDER BY count DESC LIMIT 500');
      const convertedRows = await convertRowsToEur(
        mapRowsForAmountConversion(catResult.rows, 'total', true),
        targetCurrency
      );
      return buildCategoryFromConvertedRows(convertedRows);
    }

    const categoryAmountResult = await query(`
      SELECT COALESCE(c.id, -1) AS category_id,
             COALESCE(c.general || ':' || c.detail, 'UNCATEGORISED') AS name,
             t.amount,
             t.currency,
             t.date
      FROM transactions t
      LEFT JOIN recipients r ON t.recipient_id = r.id
      LEFT JOIN categories c ON COALESCE(t.category_id, r.default_category_id) = c.id
      WHERE t.is_active = true
    `);

    const catConverted = await convertRowsToEur(
      mapRowsForAmountConversion(categoryAmountResult.rows, 'amount', false),
      targetCurrency
    );

    const catMap = {};
    for (const row of catConverted) {
      const catId = row.category_id === -1 ? null : parseInt(row.category_id, 10);
      const eur = row.amount_eur;
      const key = catId ?? 'null';
      if (!catMap[key]) catMap[key] = { id: catId, name: row.name, count: 0, total: 0 };
      catMap[key].count++;
      catMap[key].total += eur;
    }
    return Object.values(catMap)
      .map(cat => ({ ...cat, total: roundToCents(cat.total) }))
      .sort((a, b) => b.count - a.count);
  },

  async getBanks() {
    const result = await queryPrepared(
      'info_get_banks',
      `SELECT DISTINCT bank_account FROM transactions WHERE is_active = true AND bank_account IS NOT NULL ORDER BY bank_account`,
      []
    );
    return result.rows.map(r => r.bank_account);
  },

  async getTransactionCount() {
    const result = await queryPrepared('info_tx_count', 'SELECT count(*) FROM transactions WHERE is_active = true', []);
    return parseInt(result.rows[0].count, 10);
  },

  async getCategoryPivot(excludedCategoryIds = [], targetCurrency = 'EUR', excludedRecipientIds = []) {
    const validCatIds = excludedCategoryIds.filter(id => Number.isInteger(id) && id > 0 && id < 2147483647);
    const validRecIds = (excludedRecipientIds || []).filter(id => Number.isInteger(id) && id > 0 && id < 2147483647);

    const params = [];
    const catExclude = validCatIds.length > 0
      ? `AND COALESCE(t.category_id, r.default_category_id) NOT IN (${validCatIds.map(id => { params.push(id); return `$${params.length}`; }).join(',')})`
      : '';
    const recExclude = validRecIds.length > 0
      ? `AND t.recipient_id NOT IN (${validRecIds.map(id => { params.push(id); return `$${params.length}`; }).join(',')})`
      : '';

    const sql = `
      SELECT
        COALESCE(t.category_id, r.default_category_id) AS category_id,
        CONCAT(c.general, ': ', c.detail) AS category_name,
        TO_CHAR(t.date, 'YYYY-MM') AS period,
        t.amount, t.currency, t.date
      FROM transactions t
      LEFT JOIN recipients r ON t.recipient_id = r.id
      LEFT JOIN categories c ON COALESCE(t.category_id, r.default_category_id) = c.id
      WHERE t.is_active = true
        AND COALESCE(t.category_id, r.default_category_id) IS NOT NULL
        ${catExclude}
        ${recExclude}
      ORDER BY t.date
    `;

    const result = await query(sql, params);

    const converted = await convertRowsToEur(
      mapRowsForAmountConversion(result.rows, 'amount', false),
      targetCurrency,
      { useHistoricalRatesByDate: true, dateField: 'date' }
    );

    const periodCatMap = {};
    for (const row of converted) {
      const period = row.period;
      const catId = row.category_id ? parseInt(row.category_id, 10) : null;
      const catName = row.category_name || 'Uncategorised';
      const eur = row.amount_eur;
      const catKey = catId ?? 'null';

      if (!periodCatMap[period]) periodCatMap[period] = {};
      if (!periodCatMap[period][catKey]) {
        periodCatMap[period][catKey] = { categoryId: catId, categoryName: catName, total: 0, transactionCount: 0 };
      }
      periodCatMap[period][catKey].total += eur;
      periodCatMap[period][catKey].transactionCount++;
    }

    const categoryPivot = {};
    for (const [period, cats] of Object.entries(periodCatMap)) {
      categoryPivot[period] = Object.values(cats)
        .map(c => ({ ...c, total: roundToCents(c.total) }))
        .sort((a, b) => a.total - b.total);
    }

    return { categoryPivot };
  },

  async getTransactionSummary({ bankAccount = null, startDate = null, endDate = null, targetCurrency = 'EUR' } = {}) {
    // Push count/sum/min/max into SQL, grouped by currency, instead of streaming
    // every active row into JS. The grouped result is tiny (one row per currency)
    // and the combine below is exact: convertRowsToEur defaults to one latest
    // rate per currency (useHistoricalRatesByDate = false), so for each currency
    // c with rate_c > 0:
    //   count = Σ cnt_c
    //   total = Σ (sum_c × rate_c)
    //   min   = min_c (min_c × rate_c)   max = max_c (max_c × rate_c)
    // min/max combine because multiplying by a positive rate is monotonic.
    let sql = `
      SELECT t.currency,
             COUNT(*)      AS cnt,
             SUM(t.amount) AS sum_amount,
             MIN(t.amount) AS min_amount,
             MAX(t.amount) AS max_amount
      FROM transactions t
      WHERE t.is_active = true
    `;
    const params = [];
    let paramIdx = 1;

    if (bankAccount) { sql += ` AND t.bank_account ILIKE $${paramIdx++}`; params.push(`%${bankAccount}%`); }
    if (startDate) { sql += ` AND t.date >= $${paramIdx++}`; params.push(startDate); }
    if (endDate) { sql += ` AND t.date <= $${paramIdx}`; params.push(endDate); }

    sql += ` GROUP BY t.currency`;

    const result = await query(sql, params);

    if (result.rows.length === 0) {
      return { total_count: 0, total_amount: 0, average: 0, min: null, max: null };
    }

    // Convert each per-currency aggregate by that currency's latest rate.
    const [sumRows, minRows, maxRows] = await Promise.all([
      convertRowsToEur(mapRowsForAmountConversion(result.rows, 'sum_amount', false), targetCurrency),
      convertRowsToEur(mapRowsForAmountConversion(result.rows, 'min_amount', false), targetCurrency),
      convertRowsToEur(mapRowsForAmountConversion(result.rows, 'max_amount', false), targetCurrency),
    ]);

    let total = toDecimal(0);
    let count = 0;
    for (let i = 0; i < result.rows.length; i += 1) {
      total = total.plus(toDecimal(sumRows[i].amount_eur));
      count += Number(result.rows[i].cnt);
    }
    const min = Math.min(...minRows.map(r => r.amount_eur));
    const max = Math.max(...maxRows.map(r => r.amount_eur));

    return {
      total_count: count,
      total_amount: roundToCents(total),
      average: roundToCents(total.dividedBy(count)),
      min: roundToCents(min),
      max: roundToCents(max),
    };
  },
};
