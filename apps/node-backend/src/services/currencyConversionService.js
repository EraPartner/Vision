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
 * - Stores exactly ONE row per currency in the database (the latest rates)
 * - On a successful fetch the in-memory fallback is updated to match live rates
 * - If both APIs are unavailable the service falls back to DB → hardcoded constants
 */

import { query } from '../database/connection.js';
import { logger } from '../config/logger.js';

const ECB_LATEST_URL   = 'https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml';
const ERAR_LATEST_URL  = 'https://open.er-api.com/v6/latest/EUR';

// In-memory cache: { rates: {...}, timestamp: number } | null
let memoryCache = null;
const CACHE_LIFETIME_MS = 24 * 60 * 60 * 1000; // 24 hours

// Fallback rates (used only when both APIs and DB are unavailable).
// These are updated in-memory whenever a successful fetch occurs so that
// they stay current for the lifetime of the process.
// Covers ECB currencies plus common non-ECB currencies (Gulf, South Asia, Africa, etc.)
const FALLBACK_RATES = {
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

// ---------------------------------------------------------------------------
// XML parsing
// ---------------------------------------------------------------------------

/**
 * Parse ECB daily XML into a rates map { EUR: 1, USD: x, ... }.
 * ECB publishes EUR->X rates; we store X->EUR (1 / eurToX).
 *
 * The daily feed uses single-quoted attributes (e.g. currency='USD' rate='1.09')
 * while the historical feed uses double quotes — both variants are handled.
 */
function parseEcbXml(xmlText) {
  const rates = { EUR: 1.0 };
  const q = `['"]`;
  const currencyPattern = new RegExp(
    `<Cube\\s+currency=${q}([A-Z]{3})${q}\\s+rate=${q}([0-9.]+)${q}\\s*\\/>`,'g'
  );
  let match;
  while ((match = currencyPattern.exec(xmlText)) !== null) {
    const [, currency, rateStr] = match;
    const eurToX = parseFloat(rateStr);
    if (eurToX > 0) {
      rates[currency] = 1.0 / eurToX;
    }
  }
  return Object.keys(rates).length > 1 ? rates : null;
}

// ---------------------------------------------------------------------------
// Database (latest-only, no history)
// ---------------------------------------------------------------------------

/**
 * Load the stored latest rates from the database.
 * Returns null if no rows exist.
 */
async function loadFromDatabase() {
  try {
    const result = await query(
      `SELECT currency_code, rate_to_eur FROM exchange_rates WHERE is_latest = true`
    );
    if (result.rows.length === 0) return null;

    const rates = { EUR: 1.0 };
    for (const row of result.rows) {
      rates[row.currency_code] = parseFloat(row.rate_to_eur);
    }
    logger.debug(`Loaded ${result.rows.length} exchange rates from database`);
    return rates;
  } catch (err) {
    logger.error('Failed to load exchange rates from database', { error: err.message });
    return null;
  }
}

/**
 * Replace all stored rates with the freshly-fetched set.
 * Wipes every existing row and inserts the new rates so the table always
 * contains exactly one row per currency (the latest values).
 */
async function saveToDatabase(rates) {
  try {
    await query(`DELETE FROM exchange_rates`);

    const today = new Date().toISOString().split('T')[0];
    for (const [currency, rate] of Object.entries(rates)) {
      if (currency === 'EUR') continue;
      await query(
        `INSERT INTO exchange_rates (currency_code, rate_to_eur, rate_date, is_latest)
         VALUES ($1, $2, $3, true)`,
        [currency, rate, today]
      );
    }
    logger.info(`Saved ${Object.keys(rates).length - 1} latest exchange rates to database`);
  } catch (err) {
    logger.error('Failed to save exchange rates to database', { error: err.message });
  }
}

// ---------------------------------------------------------------------------
// API fetch
// ---------------------------------------------------------------------------

/**
 * Fetch the latest rates from the ECB daily feed.
 * Returns a { EUR: 1, USD: x, ... } map (X→EUR), or null on failure.
 */
async function fetchFromEcb() {
  try {
    const response = await fetch(ECB_LATEST_URL, { signal: AbortSignal.timeout(5000) });
    if (!response.ok) {
      logger.error(`ECB API returned ${response.status}`);
      return null;
    }
    const xmlText = await response.text();
    const rates = parseEcbXml(xmlText);
    if (rates) {
      logger.info(`Fetched ${Object.keys(rates).length - 1} exchange rates from ECB`);
    }
    return rates;
  } catch (err) {
    logger.error('Failed to fetch exchange rates from ECB', { error: err.message });
    return null;
  }
}

/**
 * Fetch the latest rates from open.er-api.com (supplementary source).
 * Returns a { EUR: 1, USD: x, ... } map (X→EUR), or null on failure.
 * Rates are EUR-based in the response (EUR->X), so we invert to X->EUR.
 */
async function fetchFromErApi() {
  try {
    const response = await fetch(ERAR_LATEST_URL, { signal: AbortSignal.timeout(5000) });
    if (!response.ok) {
      logger.error(`open.er-api returned ${response.status}`);
      return null;
    }
    const data = await response.json();
    if (data.result !== 'success' || !data.rates) {
      logger.error('Unexpected response from open.er-api', { result: data.result });
      return null;
    }
    const rates = { EUR: 1.0 };
    for (const [currency, eurToX] of Object.entries(data.rates)) {
      if (currency === 'EUR') continue;
      if (eurToX > 0) rates[currency] = 1.0 / eurToX;
    }
    logger.info(`Fetched ${Object.keys(rates).length - 1} exchange rates from open.er-api`);
    return rates;
  } catch (err) {
    logger.error('Failed to fetch exchange rates from open.er-api', { error: err.message });
    return null;
  }
}

// ---------------------------------------------------------------------------
// Public cache helpers
// ---------------------------------------------------------------------------

/**
 * Get the current rates, using the cache hierarchy:
 *   1. In-memory cache (24-hour TTL)
 *   2. Database (latest rows)
 *   3. Hardcoded fallback
 */
async function getRates() {
  // 1. Memory cache
  if (memoryCache && Date.now() - memoryCache.timestamp < CACHE_LIFETIME_MS) {
    return memoryCache.rates;
  }

  // 2. Database
  const dbRates = await loadFromDatabase();
  if (dbRates) {
    memoryCache = { rates: dbRates, timestamp: Date.now() };
    return dbRates;
  }

  // 3. Fallback
  logger.warn('Using fallback exchange rates — ECB API and database unavailable');
  return { ...FALLBACK_RATES };
}

/**
 * Clear the in-memory cache to force fresh data on next request.
 */
export function clearMemoryCache() {
  memoryCache = null;
  logger.debug('Cleared exchange rate memory cache');
}

/**
 * Fetch fresh rates from both sources, update the DB, memory cache, and fallback map.
 * ECB is fetched first and takes priority; open.er-api fills in every currency ECB
 * doesn't publish.  Called on startup and every 12 hours by the scheduler in main.js.
 */
export async function warmCache() {
  try {
    // 1. Fetch from both sources concurrently
    const [ecbRates, erarRates] = await Promise.all([fetchFromEcb(), fetchFromErApi()]);

    if (!ecbRates && !erarRates) {
      // Both APIs down — warm from DB or fallback so the cache is at least populated
      const rates = await getRates();
      logger.warn(`Exchange rate cache warmed from ${rates === FALLBACK_RATES ? 'fallback' : 'database'} (all APIs unavailable)`);
      return;
    }

    // 2. Merge: supplementary first, then ECB overwrites any overlaps
    const mergedRates = {
      ...(erarRates ?? {}),
      ...(ecbRates  ?? {}),
    };

    const ecbCount  = ecbRates  ? Object.keys(ecbRates).length  - 1 : 0;
    const erarCount = erarRates ? Object.keys(erarRates).length - 1 : 0;
    const totalCount = Object.keys(mergedRates).length - 1; // exclude EUR
    logger.info(`Merged exchange rates: ${ecbCount} from ECB + ${erarCount - ecbCount} supplementary = ${totalCount} total`);

    // 3. Update fallback, DB, and memory cache with the merged set
    Object.assign(FALLBACK_RATES, mergedRates);
    await saveToDatabase(mergedRates);
    memoryCache = { rates: mergedRates, timestamp: Date.now() };

  } catch (err) {
    logger.warn('Failed to warm exchange rate cache', { error: err.message });
  }
}

// ---------------------------------------------------------------------------
// Conversion helpers (public API)
// ---------------------------------------------------------------------------

/**
 * Convert an amount from a given currency to EUR.
 *
 * @param {number} amount - The amount to convert
 * @param {string|null} fromCurrency - ISO 4217 currency code (e.g. "USD")
 * @returns {Promise<number>} Amount in EUR
 */
export async function convertToEur(amount, fromCurrency) {
  if (!fromCurrency || fromCurrency.toUpperCase().trim() === 'EUR') {
    return amount;
  }

  const currency = fromCurrency.toUpperCase().trim();
  const rates = await getRates();

  if (!(currency in rates)) {
    logger.warn(`Unsupported currency ${currency}, using 1:1 conversion`);
    return amount;
  }

  return amount * rates[currency];
}

/**
 * Convert amounts in a SQL result set to EUR.
 * Designed for use with transaction queries that include `amount` and `currency` columns.
 *
 * @param {Array<{amount: number|string, currency: string|null}>} rows
 * @returns {Promise<Array<{...row, amount_eur: number}>>}
 */
export async function convertRowsToEur(rows) {
  if (!rows || rows.length === 0) return [];

  // Pre-warm once for all rows
  const rates = await getRates();

  return rows.map(row => {
    const currency = (row.currency || 'EUR').toUpperCase().trim();
    const amount = typeof row.amount === 'string' ? parseFloat(row.amount) : row.amount;

    let amountEur;
    if (currency === 'EUR') {
      amountEur = amount;
    } else if (currency in rates) {
      amountEur = amount * rates[currency];
    } else {
      logger.warn(`Unsupported currency ${currency}, using 1:1 conversion`);
      amountEur = amount;
    }

    return { ...row, amount_eur: amountEur };
  });
}

export { FALLBACK_RATES };
export default { convertToEur, convertRowsToEur, warmCache, clearMemoryCache, FALLBACK_RATES };
