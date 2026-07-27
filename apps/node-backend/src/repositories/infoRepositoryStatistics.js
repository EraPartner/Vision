/**
 * Info sub-repository: category statistics and transaction summaries.
 */

import { query, queryPrepared } from '../database/connection.js';
import { buildExclusionClauses } from '../lib/filterBuilder.js';
import { toDecimal, toNumber } from '../lib/money.js';
import { convertRowsToEur } from '../services/currency/currencyConversionService.js';
import {
  mvAvailable,
  roundToCents,
  mapRowsForAmountConversion,
  buildCategoryFromConvertedRows,
  getIncludeTransfers,
} from './infoRepositoryHelpers.js';

export const statisticsRepository = {
  async getCategoryBreakdown(targetCurrency = 'EUR') {
    const includeTransfers = await getIncludeTransfers();

    // The MV (mv_category_totals) is built transfer-excluding, so it is only a
    // valid fast path when the caller also wants transfers excluded.
    if (!includeTransfers && await mvAvailable('mv_category_totals')) {
      const catResult = await query('SELECT * FROM mv_category_totals ORDER BY count DESC LIMIT 500');
      const convertedRows = await convertRowsToEur(
        mapRowsForAmountConversion(catResult.rows, 'total', true),
        targetCurrency
      );
      return buildCategoryFromConvertedRows(convertedRows);
    }

    // Live fallback path. Mirror the MV's transfer exclusion (ADR-083) so totals
    // do not silently change depending on whether the MV is populated.
    //
    // Aggregate in SQL per (category, currency) instead of streaming every
    // active transaction into JS. The default conversion (below) applies one
    // flat rate per currency — no per-date component — so SUM(amount) per
    // (category, currency) converted once equals Σ of the converted per-row
    // amounts (rate is linear and sign-preserving): numerically identical to
    // the old per-row loop, minus the row-cardinality transfer to Node.
    const categoryAmountResult = await query(`
      SELECT COALESCE(c.id, -1) AS category_id,
             COALESCE(c.general || ':' || c.detail, 'UNCATEGORISED') AS name,
             SUM(t.amount) AS amount,
             COUNT(*) AS cnt,
             t.currency
      FROM transactions t
      LEFT JOIN recipients r ON t.recipient_id = r.id
      LEFT JOIN categories c ON COALESCE(t.category_id, r.default_category_id) = c.id
      WHERE t.is_active = true
        ${includeTransfers ? '' : 'AND t.is_transfer = false'}
      GROUP BY COALESCE(c.id, -1),
               COALESCE(c.general || ':' || c.detail, 'UNCATEGORISED'),
               t.currency
    `);

    const catConverted = await convertRowsToEur(
      mapRowsForAmountConversion(categoryAmountResult.rows, 'amount', false),
      targetCurrency
    );

    /** @type {Record<string, { id: number|null, name: string, count: number, total: number }>} */
    const catMap = {};
    for (const row of catConverted) {
      const catId = row.category_id === -1 ? null : parseInt(row.category_id, 10);
      const eur = row.amount_eur;
      const key = catId ?? 'null';
      if (!catMap[key]) catMap[key] = { id: catId, name: row.name, count: 0, total: 0 };
      catMap[key].count += parseInt(row.cnt, 10) || 0;
      // Decimal accumulation (money-hygiene) — native `+=` over the per-currency
      // converted subtotals drifts sub-cent before the roundToCents below.
      catMap[key].total = toNumber(toDecimal(catMap[key].total).plus(toDecimal(eur)));
    }
    return Object.values(catMap)
      .map(cat => ({ ...cat, total: roundToCents(cat.total) }))
      .sort((a, b) => b.count - a.count);
  },

  async getBanks() {
    // Account labels for filter dropdowns, sourced from accounts.name (ADR-088).
    // EXISTS keeps the prior behaviour: only accounts that actually have active
    // transactions appear (an account is "seen" once it has activity).
    const result = await queryPrepared(
      'info_get_banks',
      `SELECT a.name AS bank_account
         FROM accounts a
        WHERE a.id IN (
          SELECT t.account_id FROM transactions t
           WHERE t.is_active = true AND t.account_id IS NOT NULL
        )
        ORDER BY a.name`,
      []
    );
    return result.rows.map((/** @type {{ bank_account: string }} */ r) => r.bank_account);
  },

  /**
   * @param {{ accountId?: (number|null) }} [opts]
   */
  async getTransactionCount(opts = {}) {
    const { accountId } = opts;
    // Optional exact-FK account filter (ADR-088). Absent → unchanged unconditional
    // count (reuses the cached prepared statement); present → a parameterized,
    // separately-cached prepared statement so the two query shapes don't collide.
    if (accountId != null) {
      const result = await queryPrepared(
        'info_tx_count_by_account',
        'SELECT count(*) FROM transactions WHERE is_active = true AND account_id = $1',
        [accountId],
      );
      return parseInt(result.rows[0].count, 10);
    }
    const result = await queryPrepared('info_tx_count', 'SELECT count(*) FROM transactions WHERE is_active = true', []);
    return parseInt(result.rows[0].count, 10);
  },

  /**
   * @param {number[]} [excludedCategoryIds]
   * @param {string} [targetCurrency]
   * @param {number[]} [excludedRecipientIds]
   */
  async getCategoryPivot(excludedCategoryIds = [], targetCurrency = 'EUR', excludedRecipientIds = []) {
    const includeTransfers = await getIncludeTransfers();
    // Canonical exclusion clauses (lib/filterBuilder.buildExclusionClauses,
    // shared with every other money surface): 3-level category COALESCE and
    // ALIAS-AWARE recipient exclusion. The bare `t.recipient_id NOT IN` here
    // previously kept an excluded recipient's transactions whenever they were
    // recorded under an alias of the excluded primary — disagreeing with the
    // dashboard/forecast.
    const excl = buildExclusionClauses({ excludedCategoryIds, excludedRecipientIds });
    const params = excl.params;
    const exclusionWhere = excl.whereSql ? `AND ${excl.whereSql}` : '';

    // Aggregate in SQL per (category, period, date, currency) instead of
    // streaming every active transaction into JS. Conversion uses each row's
    // historical date rate, and rows sharing date+currency share one rate
    // (rate > 0 preserves sign), so SUM(...) FILTER by sign converted == Σ of
    // the converted per-transaction amounts — numerically identical to the old
    // per-row loop. The sign-split also gives explicit income/expense per cell
    // so consumers no longer have to classify by the sign of the net total.
    const sql = `
      SELECT
        COALESCE(t.category_id, r.default_category_id) AS category_id,
        CONCAT(c.general, ': ', c.detail) AS category_name,
        TO_CHAR(t.date, 'YYYY-MM') AS period,
        t.date, t.currency,
        SUM(t.amount) FILTER (WHERE t.amount >= 0) AS income,
        SUM(t.amount) FILTER (WHERE t.amount < 0) AS expense,
        COUNT(*) AS cnt
      FROM transactions t
      LEFT JOIN recipients r ON t.recipient_id = r.id
      LEFT JOIN recipients pr ON r.primary_recipient_id = pr.id
      LEFT JOIN categories c ON COALESCE(t.category_id, r.default_category_id) = c.id
      WHERE t.is_active = true
        ${includeTransfers ? '' : 'AND t.is_transfer = false'}
        AND COALESCE(t.category_id, r.default_category_id) IS NOT NULL
        ${exclusionWhere}
      GROUP BY COALESCE(t.category_id, r.default_category_id), CONCAT(c.general, ': ', c.detail), TO_CHAR(t.date, 'YYYY-MM'), t.date, t.currency
      ORDER BY period
    `;

    const result = await query(sql, params);

    // Two conversion legs per group (income + expense) so each converts at its
    // own date's rate. cnt is the whole group's count — counted once (income leg).
    const convRows = [];
    for (const r of result.rows) {
      const base = { period: r.period, category_id: r.category_id, category_name: r.category_name, date: r.date, currency: r.currency, cnt: parseInt(r.cnt, 10) || 0 };
      convRows.push({ ...base, _leg: 'income', amount: Number(r.income) || 0 });
      convRows.push({ ...base, _leg: 'expense', amount: Number(r.expense) || 0 });
    }

    const converted = await convertRowsToEur(
      mapRowsForAmountConversion(convRows, 'amount', false),
      targetCurrency,
      { useHistoricalRatesByDate: true, dateField: 'date' }
    );

    /**
     * @type {Record<string, Record<string, {
     *   categoryId: number|null, categoryName: string,
     *   total: number, income: number, expense: number, transactionCount: number,
     * }>>}
     */
    const periodCatMap = {};
    for (const row of converted) {
      const period = row.period;
      const catId = row.category_id ? parseInt(row.category_id, 10) : null;
      const catName = row.category_name || 'Uncategorised';
      const eur = row.amount_eur;
      const catKey = catId ?? 'null';

      if (!periodCatMap[period]) periodCatMap[period] = {};
      if (!periodCatMap[period][catKey]) {
        periodCatMap[period][catKey] = { categoryId: catId, categoryName: catName, total: 0, income: 0, expense: 0, transactionCount: 0 };
      }
      const cell = periodCatMap[period][catKey];
      cell.total += eur;
      if (row._leg === 'income') {
        cell.income += eur;
        cell.transactionCount += row.cnt;
      } else {
        cell.expense += eur;
      }
    }

    /**
     * @type {Record<string, Array<{
     *   categoryId: number|null, categoryName: string,
     *   total: number, income: number, expense: number, transactionCount: number,
     * }>>}
     */
    const categoryPivot = {};
    for (const [period, cats] of Object.entries(periodCatMap)) {
      categoryPivot[period] = Object.values(cats)
        .map(c => ({ ...c, total: roundToCents(c.total), income: roundToCents(c.income), expense: roundToCents(c.expense) }))
        .sort((a, b) => a.total - b.total);
    }

    return { categoryPivot };
  },
};
