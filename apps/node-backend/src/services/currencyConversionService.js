/**
 * Currency Conversion Service
 *
 * Converts currencies to EUR using ECB exchange rates.
 * Mirrors: apps/backend/services/currency_conversion_service.py
 *
 * Features:
 * - Real-time rates from European Central Bank API (free, no auth)
 * - Database caching (exchange_rates table)
 * - In-memory caching (24-hour lifetime)
 * - Fallback rates if API + DB unavailable
 */

import { query } from '../database/connection.js';
import { logger } from '../config/logger.js';

const ECB_LATEST_URL = 'https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml';
const ECB_HISTORICAL_URL = 'https://www.ecb.europa.eu/stats/eurofxref/eurofxref-hist-90d.xml';

const CACHE_LIFETIME_MS = 24 * 60 * 60 * 1000; // 24 hours
const DB_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// Fallback rates (only used if API and DB are completely unavailable)
const FALLBACK_RATES = {
  EUR: 1.0,
  USD: 1 / 1.09,
  GBP: 1 / 0.85,
  CHF: 1 / 0.95,
  JPY: 1 / 163.0,
  SAR: 1 / 4.09,
  SEK: 1 / 11.20,
  NOK: 1 / 11.50,
  DKK: 1 / 7.46,
  PLN: 1 / 4.30,
  CZK: 1 / 25.30,
  HUF: 1 / 395.0,
  RON: 1 / 4.97,
  BGN: 1 / 1.96,
  TRY: 1 / 35.0,
  AUD: 1 / 1.66,
  CAD: 1 / 1.50,
  CNY: 1 / 7.90,
  INR: 1 / 91.0,
  BRL: 1 / 5.40,
};

// In-memory cache: { [cacheKey]: { rates: {...}, timestamp: Date } }
const memoryCache = {};

/**
 * Parse ECB XML response to extract rates.
 * ECB gives EUR->X rates; we convert to X->EUR (i.e., 1 X = rate EUR).
 */
function parseEcbXml(xmlText, targetDateStr = null) {
  const rates = { EUR: 1.0 };

  // Simple regex-based XML parsing (no external dependency needed)
  if (targetDateStr) {
    // Historical: find the Cube with matching time attribute
    const datePattern = new RegExp(
      `<Cube\\s+time="${targetDateStr}"[^>]*>([\\s\\S]*?)</Cube>`,
      'i'
    );
    const dateMatch = xmlText.match(datePattern);
    if (!dateMatch) return null;

    const currencyPattern = /<Cube\s+currency="([A-Z]{3})"\s+rate="([0-9.]+)"\s*\/>/g;
    let match;
    while ((match = currencyPattern.exec(dateMatch[1])) !== null) {
      const [, currency, rateStr] = match;
      const eurToX = parseFloat(rateStr);
      if (eurToX > 0) {
        rates[currency] = 1.0 / eurToX; // X -> EUR
      }
    }
  } else {
    // Latest: parse all Cube currency entries
    const currencyPattern = /<Cube\s+currency="([A-Z]{3})"\s+rate="([0-9.]+)"\s*\/>/g;
    let match;
    while ((match = currencyPattern.exec(xmlText)) !== null) {
      const [, currency, rateStr] = match;
      const eurToX = parseFloat(rateStr);
      if (eurToX > 0) {
        rates[currency] = 1.0 / eurToX;
      }
    }
  }

  return Object.keys(rates).length > 1 ? rates : null;
}

/**
 * Load rates from the exchange_rates table.
 */
async function loadFromDatabase(rateDate) {
  try {
    const result = await query(
      `SELECT currency_code, rate_to_eur, fetched_at
       FROM exchange_rates
       WHERE rate_date = $1`,
      [rateDate]
    );

    if (result.rows.length === 0) return null;

    // Check age
    const latestFetch = result.rows.reduce((max, r) => {
      const t = new Date(r.fetched_at).getTime();
      return t > max ? t : max;
    }, 0);
    if (Date.now() - latestFetch > DB_MAX_AGE_MS) return null;

    const rates = { EUR: 1.0 };
    for (const row of result.rows) {
      rates[row.currency_code] = parseFloat(row.rate_to_eur);
    }

    logger.debug(`Loaded ${result.rows.length} exchange rates from database for ${rateDate}`);
    return rates;
  } catch (err) {
    logger.error('Failed to load exchange rates from database', { error: err.message });
    return null;
  }
}

/**
 * Save rates to the exchange_rates table.
 */
async function saveToDatabase(rateDate, rates) {
  try {
    const today = new Date().toISOString().split('T')[0];
    const isLatest = rateDate === today;

    if (isLatest) {
      await query(`UPDATE exchange_rates SET is_latest = false WHERE is_latest = true`);
    }

    for (const [currency, rate] of Object.entries(rates)) {
      if (currency === 'EUR') continue;
      await query(
        `INSERT INTO exchange_rates (currency_code, rate_to_eur, rate_date, is_latest)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (currency_code, rate_date)
         DO UPDATE SET rate_to_eur = $2, fetched_at = NOW(), is_latest = $4`,
        [currency, rate, rateDate, isLatest]
      );
    }

    logger.info(`Saved ${Object.keys(rates).length - 1} exchange rates to database for ${rateDate}`);
  } catch (err) {
    logger.error('Failed to save exchange rates to database', { error: err.message });
  }
}

/**
 * Fetch rates from ECB API.
 */
async function fetchFromApi(targetDate = null) {
  try {
    const isHistorical = targetDate && targetDate < new Date().toISOString().split('T')[0];
    const url = isHistorical ? ECB_HISTORICAL_URL : ECB_LATEST_URL;

    const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!response.ok) {
      logger.error(`ECB API returned ${response.status}`);
      return null;
    }

    const xmlText = await response.text();
    const rates = parseEcbXml(xmlText, isHistorical ? targetDate : null);

    if (rates) {
      logger.info(`Fetched ${Object.keys(rates).length} exchange rates from ECB`);
    }
    return rates;
  } catch (err) {
    logger.error('Failed to fetch exchange rates from ECB', { error: err.message });
    return null;
  }
}

/**
 * Get rates for a specific date, with cache hierarchy:
 * 1. Memory cache
 * 2. Database cache
 * 3. ECB API
 * 4. Fallback hardcoded rates
 */
async function getRatesForDate(dateStr) {
  const cacheKey = dateStr || 'latest';

  // 1. Memory cache
  const cached = memoryCache[cacheKey];
  if (cached && Date.now() - cached.timestamp < CACHE_LIFETIME_MS) {
    return cached.rates;
  }

  const effectiveDate = dateStr || new Date().toISOString().split('T')[0];

  // 2. Database cache
  const dbRates = await loadFromDatabase(effectiveDate);
  if (dbRates) {
    memoryCache[cacheKey] = { rates: dbRates, timestamp: Date.now() };
    return dbRates;
  }

  // 3. ECB API
  const apiRates = await fetchFromApi(dateStr);
  if (apiRates) {
    memoryCache[cacheKey] = { rates: apiRates, timestamp: Date.now() };
    await saveToDatabase(effectiveDate, apiRates);
    return apiRates;
  }

  // 4. Fallback
  logger.warn('Using fallback exchange rates — ECB API and database unavailable');
  memoryCache[cacheKey] = { rates: { ...FALLBACK_RATES }, timestamp: Date.now() };
  return FALLBACK_RATES;
}

/**
 * Convert an amount from a given currency to EUR.
 *
 * @param {number} amount - The amount to convert
 * @param {string|null} fromCurrency - ISO 4217 currency code (e.g. "USD")
 * @param {string|null} transactionDate - YYYY-MM-DD date string for historical rates
 * @returns {Promise<number>} Amount in EUR
 */
export async function convertToEur(amount, fromCurrency, transactionDate = null) {
  if (!fromCurrency || fromCurrency.toUpperCase().trim() === 'EUR') {
    return amount;
  }

  const currency = fromCurrency.toUpperCase().trim();
  const rates = await getRatesForDate(transactionDate);

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
 * @param {Array<{amount: number|string, currency: string|null, date?: string}>} rows
 * @returns {Promise<Array<{...row, amount_eur: number}>>}
 */
export async function convertRowsToEur(rows) {
  if (!rows || rows.length === 0) return [];

  // Batch: collect unique (currency, date) pairs to pre-fetch rates
  const datesToFetch = new Set();
  for (const row of rows) {
    const currency = (row.currency || 'EUR').toUpperCase().trim();
    if (currency !== 'EUR') {
      const dateStr = row.date instanceof Date
        ? row.date.toISOString().split('T')[0]
        : row.date || null;
      datesToFetch.add(dateStr || 'latest');
    }
  }

  // Pre-warm cache for all needed dates
  await Promise.all([...datesToFetch].map(d => getRatesForDate(d === 'latest' ? null : d)));

  // Convert
  const results = [];
  for (const row of rows) {
    const currency = (row.currency || 'EUR').toUpperCase().trim();
    const amount = typeof row.amount === 'string' ? parseFloat(row.amount) : row.amount;
    const dateStr = row.date instanceof Date
      ? row.date.toISOString().split('T')[0]
      : row.date || null;

    const amountEur = await convertToEur(amount, currency, dateStr);
    results.push({ ...row, amount_eur: amountEur });
  }

  return results;
}

/**
 * Warm the cache on startup (non-blocking).
 */
export async function warmCache() {
  try {
    // Always fetch fresh rates from ECB on startup, regardless of DB cache
    const today = new Date().toISOString().split('T')[0];
    const apiRates = await fetchFromApi(null);
    if (apiRates) {
      memoryCache['latest'] = { rates: apiRates, timestamp: Date.now() };
      memoryCache[today] = { rates: apiRates, timestamp: Date.now() };
      await saveToDatabase(today, apiRates);
      logger.info(`Exchange rate cache warmed with ${Object.keys(apiRates).length} fresh rates from ECB`);
    } else {
      // Fall back to normal cache hierarchy if API fails
      await getRatesForDate(null);
      logger.info('Exchange rate cache warmed from DB/fallback (ECB API unavailable)');
    }
  } catch (err) {
    logger.warn('Failed to warm exchange rate cache', { error: err.message });
  }
}

export { FALLBACK_RATES };
export default { convertToEur, convertRowsToEur, warmCache, FALLBACK_RATES };
