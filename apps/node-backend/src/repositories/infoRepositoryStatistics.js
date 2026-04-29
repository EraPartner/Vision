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
      const catResult = await query('SELECT * FROM mv_category_totals ORDER BY count DESC');

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
    const countResult = await query('SELECT count(*) FROM transactions WHERE is_active = true');

    const txResult = await query(`
      SELECT t.amount, t.currency, t.date
      FROM transactions t
      WHERE t.is_active = true
    `);

    const txConverted = await convertRowsToEur(
      mapRowsForAmountConversion(txResult.rows, 'amount', false),
      targetCurrency
    );
    const totalEur = txConverted.reduce((s, r) => s + r.amount_eur, 0);

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
      const catResult = await query('SELECT * FROM mv_category_totals ORDER BY count DESC');
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
    let sql = `
      SELECT t.amount, t.currency, t.date
      FROM transactions t
      WHERE t.is_active = true
    `;
    const params = [];
    let paramIdx = 1;

    if (bankAccount) { sql += ` AND t.bank_account ILIKE $${paramIdx++}`; params.push(`%${bankAccount}%`); }
    if (startDate) { sql += ` AND t.date >= $${paramIdx++}`; params.push(startDate); }
    if (endDate) { sql += ` AND t.date <= $${paramIdx}`; params.push(endDate); }

    const result = await query(sql, params);

    if (result.rows.length === 0) {
      return { total_count: 0, total_amount: 0, average: 0, min: null, max: null };
    }

    const converted = await convertRowsToEur(
      mapRowsForAmountConversion(result.rows, 'amount', false),
      targetCurrency
    );

    let total = toDecimal(0);
    let min = Infinity;
    let max = -Infinity;
    for (const row of converted) {
      const eur = row.amount_eur;
      total = total.plus(toDecimal(eur));
      if (eur < min) min = eur;
      if (eur > max) max = eur;
    }

    const count = result.rows.length;
    return {
      total_count: count,
      total_amount: roundToCents(total),
      average: roundToCents(total.dividedBy(count)),
      min: roundToCents(min),
      max: roundToCents(max),
    };
  },
};
