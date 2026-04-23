/**
 * Currency Conversion Service
 *
 * Converts currencies to EUR using ECB exchange rates.
 * Mirrors: apps/backend/services/currency_conversion_service.py
 *
 * Design:
 * - Fetches latest rates from ECB (primary) on startup and every 12 hours
 * - Supplements ECB rates with open.er-api.com for currencies ECB doesn't cover
 *   (AED, SAR, KWD, QAR, BHD, OMR, PKR, EGP, NGN, and ~130 more)
 * - ECB always takes priority over the supplementary source on overlapping currencies
 * - If both APIs are unavailable the service falls back to DB then hardcoded constants
 */

import { query } from '../../database/connection.js';
import { logger } from '../../config/logger.js';
import { toDecimal, toNumber } from '../../lib/money.js';
import {
  CACHE_LIFETIME_MS,
  normalizeDateInput,
  fetchFromEcb,
  fetchFromErApi,
  loadFromDatabase,
  saveToDatabase,
  saveHistoricalRate,
  buildHistoricalRateIndex,
  findNearestRateInIndex,
  getRateToEurForDate,
  clearHistoricalCache,
} from './rateFetcher.js';

// In-memory cache: { rates: {...}, timestamp: number } | null
let memoryCache = null;

// Fallback rates — updated in-memory whenever a successful fetch occurs.
// Covers ECB currencies plus common non-ECB currencies (Gulf, South Asia, Africa, etc.)
export const FALLBACK_RATES = {
  EUR: 1.0,
  // ECB currencies
  USD: 1 / 1.09,
  GBP: 1 / 0.85,
  CHF: 1 / 0.95,
  JPY: 1 / 163.0,
  SEK: 1 / 11.20,
  NOK: 1 / 11.50,
  DKK: 1 / 7.46,
  PLN: 1 / 4.30,
  CZK: 1 / 25.30,
  HUF: 1 / 395.0,
  RON: 1 / 4.97,
  TRY: 1 / 35.0,
  AUD: 1 / 1.66,
  CAD: 1 / 1.50,
  CNY: 1 / 7.90,
  INR: 1 / 91.0,
  BRL: 1 / 5.40,
  IDR: 1 / 17600.0,
  KRW: 1 / 1450.0,
  MXN: 1 / 18.50,
  MYR: 1 / 4.80,
  NZD: 1 / 1.78,
  PHP: 1 / 61.0,
  SGD: 1 / 1.46,
  THB: 1 / 37.5,
  ZAR: 1 / 19.5,
  HKD: 1 / 8.50,
  ISK: 1 / 150.0,
  ILS: 1 / 3.95,
  // Supplementary currencies (open.er-api.com)
  AED: 1 / 4.01,
  SAR: 1 / 4.09,
  KWD: 1 / 0.335,
  QAR: 1 / 3.97,
  BHD: 1 / 0.41,
  OMR: 1 / 0.42,
  PKR: 1 / 305.0,
  EGP: 1 / 53.0,
  MAD: 1 / 10.9,
  NGN: 1 / 1650.0,
  KES: 1 / 141.0,
};

// ─── Cache helpers ────────────────────────────────────────────────────────────

/**
 * Get current rates using the cache hierarchy:
 *   1. In-memory cache (24-hour TTL)
 *   2. Database (latest rows)
 *   3. Hardcoded fallback
 */
async function getRates() {
  if (memoryCache && Date.now() - memoryCache.timestamp < CACHE_LIFETIME_MS) {
    return memoryCache.rates;
  }

  const dbRates = await loadFromDatabase();
  if (dbRates) {
    memoryCache = { rates: dbRates, timestamp: Date.now() };
    return dbRates;
  }

  logger.warn('Using fallback exchange rates — ECB API and database unavailable');
  return { ...FALLBACK_RATES };
}

/**
 * Clear in-memory cache to force fresh data on next request.
 */
export function clearMemoryCache() {
  memoryCache = null;
  clearHistoricalCache();
  logger.debug('Cleared exchange rate memory cache');
}

/**
 * Fetch fresh rates from both sources, update DB, memory cache, and fallback map.
 * ECB is fetched first and takes priority; open.er-api fills in currencies ECB doesn't publish.
 * Called on startup and every 12 hours by the scheduler in main.js.
 */
export async function warmCache() {
  try {
    const [ecbRates, erarRates] = await Promise.all([fetchFromEcb(), fetchFromErApi()]);

    if (!ecbRates && !erarRates) {
      const rates = await getRates();
      logger.warn(`Exchange rate cache warmed from ${rates === FALLBACK_RATES ? 'fallback' : 'database'} (all APIs unavailable)`);
      return;
    }

    // Supplementary first, then ECB overwrites any overlaps
    const mergedRates = {
      ...(erarRates ?? {}),
      ...(ecbRates  ?? {}),
    };

    const ecbCount  = ecbRates  ? Object.keys(ecbRates).length  - 1 : 0;
    const erarCount = erarRates ? Object.keys(erarRates).length - 1 : 0;
    const totalCount = Object.keys(mergedRates).length - 1;
    logger.info(`Merged exchange rates: ${ecbCount} from ECB + ${erarCount - ecbCount} supplementary = ${totalCount} total`);

    Object.assign(FALLBACK_RATES, mergedRates);
    await saveToDatabase(mergedRates);
    memoryCache = { rates: mergedRates, timestamp: Date.now() };
  } catch (err) {
    logger.warn('Failed to warm exchange rate cache', { error: err.message });
  }
}

// ─── Conversion helpers ───────────────────────────────────────────────────────

/**
 * Convert an amount from `fromCurrency` to EUR.
 */
export async function convertToEur(amount, fromCurrency) {
  return convertToCurrency(amount, fromCurrency, 'EUR');
}

/**
 * Convert an array of rows to a target currency (default EUR).
 * Rows must have `amount` and `currency` fields.
 * Returns rows with an `amount_eur` field containing the converted amount.
 *
 * @param {Array<{amount:number|string,currency:string}>} rows
 * @param {string} [targetCurrency='EUR']
 * @param {{ useHistoricalRatesByDate?: boolean, dateField?: string|null }} [options]
 */
export async function convertRowsToEur(rows, targetCurrency = 'EUR', options = {}) {
  if (!rows || rows.length === 0) return [];

  const { useHistoricalRatesByDate = false, dateField = null } = options || {};
  const toCur = (targetCurrency || 'EUR').toUpperCase().trim();
  const rates = await getRates();

  const historicalRateCache = new Map();

  function resolveDateFromRow(row) {
    if (dateField && row[dateField]) return normalizeDateInput(row[dateField]);
    return normalizeDateInput(row.date || row.day || row.transaction_date || row.planned_date || row.rate_date);
  }

  async function getRate(currencyCode, rowDate) {
    if (!useHistoricalRatesByDate || !rowDate) return rates[currencyCode];
    const key = `${currencyCode}:${rowDate}`;
    if (historicalRateCache.has(key)) return historicalRateCache.get(key);
    const value = await getRateToEurForDate(currencyCode, rowDate, { saveFetchedHistoricalRate: true });
    historicalRateCache.set(key, value);
    return value;
  }

  let historicalIndex = null;
  if (useHistoricalRatesByDate) {
    const relevantCurrencies = [...new Set([
      ...rows.map(row => (row.currency || 'EUR').toUpperCase().trim()),
      toCur,
    ])].filter(Boolean);

    if (relevantCurrencies.length > 0) {
      const historicalRowsResult = await query(
        `SELECT currency_code, rate_date, rate_to_eur
         FROM exchange_rates
         WHERE currency_code = ANY($1::text[])
         ORDER BY currency_code ASC, rate_date ASC`,
        [relevantCurrencies]
      );
      historicalIndex = buildHistoricalRateIndex(historicalRowsResult.rows || []);
    }
  }

  const converted = [];
  for (const row of rows) {
    const currency = (row.currency || 'EUR').toUpperCase().trim();
    const amount = toNumber(toDecimal(row.amount));
    const rowDate = resolveDateFromRow(row);

    if (currency === toCur) {
      converted.push({ ...row, amount_eur: amount });
      continue;
    }

    const historicalFrom = (historicalIndex && rowDate)
      ? findNearestRateInIndex(historicalIndex, currency, rowDate)
      : undefined;
    const historicalTo = (historicalIndex && rowDate)
      ? findNearestRateInIndex(historicalIndex, toCur, rowDate)
      : undefined;

    const rateFrom = historicalFrom
      ?? (historicalIndex && !historicalIndex.has(currency) ? rates[currency] : undefined)
      ?? await getRate(currency, rowDate)
      ?? rates[currency];

    const rateTo = historicalTo
      ?? (historicalIndex && !historicalIndex.has(toCur) ? rates[toCur] : undefined)
      ?? await getRate(toCur, rowDate)
      ?? rates[toCur];

    if (!rateFrom) {
      logger.warn(`Unsupported source currency ${currency}, using 1:1 conversion`);
      converted.push({ ...row, amount_eur: amount });
      continue;
    }
    if (!rateTo) {
      logger.warn(`Unsupported target currency ${toCur}, falling back to EUR`);
      converted.push({ ...row, amount_eur: amount * rateFrom });
      continue;
    }

    converted.push({ ...row, amount_eur: (amount * rateFrom) / rateTo });
  }

  return converted;
}

/**
 * Generic converter from any currency to any currency.
 */
export async function convertToCurrency(amount, fromCurrency, toCurrency) {
  if (!fromCurrency || fromCurrency.toUpperCase().trim() === (toCurrency || 'EUR').toUpperCase().trim()) {
    return amount;
  }

  const from = fromCurrency.toUpperCase().trim();
  const to = (toCurrency || 'EUR').toUpperCase().trim();
  const rates = await getRates();

  const rateFrom = rates[from];
  const rateTo = rates[to];

  if (!rateFrom) {
    logger.warn(`Unsupported currency ${from}, using 1:1 conversion`);
    return amount;
  }
  if (!rateTo) {
    logger.warn(`Unsupported target currency ${to}, falling back to EUR conversion`);
    return amount * rateFrom;
  }

  return (amount * rateFrom) / rateTo;
}

// ─── Historical backfill ──────────────────────────────────────────────────────

export async function backfillPortfolioHistoricalRates() {
  const missingResult = await query(
    `SELECT pt.currency::text AS currency_code, pt.date::date AS rate_date
     FROM portfolio_transactions pt
     LEFT JOIN exchange_rates er
       ON er.currency_code = pt.currency::text
      AND er.rate_date = pt.date::date
     WHERE pt.currency IS NOT NULL
       AND UPPER(pt.currency::text) <> 'EUR'
       AND er.id IS NULL
     GROUP BY pt.currency::text, pt.date::date
     ORDER BY pt.date::date ASC`
  );

  if (missingResult.rows.length === 0) return { inserted: 0, missing: 0 };

  let inserted = 0;
  let unresolved = 0;

  for (const row of missingResult.rows) {
    const currencyCode = String(row.currency_code || '').toUpperCase().trim();
    const rateDate = normalizeDateInput(row.rate_date);
    if (!currencyCode || !rateDate) continue;

    const rate = await getRateToEurForDate(currencyCode, rateDate, { saveFetchedHistoricalRate: true });
    if (rate === undefined) {
      unresolved += 1;
      continue;
    }

    const exactCheck = await query(
      `SELECT 1 FROM exchange_rates WHERE currency_code = $1 AND rate_date = $2::date LIMIT 1`,
      [currencyCode, rateDate]
    );
    if (exactCheck.rows.length === 0) {
      await saveHistoricalRate(currencyCode, rateDate, rate);
      inserted += 1;
    }
  }

  if (inserted > 0 || unresolved > 0) {
    logger.info('Portfolio historical FX backfill complete', { inserted, unresolved });
  }

  return { inserted, missing: unresolved };
}

export default {
  convertToEur,
  convertRowsToEur,
  convertToCurrency,
  warmCache,
  clearMemoryCache,
  backfillPortfolioHistoricalRates,
  FALLBACK_RATES,
};
