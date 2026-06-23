/**
 * Tax data fetcher for PDF report generation.
 *
 * Fetches portfolio transactions for a tax year, aggregates by type/asset-class/
 * investment, and threads through optional Belgian tax profile data from the client.
 */

import { query } from '../../database/connection.js';
import { convertWithRates, loadCurrentRates } from '../currency/currencyConversionService.js';
import { buildHistoricalRateIndex, findRateOnOrBeforeInIndex } from '../currency/rateFetcher.js';
import { getTaxTable } from './belgianTaxTables.js';
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
 * Unwrap a settled Promise result; log and return null on rejection.
 *
 * @template T
 * @param {PromiseSettledResult<T>} result
 * @param {string} label
 * @returns {T | null}
 */
function unwrap(result, label) {
  if (result.status === 'fulfilled') return result.value;
  logger.warn(`[dataFetcherTax] ${label} failed — section will be skipped`, { reason: result.reason?.message });
  return null;
}

/**
 * Normalise a Period into a tax context (year-scoped).
 *
 * @param {Period} period
 * @returns {{ taxYear: number; startDate: string; endDate: string; periodNote: string | null }}
 */
export function periodToTaxContext(period) {
  // APP_TIMEZONE calendar day + pure string math (see periodToDateRange in
  // dataFetcherPortfolio.js — same day-shift class).
  const today = todayAppDateString();
  const currentYear = Number(today.slice(0, 4));

  switch (period.kind) {
    case 'ytd':
      return { taxYear: currentYear, startDate: `${currentYear}-01-01`, endDate: today, periodNote: null };

    case 'year':
      return { taxYear: period.year, startDate: `${period.year}-01-01`, endDate: `${period.year}-12-31`, periodNote: null };

    case 'rolling': {
      // Use current year; add note that period may span two calendar years
      const startDate = firstOfMonthYmd(today, -(period.months - 1));
      const startYear = Number(startDate.slice(0, 4));
      const note = startYear !== currentYear
        ? `Rolling ${period.months}-month window spans ${startYear}–${currentYear}; brackets use ${currentYear} rates.`
        : null;
      return { taxYear: currentYear, startDate, endDate: today, periodNote: note };
    }

    case 'custom': {
      const fromYear = Number(String(period.from).slice(0, 4));
      const toYear   = Number(String(period.to).slice(0, 4));
      const taxYear  = fromYear;
      const note = fromYear !== toYear
        ? `Custom date range spans ${fromYear}–${toYear}; brackets use ${fromYear} rates.`
        : null;
      return { taxYear, startDate: period.from, endDate: period.to, periodNote: note };
    }

    default:
      return { taxYear: currentYear, startDate: `${currentYear}-01-01`, endDate: `${currentYear}-12-31`, periodNote: null };
  }
}

/**
 * Fetch and aggregate tax-related portfolio transactions for the given date range.
 *
 * @param {string} targetCurrency
 * @param {string} startDate
 * @param {string} endDate
 * @returns {Promise<object>}
 */
async function fetchTaxTransactions(targetCurrency, startDate, endDate) {
  const result = await query(`
    SELECT
      pt.id,
      pt.investment_id,
      i.name AS investment_name,
      i.symbol,
      i.asset_class,
      pt.type,
      COALESCE(pt.amount, 0)  AS amount,
      COALESCE(pt.taxes,  0)  AS taxes,
      COALESCE(pt.fees,   0)  AS fees,
      COALESCE(pt.currency, i.currency, 'EUR') AS currency,
      to_char(pt.date::date, 'YYYY-MM-DD') AS rate_date,
      EXTRACT(YEAR  FROM pt.date::date)::int AS year,
      EXTRACT(MONTH FROM pt.date::date)::int AS month
    FROM portfolio_transactions pt
    JOIN investments i ON i.id = pt.investment_id
    WHERE pt.date::date BETWEEN $1 AND $2
      AND (pt.taxes > 0 OR pt.fees > 0 OR pt.type IN ('dividend', 'tax', 'fee'))
    ORDER BY pt.date
  `, [startDate, endDate]);

  // Aggregation accumulators
  let tobTotal          = 0;
  let dividendWHTTotal  = 0;
  let sellTaxTotal      = 0;
  let otherTaxTotal     = 0;
  let feesTotal         = 0;
  let dividendsReceived = 0;

  const byMonthMap      = new Map(); // key: 'YYYY-MM'
  const byAssetClass    = new Map();
  const byInvestment    = new Map();

  // Currencies for which no rate (historical or current) could be resolved, so a
  // row was summed into the target total at an unconverted 1:1 rate. Surfaced so
  // the PDF can annotate the figure as approximate instead of silently reporting
  // e.g. 1000 KRW as 1000 EUR. (ADR-085.)
  const missingRateCurrencies = new Set();

  // Belgian tax values foreign-currency income and transactions at the exchange rate
  // on the date the income was collected / the transaction took place — not today's
  // rate. The TOB (stock-exchange tax) guidance is explicit ("the ECB rate of the day
  // the transaction took place") and foreign movable income (dividends/interest) is
  // taxable at its date of collection. So each row converts at its transaction-date
  // rate, falling back to the current rate only when no historical rate is stored on or
  // before that date (e.g. a brand-new transaction before the FX backfill runs). See
  // ADR-085.
  const currentRates = await loadCurrentRates();
  const toCur = String(targetCurrency || 'EUR').toUpperCase().trim();

  const relevantCurrencies = [...new Set([
    ...result.rows.map((r) => String(r.currency || 'EUR').toUpperCase().trim()),
    toCur,
  ])].filter((c) => c && c !== 'EUR');

  let historicalIndex = new Map();
  if (relevantCurrencies.length > 0) {
    const ratesResult = await query(
      `SELECT currency_code, rate_date, rate_to_eur
       FROM exchange_rates
       WHERE currency_code = ANY($1::text[])
       ORDER BY currency_code ASC, rate_date ASC`,
      [relevantCurrencies]
    );
    historicalIndex = buildHistoricalRateIndex(ratesResult.rows || []);
  }

  // Rate-to-EUR for a currency on a given date: the stored historical rate on or
  // before the date when available, else the current rate. EUR is always 1.
  const rateToEurForDate = (code, dateStr) => {
    const c = String(code || 'EUR').toUpperCase().trim();
    if (c === 'EUR') return 1;
    const historical = findRateOnOrBeforeInIndex(historicalIndex, c, dateStr);
    if (historical !== undefined) return historical;
    return currentRates[c];
  };

  for (const row of result.rows) {
    // Normalize the source currency ONCE so the skip-guard and the rowRates keys
    // can't disagree for mixed-case/whitespace currency strings.
    const cur = String(row.currency || 'EUR').toUpperCase().trim();
    const rowDate = row.rate_date;
    // Per-row rate table built from the transaction-date rates, so convertWithRates
    // applies the same conversion math and unsupported-currency handling as the live
    // path — only the rate source (historical vs current) differs.
    const fromRate = rateToEurForDate(cur, rowDate);
    const rowRates = {
      EUR: 1,
      [cur]: fromRate,
      [toCur]: rateToEurForDate(toCur, rowDate),
    };
    // No rate resolved for a non-target foreign currency → convertWithRates will
    // sum it 1:1. Record it so the report can flag the total as approximate.
    if (cur !== toCur && cur !== 'EUR' && (fromRate === undefined || fromRate === null)) {
      missingRateCurrencies.add(cur);
    }
    const convert = (v) =>
      cur !== toCur ? convertWithRates(Number(v), cur, toCur, rowRates) : Number(v);

    const taxes    = convert(row.taxes);
    const fees     = convert(row.fees);
    const amount   = convert(row.amount);

    // Classify taxes by transaction type
    let tobAmt = 0, whtAmt = 0, sellAmt = 0, otherAmt = 0;
    switch (row.type) {
      case 'buy':
        tobAmt = taxes;
        break;
      case 'sell':
        sellAmt = taxes;
        break;
      case 'dividend':
        whtAmt = taxes;
        dividendsReceived += amount;
        break;
      case 'tax':
        otherAmt = amount; // 'tax' type transactions record the tax amount itself
        break;
      default:
        otherAmt = taxes;
    }

    tobTotal         += tobAmt;
    dividendWHTTotal += whtAmt;
    sellTaxTotal     += sellAmt;
    otherTaxTotal    += otherAmt;
    feesTotal        += fees;

    const monthKey = `${row.year}-${String(row.month).padStart(2, '0')}`;
    if (!byMonthMap.has(monthKey)) {
      byMonthMap.set(monthKey, { year: row.year, month: row.month, tob: 0, wht: 0, sell: 0, other: 0, fees: 0 });
    }
    const mo = byMonthMap.get(monthKey);
    mo.tob   += tobAmt;
    mo.wht   += whtAmt;
    mo.sell  += sellAmt;
    mo.other += otherAmt;
    mo.fees  += fees;

    const ac = row.asset_class ?? 'other';
    if (!byAssetClass.has(ac)) byAssetClass.set(ac, { assetClass: ac, taxes: 0, fees: 0 });
    const acBucket = byAssetClass.get(ac);
    acBucket.taxes += tobAmt + whtAmt + sellAmt + otherAmt;
    acBucket.fees  += fees;

    const invId = row.investment_id;
    if (!byInvestment.has(invId)) {
      byInvestment.set(invId, {
        investmentId: invId,
        name: row.investment_name,
        symbol: row.symbol,
        assetClass: ac,
        tob: 0, wht: 0, sell: 0, other: 0, fees: 0, total: 0,
      });
    }
    const inv = byInvestment.get(invId);
    inv.tob   += tobAmt;
    inv.wht   += whtAmt;
    inv.sell  += sellAmt;
    inv.other += otherAmt;
    inv.fees  += fees;
    // eslint-disable-next-line vision-local-money/no-raw-money-arithmetic
    inv.total += tobAmt + whtAmt + sellAmt + otherAmt + fees;
  }

  return {
    tobTotal,
    dividendWHTTotal,
    sellTaxTotal,
    otherTaxTotal,
    feesTotal,
    dividendsReceived,
    byMonth: [...byMonthMap.values()].sort((a, b) => a.year !== b.year ? a.year - b.year : a.month - b.month),
    byAssetClass: [...byAssetClass.values()].sort((a, b) => (b.taxes + b.fees) - (a.taxes + a.fees)),
    byInvestment: [...byInvestment.values()].sort((a, b) => b.total - a.total),
    // Foreign currencies that were summed at an unconverted 1:1 rate (no FX rate
    // available). Empty when every row converted cleanly.
    unconvertedCurrencies: [...missingRateCurrencies].sort(),
  };
}

/**
 * Fetch all data required for a tax PDF report.
 *
 * @param {string} currency  Target currency (e.g. "EUR")
 * @param {Period} period
 * @param {{ taxProfile?: object; precomputedPIT?: object }} [extra]
 * @returns {Promise<object>}
 */
export async function fetchTaxData(currency, period, { taxProfile, precomputedPIT } = {}) {
  const { taxYear, startDate, endDate, periodNote } = periodToTaxContext(period);
  const taxTables = getTaxTable(taxYear);

  const [txnsResult] = await Promise.allSettled([
    fetchTaxTransactions(currency, startDate, endDate),
  ]);

  const txns = unwrap(txnsResult, 'fetchTaxTransactions');

  return {
    taxYear,
    startDate,
    endDate,
    currency,
    period,
    periodNote,
    taxTables,
    taxProfile: taxProfile ?? null,
    precomputedPIT: precomputedPIT ?? null,
    tobTotal:          txns?.tobTotal          ?? 0,
    dividendWHTTotal:  txns?.dividendWHTTotal  ?? 0,
    sellTaxTotal:      txns?.sellTaxTotal      ?? 0,
    otherTaxTotal:     txns?.otherTaxTotal     ?? 0,
    feesTotal:         txns?.feesTotal         ?? 0,
    dividendsReceived: txns?.dividendsReceived ?? 0,
    byMonth:           txns?.byMonth           ?? [],
    byAssetClass:      txns?.byAssetClass      ?? [],
    byInvestment:      txns?.byInvestment      ?? [],
    unconvertedCurrencies: txns?.unconvertedCurrencies ?? [],
  };
}
