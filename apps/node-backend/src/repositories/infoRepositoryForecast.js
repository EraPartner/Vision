/**
 * Cash-flow forecast queries:
 *   - getCashflowComparison: cumulative-daily avg-vs-current for chart.
 *   - getCashflowForecastData: raw daily-net series for forecast pipeline.
 *   - getCashflowForecastDataByCategory: per-category variant.
 */

import { query } from '../database/connection.js';
import {
  roundToCents,
  formatDateToYmd,
  mapRowsForAmountConversion,
  batchConvertGroupsWithHistoricalRateFallback,
} from './infoRepositoryHelpers.js';
import { todayAppDateString } from '../lib/timezone.js';
import { ValidationError } from '../middleware/errorHandler.js';
import { buildExclusionClauses } from '../lib/filterBuilder.js';

// Sum converted rows into a sorted per-day net series (SIMP-50).
/**
 * @param {Array<Record<string, any>>} rows Converted rows with `date` + `amount_eur`.
 * @returns {Array<{ date: string, net: number }>}
 */
function aggregateByDate(rows) {
  /** @type {Map<string, number>} */
  const map = new Map();
  for (const r of rows) {
    const iso = r.date instanceof Date ? formatDateToYmd(r.date) : String(r.date).slice(0, 10);
    map.set(iso, (map.get(iso) ?? 0) + (Number(r.amount_eur) || 0));
  }
  return Array.from(map, ([date, net]) => ({ date, net })).sort((a, b) => a.date.localeCompare(b.date));
}

// Average, across months, of the running cumulative day-of-month net (SIMP-50).
// `monthDayNet` is { monthKey: { dayOfMonth: net } }.
/**
 * @param {Record<string, Record<string, number>>} monthDayNet
 * @returns {Record<string, number>} day-of-month → average cumulative net
 */
function computeAvgCumulativeByDay(monthDayNet) {
  const monthKeys = Object.keys(monthDayNet);
  const monthCount = monthKeys.length || 1;
  /** @type {Record<string, number>} */
  const out = {};
  for (const mk of monthKeys) {
    const dayNet = monthDayNet[mk];
    let cum = 0;
    for (let d = 1; d <= 31; d++) {
      cum += (dayNet[d] || 0);
      out[d] = (out[d] || 0) + cum;
    }
  }
  for (const d of Object.keys(out)) {
    out[d] /= monthCount;
  }
  return out;
}

/**
 * @param {number[]} [excludedCategoryIds]
 * @param {number[]} [excludedRecipientIds]
 * @param {string} [targetCurrency]
 */
export async function getCashflowComparison(
  excludedCategoryIds = [],
  excludedRecipientIds = [],
  targetCurrency = 'EUR',
) {
  // App-timezone today (ADR-009) — server-local getters could disagree with
  // the SQL paths' CURRENT_DATE around a day boundary.
  const todayYmd = todayAppDateString();
  const daysInMonth = new Date(Date.UTC(
    Number(todayYmd.slice(0, 4)),
    Number(todayYmd.slice(5, 7)),
    0,
  )).getUTCDate();
  const currentDay = Number(todayYmd.slice(8, 10));
  const HISTORY_MONTHS = 24;

  // Canonical exclusion clauses (lib/filterBuilder.js). The joins are only
  // needed when a clause actually references r/pr, so they stay conditional.
  const excl = buildExclusionClauses({ excludedCategoryIds, excludedRecipientIds });
  const categoryExclusionJoin = excl.whereSql ? excl.joinSql : '';
  const categoryExclusionWhere = excl.whereSql ? `AND ${excl.whereSql}` : '';
  const excludeParams = excl.params;

  // Aggregate in SQL per (date, currency) rather than streaming every row to
  // Node. batchConvertGroupsWithHistoricalRateFallback converts by (currency,
  // date), and every consumer below re-buckets by date — and rows sharing a
  // (date, currency) share one rate — so SUM-then-convert is identical to
  // convert-then-SUM. day_of_month/month_key are deterministic functions of the
  // grouped date column, so they remain valid in the SELECT list.
  const sqlPast = `
    SELECT SUM(t.amount) AS amount, t.currency, t.date,
           EXTRACT(DAY FROM t.date)::int AS day_of_month,
           TO_CHAR(date_trunc('month', t.date), 'YYYY-MM') AS month_key
    FROM transactions t
    ${categoryExclusionJoin}
    WHERE t.is_active = true
      AND t.date >= date_trunc('month', CURRENT_DATE) - interval '${HISTORY_MONTHS} months'
      AND t.date < date_trunc('month', CURRENT_DATE)
      ${categoryExclusionWhere}
    GROUP BY t.date, t.currency
  `;

  const sqlCurrent = `
    SELECT SUM(t.amount) AS amount, t.currency, t.date,
           EXTRACT(DAY FROM t.date)::int AS day_of_month
    FROM transactions t
    ${categoryExclusionJoin}
    WHERE t.is_active = true
      AND t.date >= date_trunc('month', CURRENT_DATE)
      AND t.date <= CURRENT_DATE
      ${categoryExclusionWhere}
    GROUP BY t.date, t.currency
  `;

  const sqlPlannedCurrent = `
    SELECT SUM(pt.amount) AS amount, pt.currency, pt.planned_date,
           EXTRACT(DAY FROM pt.planned_date)::int AS day_of_month
    FROM planned_transactions pt
    WHERE pt.is_active = true
      AND pt.is_executed = false
      AND pt.planned_date >= date_trunc('month', CURRENT_DATE)
      AND pt.planned_date <= (date_trunc('month', CURRENT_DATE) + interval '1 month' - interval '1 day')
    GROUP BY pt.planned_date, pt.currency
  `;

  const sqlPlannedHist = `
    SELECT SUM(pt.amount) AS amount, pt.currency, pt.planned_date,
           EXTRACT(DAY FROM pt.planned_date)::int AS day_of_month,
           TO_CHAR(date_trunc('month', pt.planned_date), 'YYYY-MM') AS month_key
    FROM planned_transactions pt
    WHERE pt.is_active = true
      AND pt.is_executed = false
      AND pt.planned_date >= date_trunc('month', CURRENT_DATE) - interval '${HISTORY_MONTHS} months'
      AND pt.planned_date < date_trunc('month', CURRENT_DATE)
    GROUP BY pt.planned_date, pt.currency
  `;

  const [pastResult, currentResult, plannedCurrentResult, plannedHistResult] = await Promise.all([
    query(sqlPast, excludeParams),
    query(sqlCurrent, excludeParams),
    query(sqlPlannedCurrent),
    query(sqlPlannedHist),
  ]);

  const [pastConverted, currentCashflowConverted, plannedCurrentConverted, plannedHistConverted] =
    await batchConvertGroupsWithHistoricalRateFallback(
      [
        mapRowsForAmountConversion(pastResult.rows, 'amount', false),
        mapRowsForAmountConversion(currentResult.rows, 'amount', false),
        mapRowsForAmountConversion(plannedCurrentResult.rows, 'amount', false),
        mapRowsForAmountConversion(plannedHistResult.rows, 'amount', false),
      ],
      targetCurrency,
      'date'
    );

  /** @type {Record<string, Record<string, number>>} */
  const monthDayNet = {};
  for (const row of pastConverted) {
    const eur = row.amount_eur;
    const mk = row.month_key;
    if (!monthDayNet[mk]) monthDayNet[mk] = {};
    monthDayNet[mk][row.day_of_month] = (monthDayNet[mk][row.day_of_month] || 0) + eur;
  }

  const avgCumulativeByDay = computeAvgCumulativeByDay(monthDayNet);

  /** @type {Record<string, number>} */
  const currentDayNet = {};
  for (const row of currentCashflowConverted) {
    currentDayNet[row.day_of_month] = (currentDayNet[row.day_of_month] || 0) + row.amount_eur;
  }

  let currentCum = 0;
  /** @type {Record<string, number>} */
  const currentByDay = {};
  for (let d = 1; d <= currentDay; d++) {
    currentCum += (currentDayNet[d] || 0);
    currentByDay[d] = currentCum;
  }

  /** @type {Record<string, number>} */
  const plannedCurrentByDay = {};
  for (const row of plannedCurrentConverted) {
    plannedCurrentByDay[row.day_of_month] = (plannedCurrentByDay[row.day_of_month] || 0) + row.amount_eur;
  }

  /** @type {Record<string, Record<string, number>>} */
  const plannedHistMonthDay = {};
  for (const row of plannedHistConverted) {
    const mk = row.month_key;
    if (!plannedHistMonthDay[mk]) plannedHistMonthDay[mk] = {};
    plannedHistMonthDay[mk][row.day_of_month] = (plannedHistMonthDay[mk][row.day_of_month] || 0) + row.amount_eur;
  }

  const avgPlannedCumByDay = computeAvgCumulativeByDay(plannedHistMonthDay);

  const withoutPlanned = [];
  const withPlanned = [];
  let plannedCum = 0;

  for (let day = 1; day <= daysInMonth; day++) {
    const avg = avgCumulativeByDay[day] !== undefined ? avgCumulativeByDay[day] : (avgCumulativeByDay[day - 1] || 0);
    const current = day <= currentDay ? currentByDay[day] : null;

    withoutPlanned.push({
      day,
      average: roundToCents(avg),
      current: current !== null ? roundToCents(current) : null,
    });

    const avgPlanned = avgPlannedCumByDay[day] !== undefined ? avgPlannedCumByDay[day] : (avgPlannedCumByDay[day - 1] || 0);
    plannedCum += (plannedCurrentByDay[day] || 0);
    const currentWithPlanned = current !== null ? current + plannedCum : null;

    withPlanned.push({
      day,
      average: roundToCents(avg + avgPlanned),
      current: currentWithPlanned !== null ? roundToCents(currentWithPlanned) : null,
    });
  }

  return {
    days_in_month: daysInMonth,
    current_day: currentDay,
    month: Number(todayYmd.slice(5, 7)),
    year: Number(todayYmd.slice(0, 4)),
    without_planned: withoutPlanned,
    with_planned: withPlanned,
  };
}

/**
 * @param {number} historyMonths
 * @param {number[]} [excludedCategoryIds]
 * @param {number[]} [excludedRecipientIds]
 * @param {string} [targetCurrency]
 */
export async function getCashflowForecastData(
  historyMonths,
  excludedCategoryIds = [],
  excludedRecipientIds = [],
  targetCurrency = 'EUR',
) {
  if (!Number.isInteger(historyMonths) || historyMonths < 1 || historyMonths > 120) {
    throw new ValidationError('historyMonths must be an integer in [1, 120]');
  }

  // Canonical exclusion clauses (lib/filterBuilder.js); joins stay conditional.
  const excl = buildExclusionClauses({ excludedCategoryIds, excludedRecipientIds });
  const categoryExclusionJoin = excl.whereSql ? excl.joinSql : '';
  const categoryExclusionWhere = excl.whereSql ? `AND ${excl.whereSql}` : '';
  const excludeParams = excl.params;

  // GROUP BY (date, currency) in SQL — aggregateByDate re-buckets by date and
  // conversion is per (currency, date), so this is identical to the old per-row
  // stream (see getCashflowComparison for the full rationale).
  const sqlHistory = `
    SELECT SUM(t.amount) AS amount, t.currency, t.date
    FROM transactions t
    ${categoryExclusionJoin}
    WHERE t.is_active = true
      AND t.date >= date_trunc('month', CURRENT_DATE) - interval '${historyMonths} months'
      AND t.date < date_trunc('month', CURRENT_DATE)
      ${categoryExclusionWhere}
    GROUP BY t.date, t.currency
  `;
  const sqlCurrent = `
    SELECT SUM(t.amount) AS amount, t.currency, t.date
    FROM transactions t
    ${categoryExclusionJoin}
    WHERE t.is_active = true
      AND t.date >= date_trunc('month', CURRENT_DATE)
      AND t.date <= CURRENT_DATE
      ${categoryExclusionWhere}
    GROUP BY t.date, t.currency
  `;
  const sqlPlannedCurrent = `
    SELECT SUM(pt.amount) AS amount, pt.currency, pt.planned_date AS date
    FROM planned_transactions pt
    WHERE pt.is_active = true
      AND pt.is_executed = false
      AND pt.planned_date >= date_trunc('month', CURRENT_DATE)
      AND pt.planned_date <= (date_trunc('month', CURRENT_DATE) + interval '1 month' - interval '1 day')
    GROUP BY pt.planned_date, pt.currency
  `;
  const sqlPlannedHist = `
    SELECT SUM(pt.amount) AS amount, pt.currency, pt.planned_date AS date
    FROM planned_transactions pt
    WHERE pt.is_active = true
      AND pt.is_executed = false
      AND pt.planned_date >= date_trunc('month', CURRENT_DATE) - interval '${historyMonths} months'
      AND pt.planned_date < date_trunc('month', CURRENT_DATE)
    GROUP BY pt.planned_date, pt.currency
  `;

  const [histRes, currentRes, plannedCurRes, plannedHistRes] = await Promise.all([
    query(sqlHistory, excludeParams),
    query(sqlCurrent, excludeParams),
    query(sqlPlannedCurrent),
    query(sqlPlannedHist),
  ]);

  const [histConv, currentConv, plannedCurConv, plannedHistConv] =
    await batchConvertGroupsWithHistoricalRateFallback(
      [
        mapRowsForAmountConversion(histRes.rows, 'amount', false),
        mapRowsForAmountConversion(currentRes.rows, 'amount', false),
        mapRowsForAmountConversion(plannedCurRes.rows, 'amount', false),
        mapRowsForAmountConversion(plannedHistRes.rows, 'amount', false),
      ],
      targetCurrency,
      'date'
    );

  return {
    history: aggregateByDate(histConv),
    currentActual: aggregateByDate(currentConv),
    plannedCurrent: aggregateByDate(plannedCurConv),
    plannedHist: aggregateByDate(plannedHistConv),
    historyMonths,
  };
}

/**
 * @param {number} historyMonths
 * @param {number} daysBack
 * @param {number} daysForward
 * @param {number[]} [excludedCategoryIds]
 * @param {number[]} [excludedRecipientIds]
 * @param {string} [targetCurrency]
 */
export async function getCashflowForecastDataRolling(
  historyMonths,
  daysBack,
  daysForward,
  excludedCategoryIds = [],
  excludedRecipientIds = [],
  targetCurrency = 'EUR',
) {
  if (!Number.isInteger(historyMonths) || historyMonths < 1 || historyMonths > 120) {
    throw new ValidationError('historyMonths must be an integer in [1, 120]');
  }
  if (!Number.isInteger(daysBack) || daysBack < 1 || daysBack > 365) {
    throw new ValidationError('daysBack must be an integer in [1, 365]');
  }
  if (!Number.isInteger(daysForward) || daysForward < 1 || daysForward > 365) {
    throw new ValidationError('daysForward must be an integer in [1, 365]');
  }

  // Canonical exclusion clauses (lib/filterBuilder.js); joins stay conditional.
  const excl = buildExclusionClauses({ excludedCategoryIds, excludedRecipientIds });
  const categoryExclusionJoin = excl.whereSql ? excl.joinSql : '';
  const categoryExclusionWhere = excl.whereSql ? `AND ${excl.whereSql}` : '';
  const excludeParams = excl.params;

  // History ends at `today - daysBack` (exclusive) so it never overlaps with currentActual.
  // GROUP BY (date, currency) — identical to the old per-row stream (aggregateByDate re-buckets by date).
  const sqlHistory = `
    SELECT SUM(t.amount) AS amount, t.currency, t.date
    FROM transactions t
    ${categoryExclusionJoin}
    WHERE t.is_active = true
      AND t.date >= (CURRENT_DATE - interval '${daysBack} days') - interval '${historyMonths} months'
      AND t.date < (CURRENT_DATE - interval '${daysBack} days')
      ${categoryExclusionWhere}
    GROUP BY t.date, t.currency
  `;
  const sqlCurrent = `
    SELECT SUM(t.amount) AS amount, t.currency, t.date
    FROM transactions t
    ${categoryExclusionJoin}
    WHERE t.is_active = true
      AND t.date >= (CURRENT_DATE - interval '${daysBack} days')
      AND t.date <= CURRENT_DATE
      ${categoryExclusionWhere}
    GROUP BY t.date, t.currency
  `;
  const sqlPlannedFuture = `
    SELECT SUM(pt.amount) AS amount, pt.currency, pt.planned_date AS date
    FROM planned_transactions pt
    WHERE pt.is_active = true
      AND pt.is_executed = false
      AND pt.planned_date > CURRENT_DATE
      AND pt.planned_date <= (CURRENT_DATE + interval '${daysForward} days')
    GROUP BY pt.planned_date, pt.currency
  `;

  const [histRes, currentRes, plannedRes] = await Promise.all([
    query(sqlHistory, excludeParams),
    query(sqlCurrent, excludeParams),
    query(sqlPlannedFuture),
  ]);

  const [histConv, currentConv, plannedConv] =
    await batchConvertGroupsWithHistoricalRateFallback(
      [
        mapRowsForAmountConversion(histRes.rows, 'amount', false),
        mapRowsForAmountConversion(currentRes.rows, 'amount', false),
        mapRowsForAmountConversion(plannedRes.rows, 'amount', false),
      ],
      targetCurrency,
      'date',
    );

  return {
    history: aggregateByDate(histConv),
    currentActual: aggregateByDate(currentConv),
    plannedCurrent: aggregateByDate(plannedConv),
    historyMonths,
  };
}

/**
 * @param {number} historyMonths
 * @param {number[]} [excludedCategoryIds]
 * @param {number[]} [excludedRecipientIds]
 * @param {string} [targetCurrency]
 */
export async function getCashflowForecastDataByCategory(
  historyMonths,
  excludedCategoryIds = [],
  excludedRecipientIds = [],
  targetCurrency = 'EUR',
) {
  if (!Number.isInteger(historyMonths) || historyMonths < 1 || historyMonths > 120) {
    throw new ValidationError('historyMonths must be an integer in [1, 120]');
  }

  // Canonical exclusion clauses (lib/filterBuilder.js). The r/pr joins are
  // unconditional here (the effective-category COALESCE needs them anyway).
  const excl = buildExclusionClauses({ excludedCategoryIds, excludedRecipientIds });
  const excludeParams = excl.params;
  const exclusionWhere = excl.whereSql ? `AND ${excl.whereSql}` : '';

  // Aggregate per (date, currency, effective category) in SQL — aggregateByDateAndCategory
  // re-buckets by (date, category) and conversion is per (currency, date), so SUM-then-convert
  // is identical to the old per-row stream.
  const selectCols = `
    SUM(t.amount) AS amount,
    t.currency,
    t.date,
    COALESCE(t.category_id, r.default_category_id, pr.default_category_id) AS category_id,
    COALESCE(cat.general, 'Uncategorized')                                  AS general,
    COALESCE(cat.detail,  'Uncategorized')                                  AS detail
  `;
  const groupByCols = `
    GROUP BY t.date, t.currency,
             COALESCE(t.category_id, r.default_category_id, pr.default_category_id),
             cat.general, cat.detail
  `;
  const joins = `
    LEFT JOIN recipients r  ON t.recipient_id = r.id
    LEFT JOIN recipients pr ON r.primary_recipient_id = pr.id
    LEFT JOIN categories cat
      ON cat.id = COALESCE(t.category_id, r.default_category_id, pr.default_category_id)
  `;

  const sqlHistory = `
    SELECT ${selectCols}
    FROM transactions t ${joins}
    WHERE t.is_active = true
      AND t.date >= date_trunc('month', CURRENT_DATE) - interval '${historyMonths} months'
      AND t.date <  date_trunc('month', CURRENT_DATE)
      ${exclusionWhere}
    ${groupByCols}
  `;
  const sqlCurrent = `
    SELECT ${selectCols}
    FROM transactions t ${joins}
    WHERE t.is_active = true
      AND t.date >= date_trunc('month', CURRENT_DATE)
      AND t.date <= CURRENT_DATE
      ${exclusionWhere}
    ${groupByCols}
  `;

  const [histRes, currentRes] = await Promise.all([
    query(sqlHistory, excludeParams),
    query(sqlCurrent, excludeParams),
  ]);

  const [histConv, currentConv] = await batchConvertGroupsWithHistoricalRateFallback(
    [
      mapRowsForAmountConversion(histRes.rows, 'amount', false),
      mapRowsForAmountConversion(currentRes.rows, 'amount', false),
    ],
    targetCurrency,
    'date',
  );

  /**
   * @param {Array<Record<string, any>>} rows
   * @returns {Array<{ date: string, category_id: number|null, general: string, detail: string, net: number }>}
   */
  const aggregateByDateAndCategory = (rows) => {
    /** @type {Map<string, { date: string, category_id: number|null, general: string, detail: string, net: number }>} */
    const map = new Map();
    for (const r of rows) {
      const date = r.date instanceof Date ? formatDateToYmd(r.date) : String(r.date).slice(0, 10);
      const key = `${date}|${r.category_id ?? 'null'}`;
      if (!map.has(key)) {
        map.set(key, {
          date,
          category_id: r.category_id ?? null,
          general: r.general ?? 'Uncategorized',
          detail: r.detail ?? 'Uncategorized',
          net: 0,
        });
      }
      map.get(key).net += Number(r.amount_eur) || 0;
    }
    return Array.from(map.values()).sort((a, b) => a.date.localeCompare(b.date));
  };

  return {
    historyByCategory: aggregateByDateAndCategory(histConv),
    currentActualByCategory: aggregateByDateAndCategory(currentConv),
  };
}
