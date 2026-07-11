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

export async function getCashflowComparison(
  excludedCategoryIds = [],
  excludedRecipientIds = [],
  targetCurrency = 'EUR',
) {
  const now = new Date();
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const currentDay = now.getDate();
  const HISTORY_MONTHS = 24;

  const validCatIds = excludedCategoryIds.filter(id => Number.isInteger(id) && id > 0 && id < 2147483647);
  const validRecIds = excludedRecipientIds.filter(id => Number.isInteger(id) && id > 0 && id < 2147483647);

  let categoryExclusionJoin = '';
  let categoryExclusionWhere = '';
  const excludeParams = [];
  let paramIdx = 1;

  if (validCatIds.length > 0 || validRecIds.length > 0) {
    categoryExclusionJoin = `
      LEFT JOIN recipients r ON t.recipient_id = r.id
      LEFT JOIN recipients pr ON r.primary_recipient_id = pr.id
    `;
  }

  if (validCatIds.length > 0) {
    const placeholders = validCatIds.map(() => `$${paramIdx++}`).join(', ');
    categoryExclusionWhere += `
      AND COALESCE(t.category_id, r.default_category_id, pr.default_category_id, -1) NOT IN (${placeholders})
    `;
    excludeParams.push(...validCatIds);
  }

  if (validRecIds.length > 0) {
    const placeholders = validRecIds.map(() => `$${paramIdx++}`).join(', ');
    categoryExclusionWhere += `
      AND COALESCE(r.primary_recipient_id, t.recipient_id, -1) NOT IN (${placeholders})
    `;
    excludeParams.push(...validRecIds);
  }

  const sqlPast = `
    SELECT t.amount, t.currency, t.date,
           EXTRACT(DAY FROM t.date)::int AS day_of_month,
           TO_CHAR(date_trunc('month', t.date), 'YYYY-MM') AS month_key
    FROM transactions t
    ${categoryExclusionJoin}
    WHERE t.is_active = true
      AND t.date >= date_trunc('month', CURRENT_DATE) - interval '${HISTORY_MONTHS} months'
      AND t.date < date_trunc('month', CURRENT_DATE)
      ${categoryExclusionWhere}
  `;

  const sqlCurrent = `
    SELECT t.amount, t.currency, t.date,
           EXTRACT(DAY FROM t.date)::int AS day_of_month
    FROM transactions t
    ${categoryExclusionJoin}
    WHERE t.is_active = true
      AND t.date >= date_trunc('month', CURRENT_DATE)
      AND t.date <= CURRENT_DATE
      ${categoryExclusionWhere}
  `;

  const sqlPlannedCurrent = `
    SELECT pt.amount, pt.currency, pt.planned_date,
           EXTRACT(DAY FROM pt.planned_date)::int AS day_of_month
    FROM planned_transactions pt
    WHERE pt.is_active = true
      AND pt.is_executed = false
      AND pt.planned_date >= date_trunc('month', CURRENT_DATE)
      AND pt.planned_date <= (date_trunc('month', CURRENT_DATE) + interval '1 month' - interval '1 day')
  `;

  const sqlPlannedHist = `
    SELECT pt.amount, pt.currency, pt.planned_date,
           EXTRACT(DAY FROM pt.planned_date)::int AS day_of_month,
           TO_CHAR(date_trunc('month', pt.planned_date), 'YYYY-MM') AS month_key
    FROM planned_transactions pt
    WHERE pt.is_active = true
      AND pt.is_executed = false
      AND pt.planned_date >= date_trunc('month', CURRENT_DATE) - interval '${HISTORY_MONTHS} months'
      AND pt.planned_date < date_trunc('month', CURRENT_DATE)
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

  const monthDayNet = {};
  for (const row of pastConverted) {
    const eur = row.amount_eur;
    const mk = row.month_key;
    if (!monthDayNet[mk]) monthDayNet[mk] = {};
    monthDayNet[mk][row.day_of_month] = (monthDayNet[mk][row.day_of_month] || 0) + eur;
  }

  const monthKeys = Object.keys(monthDayNet);
  const monthCount = monthKeys.length || 1;
  const avgCumulativeByDay = {};
  for (const mk of monthKeys) {
    const dayNet = monthDayNet[mk];
    let cum = 0;
    for (let d = 1; d <= 31; d++) {
      cum += (dayNet[d] || 0);
      avgCumulativeByDay[d] = (avgCumulativeByDay[d] || 0) + cum;
    }
  }
  for (const d of Object.keys(avgCumulativeByDay)) {
    avgCumulativeByDay[d] /= monthCount;
  }

  const currentDayNet = {};
  for (const row of currentCashflowConverted) {
    currentDayNet[row.day_of_month] = (currentDayNet[row.day_of_month] || 0) + row.amount_eur;
  }

  let currentCum = 0;
  const currentByDay = {};
  for (let d = 1; d <= currentDay; d++) {
    currentCum += (currentDayNet[d] || 0);
    currentByDay[d] = currentCum;
  }

  const plannedCurrentByDay = {};
  for (const row of plannedCurrentConverted) {
    plannedCurrentByDay[row.day_of_month] = (plannedCurrentByDay[row.day_of_month] || 0) + row.amount_eur;
  }

  const plannedHistMonthDay = {};
  for (const row of plannedHistConverted) {
    const mk = row.month_key;
    if (!plannedHistMonthDay[mk]) plannedHistMonthDay[mk] = {};
    plannedHistMonthDay[mk][row.day_of_month] = (plannedHistMonthDay[mk][row.day_of_month] || 0) + row.amount_eur;
  }

  const plannedHistMonthKeys = Object.keys(plannedHistMonthDay);
  const plannedHistCount = plannedHistMonthKeys.length || 1;
  const avgPlannedCumByDay = {};
  for (const mk of plannedHistMonthKeys) {
    const dayNet = plannedHistMonthDay[mk];
    let cum = 0;
    for (let d = 1; d <= 31; d++) {
      cum += (dayNet[d] || 0);
      avgPlannedCumByDay[d] = (avgPlannedCumByDay[d] || 0) + cum;
    }
  }
  for (const d of Object.keys(avgPlannedCumByDay)) {
    avgPlannedCumByDay[d] /= plannedHistCount;
  }

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
    month: now.getMonth() + 1,
    year: now.getFullYear(),
    without_planned: withoutPlanned,
    with_planned: withPlanned,
  };
}

export async function getCashflowForecastData(
  historyMonths,
  excludedCategoryIds = [],
  excludedRecipientIds = [],
  targetCurrency = 'EUR',
) {
  if (!Number.isInteger(historyMonths) || historyMonths < 1 || historyMonths > 120) {
    throw new Error('historyMonths must be an integer in [1, 120]');
  }

  const validCatIds = (excludedCategoryIds || []).filter(id => Number.isInteger(id) && id > 0 && id < 2147483647);
  const validRecIds = (excludedRecipientIds || []).filter(id => Number.isInteger(id) && id > 0 && id < 2147483647);

  let categoryExclusionJoin = '';
  let categoryExclusionWhere = '';
  const excludeParams = [];
  let paramIdx = 1;

  if (validCatIds.length > 0 || validRecIds.length > 0) {
    categoryExclusionJoin = `
      LEFT JOIN recipients r ON t.recipient_id = r.id
      LEFT JOIN recipients pr ON r.primary_recipient_id = pr.id
    `;
  }
  if (validCatIds.length > 0) {
    const placeholders = validCatIds.map(() => `$${paramIdx++}`).join(', ');
    categoryExclusionWhere += `
      AND COALESCE(t.category_id, r.default_category_id, pr.default_category_id, -1) NOT IN (${placeholders})
    `;
    excludeParams.push(...validCatIds);
  }
  if (validRecIds.length > 0) {
    const placeholders = validRecIds.map(() => `$${paramIdx++}`).join(', ');
    categoryExclusionWhere += `
      AND COALESCE(r.primary_recipient_id, t.recipient_id, -1) NOT IN (${placeholders})
    `;
    excludeParams.push(...validRecIds);
  }

  const sqlHistory = `
    SELECT t.amount, t.currency, t.date
    FROM transactions t
    ${categoryExclusionJoin}
    WHERE t.is_active = true
      AND t.date >= date_trunc('month', CURRENT_DATE) - interval '${historyMonths} months'
      AND t.date < date_trunc('month', CURRENT_DATE)
      ${categoryExclusionWhere}
  `;
  const sqlCurrent = `
    SELECT t.amount, t.currency, t.date
    FROM transactions t
    ${categoryExclusionJoin}
    WHERE t.is_active = true
      AND t.date >= date_trunc('month', CURRENT_DATE)
      AND t.date <= CURRENT_DATE
      ${categoryExclusionWhere}
  `;
  const sqlPlannedCurrent = `
    SELECT pt.amount, pt.currency, pt.planned_date AS date
    FROM planned_transactions pt
    WHERE pt.is_active = true
      AND pt.is_executed = false
      AND pt.planned_date >= date_trunc('month', CURRENT_DATE)
      AND pt.planned_date <= (date_trunc('month', CURRENT_DATE) + interval '1 month' - interval '1 day')
  `;
  const sqlPlannedHist = `
    SELECT pt.amount, pt.currency, pt.planned_date AS date
    FROM planned_transactions pt
    WHERE pt.is_active = true
      AND pt.is_executed = false
      AND pt.planned_date >= date_trunc('month', CURRENT_DATE) - interval '${historyMonths} months'
      AND pt.planned_date < date_trunc('month', CURRENT_DATE)
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

  const aggregateByDate = (rows) => {
    const map = new Map();
    for (const r of rows) {
      const iso = r.date instanceof Date ? formatDateToYmd(r.date) : String(r.date).slice(0, 10);
      map.set(iso, (map.get(iso) ?? 0) + (Number(r.amount_eur) || 0));
    }
    return Array.from(map, ([date, net]) => ({ date, net })).sort((a, b) => a.date.localeCompare(b.date));
  };

  return {
    history: aggregateByDate(histConv),
    currentActual: aggregateByDate(currentConv),
    plannedCurrent: aggregateByDate(plannedCurConv),
    plannedHist: aggregateByDate(plannedHistConv),
    historyMonths,
  };
}

export async function getCashflowForecastDataRolling(
  historyMonths,
  daysBack,
  daysForward,
  excludedCategoryIds = [],
  excludedRecipientIds = [],
  targetCurrency = 'EUR',
) {
  if (!Number.isInteger(historyMonths) || historyMonths < 1 || historyMonths > 120) {
    throw new Error('historyMonths must be an integer in [1, 120]');
  }
  if (!Number.isInteger(daysBack) || daysBack < 1 || daysBack > 365) {
    throw new Error('daysBack must be an integer in [1, 365]');
  }
  if (!Number.isInteger(daysForward) || daysForward < 1 || daysForward > 365) {
    throw new Error('daysForward must be an integer in [1, 365]');
  }

  const validCatIds = (excludedCategoryIds || []).filter(id => Number.isInteger(id) && id > 0 && id < 2147483647);
  const validRecIds = (excludedRecipientIds || []).filter(id => Number.isInteger(id) && id > 0 && id < 2147483647);

  let categoryExclusionJoin = '';
  let categoryExclusionWhere = '';
  const excludeParams = [];
  let paramIdx = 1;

  if (validCatIds.length > 0 || validRecIds.length > 0) {
    categoryExclusionJoin = `
      LEFT JOIN recipients r ON t.recipient_id = r.id
      LEFT JOIN recipients pr ON r.primary_recipient_id = pr.id
    `;
  }
  if (validCatIds.length > 0) {
    const placeholders = validCatIds.map(() => `$${paramIdx++}`).join(', ');
    categoryExclusionWhere += `
      AND COALESCE(t.category_id, r.default_category_id, pr.default_category_id, -1) NOT IN (${placeholders})
    `;
    excludeParams.push(...validCatIds);
  }
  if (validRecIds.length > 0) {
    const placeholders = validRecIds.map(() => `$${paramIdx++}`).join(', ');
    categoryExclusionWhere += `
      AND COALESCE(r.primary_recipient_id, t.recipient_id, -1) NOT IN (${placeholders})
    `;
    excludeParams.push(...validRecIds);
  }

  // History ends at `today - daysBack` (exclusive) so it never overlaps with currentActual.
  const sqlHistory = `
    SELECT t.amount, t.currency, t.date
    FROM transactions t
    ${categoryExclusionJoin}
    WHERE t.is_active = true
      AND t.date >= (CURRENT_DATE - interval '${daysBack} days') - interval '${historyMonths} months'
      AND t.date < (CURRENT_DATE - interval '${daysBack} days')
      ${categoryExclusionWhere}
  `;
  const sqlCurrent = `
    SELECT t.amount, t.currency, t.date
    FROM transactions t
    ${categoryExclusionJoin}
    WHERE t.is_active = true
      AND t.date >= (CURRENT_DATE - interval '${daysBack} days')
      AND t.date <= CURRENT_DATE
      ${categoryExclusionWhere}
  `;
  const sqlPlannedFuture = `
    SELECT pt.amount, pt.currency, pt.planned_date AS date
    FROM planned_transactions pt
    WHERE pt.is_active = true
      AND pt.is_executed = false
      AND pt.planned_date > CURRENT_DATE
      AND pt.planned_date <= (CURRENT_DATE + interval '${daysForward} days')
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

  const aggregateByDate = (rows) => {
    const map = new Map();
    for (const r of rows) {
      const iso = r.date instanceof Date ? formatDateToYmd(r.date) : String(r.date).slice(0, 10);
      map.set(iso, (map.get(iso) ?? 0) + (Number(r.amount_eur) || 0));
    }
    return Array.from(map, ([date, net]) => ({ date, net })).sort((a, b) => a.date.localeCompare(b.date));
  };

  return {
    history: aggregateByDate(histConv),
    currentActual: aggregateByDate(currentConv),
    plannedCurrent: aggregateByDate(plannedConv),
    historyMonths,
  };
}

export async function getCashflowForecastDataByCategory(
  historyMonths,
  excludedCategoryIds = [],
  excludedRecipientIds = [],
  targetCurrency = 'EUR',
) {
  if (!Number.isInteger(historyMonths) || historyMonths < 1 || historyMonths > 120) {
    throw new Error('historyMonths must be an integer in [1, 120]');
  }

  const validCatIds = (excludedCategoryIds || []).filter(
    (id) => Number.isInteger(id) && id > 0 && id < 2147483647,
  );
  const validRecIds = (excludedRecipientIds || []).filter(
    (id) => Number.isInteger(id) && id > 0 && id < 2147483647,
  );

  const excludeParams = [];
  let paramIdx = 1;

  let catExclusionWhere = '';
  let recExclusionWhere = '';

  if (validCatIds.length > 0) {
    const placeholders = validCatIds.map(() => `$${paramIdx++}`).join(', ');
    catExclusionWhere = `AND COALESCE(t.category_id, r.default_category_id, pr.default_category_id, -1) NOT IN (${placeholders})`;
    excludeParams.push(...validCatIds);
  }
  if (validRecIds.length > 0) {
    const placeholders = validRecIds.map(() => `$${paramIdx++}`).join(', ');
    recExclusionWhere = `AND COALESCE(r.primary_recipient_id, t.recipient_id, -1) NOT IN (${placeholders})`;
    excludeParams.push(...validRecIds);
  }

  const selectCols = `
    t.amount,
    t.currency,
    t.date,
    COALESCE(t.category_id, r.default_category_id, pr.default_category_id) AS category_id,
    COALESCE(cat.general, 'Uncategorized')                                  AS general,
    COALESCE(cat.detail,  'Uncategorized')                                  AS detail
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
      ${catExclusionWhere} ${recExclusionWhere}
  `;
  const sqlCurrent = `
    SELECT ${selectCols}
    FROM transactions t ${joins}
    WHERE t.is_active = true
      AND t.date >= date_trunc('month', CURRENT_DATE)
      AND t.date <= CURRENT_DATE
      ${catExclusionWhere} ${recExclusionWhere}
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

  const aggregateByDateAndCategory = (rows) => {
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
