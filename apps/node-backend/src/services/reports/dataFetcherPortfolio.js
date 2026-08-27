/**
 * Portfolio data fetcher for PDF report generation.
 *
 * Fetches all data sources in parallel using Promise.allSettled so a single
 * failing source does not abort the entire report. Each source returns null
 * on failure; section renderers handle null gracefully.
 */

import { query } from '../../database/connection.js';
import { getSnapshots, getBreakdownSummary } from '../portfolioPerformanceSnapshotService.js';
import { convertWithRates, loadCurrentRates } from '../currency/currencyConversionService.js';
import { todayAppDateString, firstOfMonthYmd } from '../../lib/timezone.js';
import { logger } from '../../config/logger.js';

/**
 * @typedef {{ kind: 'ytd' }
 *   | { kind: 'rolling'; months: number }
 *   | { kind: 'custom'; from: string; to: string }
 *   | { kind: 'year'; year: number }
 * } Period
 */

/**
 * A row of `getSnapshots`' resolved array (portfolioPerformanceSnapshotService.js).
 * @typedef {Awaited<ReturnType<typeof getSnapshots>>[number]} SnapshotRow
 */

/**
 * A row of `getBreakdownSummary`'s resolved array
 * (services/portfolio/portfolioSummaryService.js, re-exported here).
 *
 * Compatibility aliases are normalized once at the fetch boundary so section
 * renderers consume one camelCase shape.
 * @typedef {Awaited<ReturnType<typeof getBreakdownSummary>>[number]} BreakdownRow
 */

/** @typedef {{ year: number; month: number; amount: number }} DividendMonthRow */

/**
 * @typedef {{
 *   investmentId: number, name: string, symbol: string|null, assetClass: string,
 *   total: number,
 * }} DividendInvestmentRow
 */

/** @typedef {{ byMonth: DividendMonthRow[]; byInvestment: DividendInvestmentRow[] }} DividendData */

/**
 * Full result of {@link fetchPortfolioData} — the data payload portfolio
 * report section renderers consume.
 * @typedef {{
 *   snapshots: SnapshotRow[] | null;
 *   breakdown: BreakdownRow[] | null;
 *   dividends: DividendData | null;
 *   period: Period;
 *   currency: string;
 * }} PortfolioReportData
 */

/**
 * Unwrap a settled Promise result; log and return null on rejection.
 *
 * @template T
 * @param {PromiseSettledResult<T>} result
 * @param {string} label
 * @returns {T | null}
 */
function unwrap(result, label) {
  if (result.status === 'fulfilled') return result.value;
  logger.warn(`[dataFetcherPortfolio] ${label} failed — section will be skipped`, { reason: result.reason?.message });
  return null;
}

/**
 * Normalize the historical snake_case breakdown aliases at one boundary.
 *
 * @param {Partial<BreakdownRow> & {
 *   asset_class?: string,
 *   current_value?: number,
 *   total_invested?: number,
 *   gain_loss?: number,
 *   gain_loss_pct?: number,
 * }} row
 * @returns {BreakdownRow}
 */
export function normalizeBreakdownRow(row) {
  return /** @type {BreakdownRow} */ ({
    ...row,
    assetClass: row.assetClass ?? row.asset_class ?? 'other',
    currentValue: row.currentValue ?? row.current_value ?? 0,
    totalInvested: row.totalInvested ?? row.total_invested ?? 0,
    gainLoss: row.gainLoss ?? row.gain_loss ?? 0,
    gainLossPercent: row.gainLossPercent ?? row.gain_loss_pct ?? 0,
  });
}

/**
 * Convert a Period to a concrete { startDate, endDate } range (ISO date strings).
 *
 * @param {Period} period
 * @returns {{ startDate: string; endDate: string }}
 */
export function periodToDateRange(period) {
  // All boundaries derive from the APP_TIMEZONE calendar day via pure string
  // math — local-Date + toISOString() shifted rolling starts to the last day
  // of the previous month in UTC+ zones.
  const today = todayAppDateString();
  const year = Number(today.slice(0, 4));

  switch (period.kind) {
    case 'ytd':
      return { startDate: `${year}-01-01`, endDate: today };
    case 'rolling':
      return { startDate: firstOfMonthYmd(today, -(period.months - 1)), endDate: today };
    case 'custom':
      return { startDate: period.from, endDate: period.to };
    case 'year':
      return { startDate: `${period.year}-01-01`, endDate: `${period.year}-12-31` };
    default:
      return { startDate: `${year - 1}-01-01`, endDate: today };
  }
}

/**
 * Fetch dividend transactions grouped by month and by investment, converted
 * to the target currency.
 *
 * @param {string} targetCurrency
 * @param {string} startDate
 * @param {string} endDate
 * @returns {Promise<DividendData>}
 */
async function fetchDividends(targetCurrency, startDate, endDate) {
  const result = await query(`
    SELECT
      pt.investment_id,
      i.name AS investment_name,
      i.symbol,
      i.asset_class,
      EXTRACT(YEAR  FROM pt.date::date)::int AS year,
      EXTRACT(MONTH FROM pt.date::date)::int AS month,
      COALESCE(pt.amount, 0) AS amount,
      COALESCE(pt.currency, i.currency, 'EUR') AS currency
    FROM portfolio_transactions pt
    JOIN investments i ON i.id = pt.investment_id
    WHERE pt.type = 'dividend'
      AND pt.date::date BETWEEN $1 AND $2
    ORDER BY year, month
    LIMIT 100000
  `, [startDate, endDate]);

  // Convert each row and aggregate
  const byMonthMap = new Map();
  const byInvestmentMap = new Map();
  const rates = await loadCurrentRates();

  for (const row of result.rows) {
    const converted = row.currency !== targetCurrency
      ? convertWithRates(Number(row.amount), row.currency, targetCurrency, rates)
      : Number(row.amount);

    const monthKey = `${row.year}-${String(row.month).padStart(2, '0')}`;
    byMonthMap.set(monthKey, (byMonthMap.get(monthKey) ?? 0) + converted);

    const invKey = row.investment_id;
    if (!byInvestmentMap.has(invKey)) {
      byInvestmentMap.set(invKey, {
        investmentId: invKey,
        name: row.investment_name,
        symbol: row.symbol,
        assetClass: row.asset_class,
        total: 0,
      });
    }
    byInvestmentMap.get(invKey).total += converted;
  }

  const byMonth = [...byMonthMap.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, amount]) => {
      const [yr, mo] = key.split('-').map(Number);
      return { year: yr, month: mo, amount };
    });

  const byInvestment = [...byInvestmentMap.values()]
    .sort((a, b) => b.total - a.total);

  return { byMonth, byInvestment };
}

/**
 * Fetch all data required for a portfolio PDF report in parallel.
 *
 * @param {string} currency  Target currency (e.g. "EUR")
 * @param {Period} period
 * @returns {Promise<PortfolioReportData>}
 */
export async function fetchPortfolioData(currency, period) {
  const { startDate, endDate } = periodToDateRange(period);

  const [snapshotsResult, breakdownResult, dividendsResult] = await Promise.allSettled([
    getSnapshots(startDate, endDate, currency),
    getBreakdownSummary(currency),
    fetchDividends(currency, startDate, endDate),
  ]);

  const breakdown = unwrap(breakdownResult, 'getBreakdownSummary');

  return {
    snapshots: unwrap(snapshotsResult, 'getSnapshots'),
    breakdown: breakdown?.map(normalizeBreakdownRow) ?? breakdown,
    dividends: unwrap(dividendsResult, 'fetchDividends'),
    period,
    currency,
  };
}
