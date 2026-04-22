/**
 * Info/Statistics Repository - data access for statistics and reporting.
 *
 * Uses materialized views (mv_*) for pre-computed aggregates when possible,
 * falling back to live queries for filtered / parameterised requests.
 *
 * All monetary aggregations convert amounts to EUR using the currency
 * conversion service, matching the Python backend behaviour.
 */

import { query, queryPrepared } from '../database/connection.js';
import { convertRowsToEur } from '../services/currency/currencyConversionService.js';
import { logger } from '../config/logger.js';

/**
 * Module-level cache for materialized view availability checks.
 * Views persist for the lifetime of the process — once confirmed available
 * we never need to probe again, eliminating one DB round-trip per hot-path call.
 * The cache is keyed by view name and cleared when a refresh is triggered
 * (e.g. after bulk import) via clearMvCache().
 */
const mvCache = new Map();

function sanitizeIsolatedDailyInvestmentSpikes(snapshots) {
  if (!Array.isArray(snapshots) || snapshots.length < 3) return Array.isArray(snapshots) ? snapshots : [];

  const sanitized = snapshots.map((snapshot) => ({ ...snapshot }));
  const minJump = Math.log(1.18);
  const neighborTolerance = Math.log(1.12);
  const localNeedleRatio = 1.8;

  for (let i = 1; i < sanitized.length - 1; i += 1) {
    const prev = Number(sanitized[i - 1]?.investments);
    const current = Number(sanitized[i]?.investments);
    const next = Number(sanitized[i + 1]?.investments);

    if (!Number.isFinite(prev) || !Number.isFinite(current) || !Number.isFinite(next)) continue;
    if (prev <= 0 || current <= 0 || next <= 0) continue;

    const jump = Math.log(current / prev);
    const revert = Math.log(next / current);
    const bridge = Math.log(next / prev);

    const oppositeDirections = (jump > 0 && revert < 0) || (jump < 0 && revert > 0);
    const largeMove = Math.abs(jump) >= minJump && Math.abs(revert) >= minJump;
    const bridgeLooksNormal = Math.abs(bridge) <= neighborTolerance;

    const maxNeighbor = Math.max(prev, next);
    const minNeighbor = Math.min(prev, next);
    const localNeedlePeak = current >= maxNeighbor * localNeedleRatio && bridgeLooksNormal;
    const localNeedleTrough = current * localNeedleRatio <= minNeighbor && bridgeLooksNormal;

    if ((oppositeDirections && largeMove && bridgeLooksNormal) || localNeedlePeak || localNeedleTrough) {
      const correctedInvestments = Math.sqrt(prev * next);
      const liquid = Number(sanitized[i]?.liquid) || 0;
      sanitized[i].investments = roundToCents(correctedInvestments);
      sanitized[i].netWorth = roundToCents(liquid + correctedInvestments);
    }
  }

  return sanitized;
}

/**
 * Helper: check if a materialized view exists and has rows.
 * Result is cached in-process after the first successful check.
 * Returns false if the view doesn't exist (first startup before schema init).
 */
async function mvAvailable(viewName) {
  if (mvCache.has(viewName)) return mvCache.get(viewName);
  try {
    const r = await query(`SELECT 1 FROM ${viewName} LIMIT 1`);
    const available = r.rows.length > 0;
    if (available) mvCache.set(viewName, true);
    return available;
  } catch {
    return false;
  }
}

function roundToCents(value) {
  return Math.round(value * 100) / 100;
}

function formatDateToYmd(date) {
  return date.toISOString().split('T')[0];
}

function formatDateToYm(date) {
  return date.toISOString().substring(0, 7);
}

function formatYearMonthKey(year, month) {
  return `${year}-${String(month).padStart(2, '0')}`;
}

function addDaysUtc(date, days = 1) {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function getDayKeyUtc(date) {
  const yyyy = date.getUTCFullYear();
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(date.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function getUtcDayEndTimestamp(date) {
  return Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate(),
    23,
    59,
    59,
    999
  );
}

function extractYearMonth(value) {
  return String(value).substring(0, 7);
}

function buildMonthlySummary(months) {
  return {
    total_spending: months.reduce((sum, month) => sum + month.total_spending, 0),
    total_income: months.reduce((sum, month) => sum + month.total_income, 0),
    net_amount: months.reduce((sum, month) => sum + month.net_amount, 0),
    transaction_count: months.reduce((sum, month) => sum + month.transaction_count, 0),
    period_start: months[0]?.period_start,
    period_end: months[months.length - 1]?.period_end,
  };
}

function mapRowsForAmountConversion(rows, amountField = 'amount', fallbackToZero = true) {
  return rows.map(row => ({
    ...row,
    amount: fallbackToZero
      ? parseFloat(row[amountField] || 0)
      : parseFloat(row[amountField]),
  }));
}

function getCategoryKey(categoryId) {
  return categoryId === -1 ? 'null' : String(categoryId);
}

function parseCategoryId(categoryId) {
  return categoryId === -1 ? null : parseInt(categoryId, 10);
}

function buildCategoryFromConvertedRows(convertedRows) {
  const categoryMap = new Map();

  for (const row of convertedRows) {
    const key = getCategoryKey(row.category_id);
    const eur = row.amount_eur;
    const count = parseInt(row.count, 10);

    const existing = categoryMap.get(key);
    if (existing) {
      existing.count += count;
      existing.total += roundToCents(eur);
      continue;
    }

    categoryMap.set(key, {
      id: parseCategoryId(row.category_id),
      name: row.name,
      count,
      total: roundToCents(eur),
    });
  }

  return Array.from(categoryMap.values());
}

async function convertRowsWithHistoricalRateFallback(rows, targetCurrency, dateField = 'date') {
  try {
    return await convertRowsToEur(rows, targetCurrency, { useHistoricalRatesByDate: true, dateField });
  } catch (err) {
    return await convertRowsToEur(rows, targetCurrency);
  }
}

/**
 * Clear the materialized-view availability cache.
 * Call after schema changes or when views are known to have been recreated.
 */
export function clearMvCache() {
  mvCache.clear();
}

export const infoRepository = {
  async getStatistics(targetCurrency = 'EUR') {
    // ── Fast path: read from materialized views ──
    if (await mvAvailable('mv_category_totals')) {
      const countResult = await query('SELECT count(*) FROM transactions WHERE is_active = true');

      // Category totals from MV (already grouped) — batch-convert all rows at once
      const catResult = await query('SELECT * FROM mv_category_totals ORDER BY count DESC');
      const convertedRows = await convertRowsToEur(
        mapRowsForAmountConversion(catResult.rows, 'total', true),
        targetCurrency
      );

      const categories = buildCategoryFromConvertedRows(convertedRows);
      const totalEur = categories.reduce((sum, category) => sum + category.total, 0);

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

    // Batch-convert all rows in one rates fetch
    const txConverted = await convertRowsToEur(
      mapRowsForAmountConversion(txResult.rows, 'amount', false),
      targetCurrency
    );
    let totalEur = txConverted.reduce((s, r) => s + r.amount_eur, 0);

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

    // Batch-convert category rows
    const catConverted = await convertRowsToEur(
      mapRowsForAmountConversion(categoryAmountResult.rows, 'amount', false),
      targetCurrency
    );

    const categories = [];
    const catMap = {};
    for (const row of catConverted) {
      const catId = row.category_id === -1 ? null : parseInt(row.category_id, 10);
      const eur = row.amount_eur;
      const key = catId ?? 'null';
      if (!catMap[key]) {
        catMap[key] = { id: catId, name: row.name, count: 0, total: 0 };
      }
      catMap[key].count++;
      catMap[key].total += eur;
    }
    for (const cat of Object.values(catMap)) {
      categories.push({ ...cat, total: roundToCents(cat.total) });
    }
    categories.sort((a, b) => b.count - a.count);

    return {
      total_transactions: parseInt(countResult.rows[0].count, 10),
      total_amount: roundToCents(totalEur),
      categories,
    };
  },

  async getCategoryBreakdown(targetCurrency = 'EUR') {
    // Keep behavior identical to stats.categories while avoiding unrelated top-level computations.
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

    const categories = [];
    const catMap = {};
    for (const row of catConverted) {
      const catId = row.category_id === -1 ? null : parseInt(row.category_id, 10);
      const eur = row.amount_eur;
      const key = catId ?? 'null';
      if (!catMap[key]) {
        catMap[key] = { id: catId, name: row.name, count: 0, total: 0 };
      }
      catMap[key].count++;
      catMap[key].total += eur;
    }
    for (const cat of Object.values(catMap)) {
      categories.push({ ...cat, total: roundToCents(cat.total) });
    }
    categories.sort((a, b) => b.count - a.count);

    return categories;
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
    if (endDate) { sql += ` AND t.date <= $${paramIdx++}`; params.push(endDate); }

    const result = await query(sql, params);

    if (result.rows.length === 0) {
      return { total_count: 0, total_amount: 0, average: 0, min: null, max: null };
    }

    // Batch-convert all rows in a single rates fetch
    const converted = await convertRowsToEur(
      mapRowsForAmountConversion(result.rows, 'amount', false),
      targetCurrency
    );
    let total = 0;
    let min = Infinity;
    let max = -Infinity;
    for (const row of converted) {
      const eur = row.amount_eur;
      total += eur;
      if (eur < min) min = eur;
      if (eur > max) max = eur;
    }

    const count = result.rows.length;
    return {
      total_count: count,
      total_amount: roundToCents(total),
      average: roundToCents(total / count),
      min: roundToCents(min),
      max: roundToCents(max),
    };
  },

  async getMonthlyFinancialSummary(excludedCategoryIds = [], targetCurrency = 'EUR', excludedRecipientIds = []) {
    const validIds = excludedCategoryIds.filter(id => Number.isInteger(id) && id > 0 && id < 2147483647);
    const validRecipientIds = (excludedRecipientIds || []).filter(id => Number.isInteger(id) && id > 0 && id < 2147483647);
    logger.debug('getMonthlyFinancialSummary called', { excludedCategoryIds, validIds, validRecipientIds });

    // ── Fast path: read from mv_monthly_summary (only when no exclusions) ──
    if (validIds.length === 0 && validRecipientIds.length === 0 && await mvAvailable('mv_monthly_summary')) {
      const mvResult = await query(`
        SELECT month_start, month, year, currency,
               SUM(transaction_count) AS transaction_count,
               SUM(total_income) AS total_income,
               SUM(total_spending) AS total_spending,
               SUM(net_amount) AS net_amount
        FROM mv_monthly_summary
        WHERE month_start >= date_trunc('month', CURRENT_DATE - interval '5 months')
        GROUP BY month_start, month, year, currency
        ORDER BY month_start
      `);

      const monthMap = {};
      // convertRowsToEur only converts 'amount', so we need a second pass for spending
      // Use the same rates by calling getRates once - instead batch both into separate rows
      // More efficient: merge income+spending into one array, convert all, then split
      const mergedRows = [];
      for (const r of mvResult.rows) {
        const dateStr = r.month_start instanceof Date ? formatDateToYmd(r.month_start) : String(r.month_start);
        const monthKey = formatYearMonthKey(r.year, r.month);
        mergedRows.push({ currency: r.currency, amount: parseFloat(r.total_income), _key: monthKey, _type: 'income', _row: r, date: dateStr });
        mergedRows.push({ currency: r.currency, amount: parseFloat(r.total_spending), _key: monthKey, _type: 'spending', _row: r, date: dateStr });
      }
      const mergedConverted = await convertRowsToEur(mergedRows, targetCurrency, { useHistoricalRatesByDate: true, dateField: 'date' });

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
        if (conv._type === 'income') {
          monthMap[key].total_income += conv.amount_eur;
        } else {
          monthMap[key].total_spending += conv.amount_eur;
        }
        monthMap[key].net_amount = monthMap[key].total_income + monthMap[key].total_spending;
        monthMap[key].transaction_count += parseInt(r.transaction_count, 10);
      }

      // Deduplicate transaction_count (it was added twice per row above)
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

    // ── Fallback: live query with exclusions ──
    const params = [];
    const categoryExcludeClause = validIds.length > 0
      ? `AND COALESCE(t.category_id, r.default_category_id) NOT IN (${validIds.map((id) => { params.push(id); return `$${params.length}`; }).join(',')})`
      : '';
    const recipientExcludeClause = validRecipientIds.length > 0
      ? `AND t.recipient_id NOT IN (${validRecipientIds.map((id) => { params.push(id); return `$${params.length}`; }).join(',')})`
      : '';

    const sql = `
      WITH months AS (
        SELECT generate_series(
          date_trunc('month', CURRENT_DATE - interval '5 months'),
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

    // Group by month and convert amounts — batch all in one rates fetch
    const liveConverted = await convertRowsToEur(
      mapRowsForAmountConversion(
        result.rows.filter(r => r.txn_id != null),
        'amount',
        false
      ),
      targetCurrency,
      { useHistoricalRatesByDate: true, dateField: 'date' }
    );

    const monthMap = {};
    // Pre-populate all months (including empty ones) from the full result set
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
      .sort((a, b) => {
        if (a.year !== b.year) return a.year - b.year;
        return a.month - b.month;
      })
      .map(m => ({
        ...m,
        total_spending: roundToCents(m.total_spending),
        total_income: roundToCents(m.total_income),
        net_amount: roundToCents(m.net_amount),
      }));

    return { months, summary: buildMonthlySummary(months) };
  },

  async getPlannedExpensesNextMonth(targetCurrency = 'EUR') {
    // Calculate next month boundaries
    const now = new Date();
    const nextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    const monthAfter = new Date(now.getFullYear(), now.getMonth() + 2, 1);
    const lastDay = new Date(monthAfter - 1);

    const sql = `
      SELECT pt.*, r.name AS recipient_name,
             CASE
               WHEN c.id IS NOT NULL THEN c.general || ':' || c.detail
               ELSE NULL
             END AS category_name
      FROM planned_transactions pt
      LEFT JOIN recipients r ON pt.recipient_id = r.id
      LEFT JOIN categories c ON pt.category_id = c.id
      WHERE pt.is_active = true
        AND (
          (pt.is_recurring = true)
          OR (pt.planned_date >= $1 AND pt.planned_date < $2)
        )
      ORDER BY pt.planned_date ASC
    `;

    const result = await query(sql, [
      formatDateToYmd(nextMonth),
      formatDateToYmd(monthAfter),
    ]);

    // Batch-convert all planned rows in one rates fetch
    const plannedConverted = await convertRowsToEur(
      mapRowsForAmountConversion(result.rows, 'amount', false),
      targetCurrency
    );

    // Group by date
    const dailyMap = {};
    for (const row of plannedConverted) {
      const dateStr = row.planned_date instanceof Date
        ? formatDateToYmd(row.planned_date)
        : String(row.planned_date);
      if (!dailyMap[dateStr]) {
        dailyMap[dateStr] = { date: dateStr, total_income: 0, total_expenses: 0, transactions: [] };
      }
      const eur = row.amount_eur;
      if (eur >= 0) dailyMap[dateStr].total_income += eur;
      else dailyMap[dateStr].total_expenses += eur;
      dailyMap[dateStr].transactions.push({
        id: row.id,
        recipient_name: row.recipient_name,
        amount: roundToCents(eur),
        category_name: row.category_name,
        is_recurring: row.is_recurring,
        recurrence_pattern: row.recurrence_pattern,
      });
    }

    const dailyData = Object.values(dailyMap).sort((a, b) => {
      const aTime = new Date(a?.date).getTime();
      const bTime = new Date(b?.date).getTime();

      if (Number.isNaN(aTime) && Number.isNaN(bTime)) return 0;
      if (Number.isNaN(aTime)) return 1;
      if (Number.isNaN(bTime)) return -1;
      return aTime - bTime;
    });

    const totalIncome = dailyData.reduce((s, d) => s + d.total_income, 0);
    const totalExpenses = dailyData.reduce((s, d) => s + d.total_expenses, 0);

    return {
      month: nextMonth.getMonth() + 1,
      year: nextMonth.getFullYear(),
      period_start: formatDateToYmd(nextMonth),
      period_end: formatDateToYmd(lastDay),
      daily_data: dailyData,
      summary: {
        total_income: roundToCents(totalIncome),
        total_expenses: roundToCents(totalExpenses),
        net_amount: roundToCents(totalIncome + totalExpenses),
        transaction_count: result.rows.length,
      },
    };
  },

  async getAverageVsCurrentSpending(targetCurrency = 'EUR') {
    // Past 6 complete months — fetch raw amounts with currency for conversion
    const sql6m = `
      SELECT t.amount, t.currency, t.date
      FROM transactions t
      WHERE t.is_active = true
        AND t.date >= date_trunc('month', CURRENT_DATE) - interval '6 months'
        AND t.date < date_trunc('month', CURRENT_DATE)
    `;
    const past6Result = await query(sql6m);

    // Batch-convert all past-6-months rows in one rates fetch
    const past6Converted = await convertRowsToEur(
      mapRowsForAmountConversion(past6Result.rows, 'amount', false),
      targetCurrency
    );

    // Convert and group by month
    const monthlySpending = {};
    const monthlyDays = {};
    for (const row of past6Converted) {
      const dateStr = row.date instanceof Date ? formatDateToYmd(row.date) : row.date;
      const eur = row.amount_eur;
      const monthKey = extractYearMonth(dateStr);
      if (!monthlySpending[monthKey]) { monthlySpending[monthKey] = 0; monthlyDays[monthKey] = new Set(); }
      if (eur < 0) monthlySpending[monthKey] += Math.abs(eur);
      monthlyDays[monthKey].add(dateStr);
    }

    const monthKeys = Object.keys(monthlySpending);
    const monthsCount = monthKeys.length || 1;
    const totalMonthlySpending = monthKeys.reduce((s, k) => s + monthlySpending[k], 0);
    const avgMonthlySpending = totalMonthlySpending / monthsCount;
    const totalDays = monthKeys.reduce((s, k) => s + monthlyDays[k].size, 0) || 1;
    const avgDailySpending = totalMonthlySpending / totalDays;

    // Current month daily breakdown
    const sqlCurrent = `
      SELECT t.amount, t.currency, t.date
      FROM transactions t
      WHERE t.is_active = true
        AND t.date >= date_trunc('month', CURRENT_DATE)
        AND t.date <= CURRENT_DATE
    `;
    const currentResult = await query(sqlCurrent);

    // Batch-convert current month rows in one rates fetch
    const currentConverted = await convertRowsToEur(
      mapRowsForAmountConversion(currentResult.rows, 'amount', false),
      targetCurrency
    );

    const dailyMap = {};
    for (const row of currentConverted) {
      const dateStr = row.date instanceof Date ? formatDateToYmd(row.date) : row.date;
      const eur = row.amount_eur;
      if (!dailyMap[dateStr]) dailyMap[dateStr] = { spending: 0, income: 0 };
      if (eur < 0) dailyMap[dateStr].spending += Math.abs(eur);
      else dailyMap[dateStr].income += eur;
    }

    const dailyData = Object.entries(dailyMap)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, d]) => ({
        date,
        spending: roundToCents(d.spending),
        income: roundToCents(d.income),
      }));

    const totalCurrentSpending = dailyData.reduce((s, d) => s + d.spending, 0);
    const daysElapsed = dailyData.length || 1;
    const now = new Date();
    const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
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
  },

  /**
   * Cashflow comparison: cumulative daily net cash flow for the current month
   * versus the average daily pattern across the last 24 complete months.
   * X-axis = day of month (1-31). Two variants: with and without planned expenses.
   */
  async getCashflowComparison(excludedCategoryIds = [], excludedRecipientIds = [], targetCurrency = 'EUR') {
    const now = new Date();
    const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    const currentDay = now.getDate();
    const HISTORY_MONTHS = 24;

    const validCatIds = excludedCategoryIds.filter(id => Number.isInteger(id) && id > 0 && id < 2147483647);
    const validRecIds = excludedRecipientIds.filter(id => Number.isInteger(id) && id > 0 && id < 2147483647);

    // Build exclusion clauses
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
        AND COALESCE(t.category_id, r.default_category_id, pr.default_category_id) NOT IN (${placeholders})
      `;
      excludeParams.push(...validCatIds);
    }

    if (validRecIds.length > 0) {
      const placeholders = validRecIds.map(() => `$${paramIdx++}`).join(', ');
      categoryExclusionWhere += `
        AND COALESCE(r.primary_recipient_id, t.recipient_id) NOT IN (${placeholders})
      `;
      excludeParams.push(...validRecIds);
    }

    // --- 1. Historical daily data: last 24 complete months ---
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
    const pastResult = await query(sqlPast, excludeParams);

    // Batch-convert all historical rows in one rates fetch
    const pastConverted = await convertRowsToEur(
      mapRowsForAmountConversion(pastResult.rows, 'amount', false),
      targetCurrency,
      { useHistoricalRatesByDate: true, dateField: 'date' }
    );

    // Group by month → day → net EUR
    const monthDayNet = {};
    for (const row of pastConverted) {
      const eur = row.amount_eur;
      const mk = row.month_key;
      if (!monthDayNet[mk]) monthDayNet[mk] = {};
      monthDayNet[mk][row.day_of_month] = (monthDayNet[mk][row.day_of_month] || 0) + eur;
    }

    // Build cumulative per month, forward-fill missing days, then average across months
    const monthKeys = Object.keys(monthDayNet);
    const monthCount = monthKeys.length || 1;
    const avgCumulativeByDay = {};
    for (const mk of monthKeys) {
      const dayNet = monthDayNet[mk];
      let cum = 0;
      let last = 0;
      for (let d = 1; d <= 31; d++) {
        cum += (dayNet[d] || 0);
        last = cum;
        avgCumulativeByDay[d] = (avgCumulativeByDay[d] || 0) + last;
      }
    }
    for (const d of Object.keys(avgCumulativeByDay)) {
      avgCumulativeByDay[d] /= monthCount;
    }

    // --- 2. Current month daily data ---
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
    const currentResult = await query(sqlCurrent, excludeParams);

    // Batch-convert current month rows
    const currentCashflowConverted = await convertRowsToEur(
      mapRowsForAmountConversion(currentResult.rows, 'amount', false),
      targetCurrency,
      { useHistoricalRatesByDate: true, dateField: 'date' }
    );

    const currentDayNet = {};
    for (const row of currentCashflowConverted) {
      const eur = row.amount_eur;
      currentDayNet[row.day_of_month] = (currentDayNet[row.day_of_month] || 0) + eur;
    }

    let currentCum = 0;
    const currentByDay = {};
    for (let d = 1; d <= currentDay; d++) {
      currentCum += (currentDayNet[d] || 0);
      currentByDay[d] = currentCum;
    }

    // --- 3. Planned transactions for current month ---
    const sqlPlannedCurrent = `
      SELECT pt.amount, pt.currency, pt.planned_date,
             EXTRACT(DAY FROM pt.planned_date)::int AS day_of_month
      FROM planned_transactions pt
      WHERE pt.is_active = true
        AND pt.planned_date >= date_trunc('month', CURRENT_DATE)
        AND pt.planned_date <= (date_trunc('month', CURRENT_DATE) + interval '1 month' - interval '1 day')
    `;
    const plannedCurrentResult = await query(sqlPlannedCurrent);

    // Batch-convert planned current month rows
    const plannedCurrentConverted = await convertRowsToEur(
      mapRowsForAmountConversion(plannedCurrentResult.rows, 'amount', false),
      targetCurrency,
      { useHistoricalRatesByDate: true, dateField: 'planned_date' }
    );

    const plannedCurrentByDay = {};
    for (const row of plannedCurrentConverted) {
      const eur = row.amount_eur;
      plannedCurrentByDay[row.day_of_month] = (plannedCurrentByDay[row.day_of_month] || 0) + eur;
    }

    // --- 4. Historical planned data: last 24 complete months ---
    const sqlPlannedHist = `
      SELECT pt.amount, pt.currency, pt.planned_date,
             EXTRACT(DAY FROM pt.planned_date)::int AS day_of_month,
             TO_CHAR(date_trunc('month', pt.planned_date), 'YYYY-MM') AS month_key
      FROM planned_transactions pt
      WHERE pt.is_active = true
        AND pt.planned_date >= date_trunc('month', CURRENT_DATE) - interval '${HISTORY_MONTHS} months'
        AND pt.planned_date < date_trunc('month', CURRENT_DATE)
    `;
    const plannedHistResult = await query(sqlPlannedHist);

    // Batch-convert historical planned rows
    const plannedHistConverted = await convertRowsToEur(
      mapRowsForAmountConversion(plannedHistResult.rows, 'amount', false),
      targetCurrency,
      { useHistoricalRatesByDate: true, dateField: 'planned_date' }
    );

    const plannedHistMonthDay = {};
    for (const row of plannedHistConverted) {
      const eur = row.amount_eur;
      const mk = row.month_key;
      if (!plannedHistMonthDay[mk]) plannedHistMonthDay[mk] = {};
      plannedHistMonthDay[mk][row.day_of_month] = (plannedHistMonthDay[mk][row.day_of_month] || 0) + eur;
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

    // --- 5. Build response: one entry per day of current month ---
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
  },

  /**
   * Get current balance per bank account and monthly historical balances.
   * Uses the balance field from the single most recent transaction (by date)
   * per bank account, matching the old Python backend behavior.
   */
  async getBankBalances(targetCurrency = 'EUR') {
    const accounts = [];
    let totalNetPosition = 0;

    // For each bank account, get the balance from the single latest transaction by date
    const latestBalanceResult = await query(`
      SELECT DISTINCT ON (bank_account)
             bank_account,
             COALESCE(currency, 'EUR') AS currency,
             balance,
             date,
             COUNT(*) OVER (PARTITION BY bank_account) AS transaction_count,
             MIN(date) OVER (PARTITION BY bank_account) AS first_transaction,
             MAX(date) OVER (PARTITION BY bank_account) AS last_transaction
      FROM transactions
      WHERE is_active = true
        AND bank_account IS NOT NULL
        AND balance IS NOT NULL
      ORDER BY bank_account, date DESC, id DESC
    `);

    // Batch-convert current balances in one rates fetch
    const currentBalancesConverted = await convertRowsWithHistoricalRateFallback(
      latestBalanceResult.rows.map(r => ({
        ...r,
        amount: parseFloat(r.balance),
        currency: r.currency || 'EUR',
      })),
      targetCurrency,
      'date'
    );

    for (const row of currentBalancesConverted) {
      const balance = roundToCents(row.amount_eur);

      accounts.push({
        bank_account: row.bank_account,
        balance,
        transaction_count: parseInt(row.transaction_count, 10),
        first_transaction: row.first_transaction,
        last_transaction: row.last_transaction,
      });
      totalNetPosition += balance;
    }

    // Historical monthly balances — use the single latest transaction per account at end of each month
    const historyResult = await query(`
      WITH months AS (
        SELECT generate_series(
          date_trunc('month', CURRENT_DATE - interval '11 months'),
          date_trunc('month', CURRENT_DATE),
          interval '1 month'
        )::date AS month_start
      ),
      account_list AS (
        SELECT DISTINCT bank_account
        FROM transactions
        WHERE is_active = true AND bank_account IS NOT NULL
      ),
      ranked AS (
        SELECT
          a.bank_account,
          m.month_start,
          COALESCE(t.currency, 'EUR') AS currency,
          t.balance,
          t.date,
          ROW_NUMBER() OVER (
            PARTITION BY a.bank_account, m.month_start
            ORDER BY t.date DESC, t.id DESC
          ) AS rn
        FROM months m
        CROSS JOIN account_list a
        LEFT JOIN transactions t ON t.bank_account = a.bank_account
          AND t.date <= (m.month_start + interval '1 month' - interval '1 day')::date
          AND t.is_active = true
          AND t.balance IS NOT NULL
      )
      SELECT bank_account, month_start, currency, balance, date
      FROM ranked
      WHERE rn = 1 AND balance IS NOT NULL
      ORDER BY bank_account, month_start
    `);

    // Batch-convert all history rows in one rates fetch
    const historyConverted = await convertRowsWithHistoricalRateFallback(
      historyResult.rows
        .filter(r => r.bank_account)
        .map(r => ({
          ...r,
          amount: parseFloat(r.balance),
          currency: r.currency || 'EUR',
        })),
      targetCurrency,
      'date'
    );

    // Group monthly history by account
    const historyMap = {};
    for (const row of historyConverted) {
      const key = row.bank_account;
      if (!historyMap[key]) historyMap[key] = [];

      const monthStr = row.month_start instanceof Date
        ? formatDateToYmd(row.month_start)
        : row.month_start;

      const monthKey = extractYearMonth(monthStr);
      historyMap[key].push({ month: monthKey, balance: roundToCents(row.amount_eur) });
    }

    // Sort each account's history
    for (const key of Object.keys(historyMap)) {
      historyMap[key].sort((a, b) => a.month.localeCompare(b.month));
    }

    // Also compute total net position history
    const totalHistory = [];
    const allMonths = [...new Set(Object.values(historyMap).flat().map(h => h.month))].sort();
    for (const month of allMonths) {
      let total = 0;
      for (const acct of Object.values(historyMap)) {
        const entry = acct.find(h => h.month === month);
        if (entry) total += entry.balance;
      }
      totalHistory.push({ month, balance: roundToCents(total) });
    }

    return {
      accounts,
      total_net_position: roundToCents(totalNetPosition),
      history: historyMap,
      total_history: totalHistory,
    };
  },

  /**
   * Net Worth (snapshot-backed) — reads investment values from pre-computed
   * portfolio_performance_snapshots (populated by portfolioPerformanceSnapshotService).
   * Bank balances are still derived live from the transactions table.
   * No network calls — all data from the database.
   */
  async getNetWorthFromSnapshots(targetCurrency = 'EUR') {
    const firstDateResult = await query(`
      SELECT LEAST(
        (SELECT MIN(snapshot_date) FROM portfolio_performance_snapshots WHERE currency = $1),
        (SELECT MIN(date)::date FROM transactions WHERE is_active = true)
      )::date AS first_data_date
    `, [targetCurrency]);

    let firstDataDate = firstDateResult.rows[0]?.first_data_date;

    if (!firstDataDate) {
      const fallbackResult = await query(`
        SELECT LEAST(
          (SELECT MIN(snapshot_date) FROM portfolio_performance_snapshots WHERE currency = $1),
          (SELECT MIN(date)::date FROM transactions)
        )::date AS first_data_date
      `, [targetCurrency]);
      firstDataDate = fallbackResult.rows[0]?.first_data_date;
    }

    const firstDataDateYmd = firstDataDate
      ? (firstDataDate instanceof Date ? formatDateToYmd(firstDataDate) : String(firstDataDate).split('T')[0])
      : null;

    if (!firstDataDateYmd) {
      logger.info('Net worth has no source records', { targetCurrency });
      return {
        current: { liquid: 0, investments: 0, netWorth: 0 },
        monthlyChange: 0,
        monthlyChangePercent: 0,
        snapshots: [],
      };
    }

    // Investment values from pre-computed snapshots — no network calls
    const snapshotResult = await query(`
      SELECT to_char(snapshot_date, 'YYYY-MM-DD') AS day, value AS investments
      FROM portfolio_performance_snapshots
      WHERE currency = $1
      ORDER BY snapshot_date ASC
    `, [targetCurrency]);

    const investmentsByDay = {};
    for (const row of snapshotResult.rows) {
      investmentsByDay[row.day] = Number(row.investments) || 0;
    }

    // Bank balance history via lateral join (account balance as of each day)
    const bankHistoryResult = await query(`
      WITH bounds AS (
        SELECT $1::date AS start_date, CURRENT_DATE AS end_date
      ),
      days AS (
        SELECT generate_series(start_date, end_date, interval '1 day')::date AS day
        FROM bounds
      ),
      account_list AS (
        SELECT DISTINCT bank_account
        FROM transactions
        WHERE is_active = true
          AND bank_account IS NOT NULL
      )
      SELECT
        to_char(d.day, 'YYYY-MM-DD') AS day,
        a.bank_account,
        COALESCE(lb.currency, 'EUR') AS currency,
        lb.balance
      FROM days d
      CROSS JOIN account_list a
      LEFT JOIN LATERAL (
        SELECT t.currency, t.balance
        FROM transactions t
        WHERE t.is_active = true
          AND t.bank_account = a.bank_account
          AND t.balance IS NOT NULL
          AND t.date <= d.day
        ORDER BY t.date DESC, t.id DESC
        LIMIT 1
      ) lb ON true
      WHERE lb.balance IS NOT NULL
      ORDER BY d.day, a.bank_account
    `, [firstDataDateYmd]);

    let bankHistoryConverted = await convertRowsWithHistoricalRateFallback(
      mapRowsForAmountConversion(bankHistoryResult.rows, 'balance'),
      targetCurrency,
      'day'
    );

    // Fallback: cumulative transaction flow when no balance column is available
    if (bankHistoryConverted.length === 0) {
      logger.debug('Net worth account balance history empty; using transaction flow fallback', {
        targetCurrency,
        firstDataDate: firstDataDateYmd,
      });

      const liquidFlowResult = await query(`
        WITH bounds AS (
          SELECT $1::date AS start_date, CURRENT_DATE AS end_date
        ),
        days AS (
          SELECT generate_series(start_date, end_date, interval '1 day')::date AS day
          FROM bounds
        ),
        currencies AS (
          SELECT DISTINCT COALESCE(t.currency, 'EUR') AS currency
          FROM transactions t
          WHERE t.is_active = true
            AND t.date >= (SELECT start_date FROM bounds)
            AND t.date <= (SELECT end_date FROM bounds)
        ),
        tx_daily AS (
          SELECT
            t.date::date AS day,
            COALESCE(t.currency, 'EUR') AS currency,
            COALESCE(SUM(t.amount), 0) AS amount
          FROM transactions t
          WHERE t.is_active = true
            AND t.date >= (SELECT start_date FROM bounds)
            AND t.date <= (SELECT end_date FROM bounds)
          GROUP BY t.date::date, COALESCE(t.currency, 'EUR')
        ),
        tx_series AS (
          SELECT
            d.day,
            c.currency,
            COALESCE(td.amount, 0) AS amount
          FROM days d
          CROSS JOIN currencies c
          LEFT JOIN tx_daily td ON td.day = d.day AND td.currency = c.currency
        ),
        tx_cumulative AS (
          SELECT
            day,
            currency,
            SUM(amount) OVER (PARTITION BY currency ORDER BY day) AS value
          FROM tx_series
        )
        SELECT
          to_char(day, 'YYYY-MM-DD') AS day,
          currency,
          value
        FROM tx_cumulative
        ORDER BY day, currency
      `, [firstDataDateYmd]);

      bankHistoryConverted = await convertRowsWithHistoricalRateFallback(
        mapRowsForAmountConversion(liquidFlowResult.rows, 'value'),
        targetCurrency,
        'day'
      );
    }

    const liquidByDay = {};
    for (const row of bankHistoryConverted) {
      if (!liquidByDay[row.day]) liquidByDay[row.day] = 0;
      liquidByDay[row.day] += row.amount_eur;
    }

    const start = new Date(`${firstDataDateYmd}T00:00:00Z`);
    const end = new Date();
    end.setUTCHours(0, 0, 0, 0);

    const snapshots = [];
    for (let day = new Date(start); day <= end; day = addDaysUtc(day)) {
      const dayKey = getDayKeyUtc(day);
      const liquid = roundToCents(liquidByDay[dayKey] || 0);
      const investments = roundToCents(investmentsByDay[dayKey] || 0);
      snapshots.push({
        date: dayKey,
        liquid,
        investments,
        netWorth: roundToCents(liquid + investments),
      });
    }

    const sanitizedSnapshots = sanitizeIsolatedDailyInvestmentSpikes(snapshots);

    const latest = sanitizedSnapshots[sanitizedSnapshots.length - 1] || { liquid: 0, investments: 0, netWorth: 0 };
    const currentMonthPrefix = latest.date ? extractYearMonth(latest.date) : null;
    const firstCurrentMonthIdx = currentMonthPrefix
      ? sanitizedSnapshots.findIndex(s => s.date.startsWith(currentMonthPrefix))
      : -1;
    const baseline = firstCurrentMonthIdx > 0
      ? sanitizedSnapshots[firstCurrentMonthIdx - 1]
      : sanitizedSnapshots[0];
    const monthlyChange = baseline ? latest.netWorth - baseline.netWorth : 0;
    const monthlyChangePercent = baseline && baseline.netWorth !== 0
      ? (monthlyChange / Math.abs(baseline.netWorth)) * 100
      : 0;

    logger.debug('Net worth computed from snapshots', {
      targetCurrency,
      firstDataDate: firstDataDateYmd,
      snapshots: sanitizedSnapshots.length,
      currentLiquid: latest.liquid,
      currentInvestments: latest.investments,
      currentNetWorth: latest.netWorth,
    });

    return {
      current: {
        liquid: latest.liquid,
        investments: latest.investments,
        netWorth: latest.netWorth,
      },
      monthlyChange: roundToCents(monthlyChange),
      monthlyChangePercent: roundToCents(monthlyChangePercent),
      snapshots: sanitizedSnapshots,
    };
  },


  /**
   * Recipient / Merchant Insights
   *
   * Returns:
   * - top merchants by total spend (top 10)
   * - spending frequency & average per recipient
   * - month-over-month comparison alerts ("You spent X% more at …")
   */
  async getRecipientInsights(targetCurrency = 'EUR') {
    // Push aggregation to SQL — group by recipient and currency so we need far fewer
    // EUR conversions (one per currency per recipient, not one per transaction).
    const topRawResult = await query(`
      SELECT
        COALESCE(pr.name, r.name)   AS recipient_name,
        COALESCE(pr.id, r.id)       AS recipient_id,
        t.currency,
        SUM(ABS(t.amount))          AS total_abs_amount,
        COUNT(*)                    AS tx_count,
        MIN(t.date)                 AS first_seen,
        MAX(t.date)                 AS last_seen
      FROM transactions t
      JOIN recipients r ON t.recipient_id = r.id
      LEFT JOIN recipients pr ON r.primary_recipient_id = pr.id
      WHERE t.amount < 0
        AND t.is_active = true
      GROUP BY COALESCE(pr.id, r.id), COALESCE(pr.name, r.name), t.currency
    `);

    // Batch-convert all rows (one per recipient+currency) in a single rates fetch
    const topConverted = await convertRowsToEur(
      mapRowsForAmountConversion(topRawResult.rows, 'total_abs_amount', false),
      targetCurrency
    );

    // Aggregate by recipient across currencies
    const recipientAgg = {};
    for (const row of topConverted) {
      const rid = row.recipient_id;
      const eur = row.amount_eur;
      const count = parseInt(row.tx_count, 10);

      if (!recipientAgg[rid]) {
        recipientAgg[rid] = {
          recipientId: rid,
          name: row.recipient_name,
          totalSpend: 0,
          transactionCount: 0,
          firstSeen: row.first_seen,
          lastSeen: row.last_seen,
        };
      }
      recipientAgg[rid].totalSpend += eur;
      recipientAgg[rid].transactionCount += count;
      // Expand date ranges across currencies
      if (row.first_seen < recipientAgg[rid].firstSeen) recipientAgg[rid].firstSeen = row.first_seen;
      if (row.last_seen > recipientAgg[rid].lastSeen) recipientAgg[rid].lastSeen = row.last_seen;
    }

    // Keep full recipient detail set for searchable/scrollable insights table.
    // The frontend still slices top N for chart/KPIs.
    const topMerchants = Object.values(recipientAgg)
      .sort((a, b) => b.totalSpend - a.totalSpend)
      .map(r => ({
        ...r,
        totalSpend: roundToCents(r.totalSpend),
        avgAmount: roundToCents(r.totalSpend / r.transactionCount),
      }));

    // Month-over-month comparison (current vs previous month) — also group by recipient+currency
    const momRawResult = await query(`
      SELECT
        COALESCE(pr.id, r.id)       AS recipient_id,
        COALESCE(pr.name, r.name)   AS recipient_name,
        TO_CHAR(t.date, 'YYYY-MM')  AS period,
        t.currency,
        SUM(ABS(t.amount))          AS abs_amount
      FROM transactions t
      JOIN recipients r ON t.recipient_id = r.id
      LEFT JOIN recipients pr ON r.primary_recipient_id = pr.id
      WHERE t.amount < 0
        AND t.is_active = true
        AND t.date >= (DATE_TRUNC('month', CURRENT_DATE) - INTERVAL '1 month')
      GROUP BY COALESCE(pr.id, r.id), COALESCE(pr.name, r.name), TO_CHAR(t.date, 'YYYY-MM'), t.currency
    `);

    // Batch-convert MoM rows in one rates fetch
    const momConverted = await convertRowsToEur(
      mapRowsForAmountConversion(momRawResult.rows, 'abs_amount', false),
      targetCurrency
    );

    const currentPeriod = formatDateToYm(new Date());
    const prevDate = new Date();
    prevDate.setMonth(prevDate.getMonth() - 1);
    const prevPeriod = formatDateToYm(prevDate);

    const momAgg = {}; // { recipientId: { name, current: eurTotal, previous: eurTotal } }
    for (const row of momConverted) {
      const rid = row.recipient_id;
      const eur = row.amount_eur;

      if (!momAgg[rid]) momAgg[rid] = { name: row.recipient_name, current: 0, previous: 0 };
      if (row.period === currentPeriod) momAgg[rid].current += eur;
      else if (row.period === prevPeriod) momAgg[rid].previous += eur;
    }

    const monthOverMonth = Object.entries(momAgg)
      .filter(([, v]) => v.previous > 0 && v.current > 0)
      .map(([rid, v]) => ({
        recipientId: parseInt(rid, 10),
        name: v.name,
        currentSpend: roundToCents(v.current),
        previousSpend: roundToCents(v.previous),
        changePercent: Math.round(((v.current - v.previous) / v.previous * 100) * 10) / 10,
      }))
      .sort((a, b) => b.currentSpend - a.currentSpend)
      .slice(0, 10);

    return { topMerchants, monthOverMonth };
  },
};

export default infoRepository;
