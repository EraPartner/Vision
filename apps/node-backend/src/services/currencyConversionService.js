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
 * - Stores latest rows per currency and optionally sparse historical rows
 * - On a successful fetch the in-memory fallback is updated to match live rates
 * - If both APIs are unavailable the service falls back to DB → hardcoded constants
 */

import { query } from '../database/connection.js';
import { logger } from '../config/logger.js';

const ECB_LATEST_URL   = 'https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml';
const ERAR_LATEST_URL  = 'https://open.er-api.com/v6/latest/EUR';
const ECB_HISTORY_90D_URL = 'https://www.ecb.europa.eu/stats/eurofxref/eurofxref-hist-90d.xml';

// In-memory cache: { rates: {...}, timestamp: number } | null
let memoryCache = null;
const CACHE_LIFETIME_MS = 24 * 60 * 60 * 1000; // 24 hours
let historicalEcb90dCache = null; // { byDate: Map<YYYY-MM-DD, ratesMap>, timestamp }

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

function parseEcbHistoricalXml(xmlText) {
  const byDate = new Map();
  const dayBlocks = xmlText.match(/<Cube\s+time=['"][0-9]{4}-[0-9]{2}-[0-9]{2}['"][\s\S]*?<\/Cube>/g) || [];
  for (const block of dayBlocks) {
    const timeMatch = block.match(/time=['"]([0-9]{4}-[0-9]{2}-[0-9]{2})['"]/);
    if (!timeMatch) continue;
    const date = timeMatch[1];
    const rates = parseEcbXml(block);
    if (rates) byDate.set(date, rates);
  }
  return byDate;
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
 * Uses a single multi-row INSERT instead of N individual queries.
 */
async function saveToDatabase(rates) {
  try {
    const today = new Date().toISOString().split('T')[0];
    const entries = Object.entries(rates).filter(([c]) => c !== 'EUR');
    if (entries.length === 0) return;

    await query('BEGIN');
    // Clear latest marker only for currencies that are being refreshed now.
    await query(
      `UPDATE exchange_rates
       SET is_latest = false, updated_at = NOW()
       WHERE currency_code = ANY($1::text[]) AND is_latest = true`,
      [entries.map(([currency]) => currency)]
    );

    for (const [currency, rate] of entries) {
      await query(
        `INSERT INTO exchange_rates (currency_code, rate_to_eur, rate_date, is_latest)
         VALUES ($1, $2, $3, true)
         ON CONFLICT (currency_code, rate_date)
         DO UPDATE SET
           rate_to_eur = EXCLUDED.rate_to_eur,
           is_latest = true,
           fetched_at = NOW(),
           updated_at = NOW()`,
        [currency, rate, today]
      );
    }
    await query('COMMIT');
    logger.info(`Saved ${Object.keys(rates).length - 1} latest exchange rates to database`);
  } catch (err) {
    await query('ROLLBACK').catch(() => {});
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

async function fetchHistoricalFromEcb90d() {
  if (historicalEcb90dCache && Date.now() - historicalEcb90dCache.timestamp < CACHE_LIFETIME_MS) {
    return historicalEcb90dCache.byDate;
  }
  try {
    const response = await fetch(ECB_HISTORY_90D_URL, { signal: AbortSignal.timeout(8000) });
    if (!response.ok) return new Map();
    const xmlText = await response.text();
    const byDate = parseEcbHistoricalXml(xmlText);
    historicalEcb90dCache = { byDate, timestamp: Date.now() };
    return byDate;
  } catch {
    return new Map();
  }
}

function normalizeDateInput(dateValue) {
  if (!dateValue) return null;
  const str = String(dateValue);
  const m = str.match(/^\d{4}-\d{2}-\d{2}/);
  return m ? m[0] : null;
}

async function getNearestRateFromDatabase(currencyCode, dateStr) {
  const result = await query(
    `SELECT rate_to_eur
     FROM exchange_rates
     WHERE currency_code = $1
     ORDER BY ABS(rate_date - $2::date) ASC, rate_date DESC
     LIMIT 1`,
    [currencyCode, dateStr]
  );
  if (result.rows.length === 0) return undefined;
  return parseFloat(result.rows[0].rate_to_eur);
}

function buildHistoricalRateIndex(rows) {
  const byCurrency = new Map();
  for (const row of rows) {
    const currency = String(row.currency_code || '').toUpperCase().trim();
    const date = normalizeDateInput(row.rate_date);
    const rate = parseFloat(row.rate_to_eur);
    if (!currency || !date || !Number.isFinite(rate)) continue;
    if (!byCurrency.has(currency)) byCurrency.set(currency, []);
    byCurrency.get(currency).push({ date, rate });
  }
  for (const entries of byCurrency.values()) {
    entries.sort((a, b) => a.date.localeCompare(b.date));
  }
  return byCurrency;
}

function findNearestRateInIndex(index, currencyCode, dateStr) {
  if (currencyCode === 'EUR') return 1.0;
  const entries = index.get(currencyCode);
  if (!entries || entries.length === 0) return undefined;

  let lo = 0;
  let hi = entries.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const midDate = entries[mid].date;
    if (midDate === dateStr) return entries[mid].rate;
    if (midDate < dateStr) lo = mid + 1;
    else hi = mid - 1;
  }

  const prev = hi >= 0 ? entries[hi] : null;
  const next = lo < entries.length ? entries[lo] : null;
  if (!prev) return next?.rate;
  if (!next) return prev?.rate;

  const prevDist = Math.abs(new Date(prev.date).getTime() - new Date(dateStr).getTime());
  const nextDist = Math.abs(new Date(next.date).getTime() - new Date(dateStr).getTime());
  return prevDist <= nextDist ? prev.rate : next.rate;
}

async function saveHistoricalRate(currencyCode, dateStr, rateToEur) {
  await query(
    `INSERT INTO exchange_rates (currency_code, rate_to_eur, rate_date, is_latest)
     VALUES ($1, $2, $3, false)
     ON CONFLICT (currency_code, rate_date)
     DO UPDATE SET
       rate_to_eur = EXCLUDED.rate_to_eur,
       updated_at = NOW()`,
    [currencyCode, rateToEur, dateStr]
  );
}

async function getRateToEurForDate(currencyCode, dateValue, { saveFetchedHistoricalRate = true } = {}) {
  if (!currencyCode || currencyCode === 'EUR') return 1.0;
  const dateStr = normalizeDateInput(dateValue);
  if (!dateStr) return undefined;

  const exact = await query(
    `SELECT rate_to_eur
     FROM exchange_rates
     WHERE currency_code = $1 AND rate_date = $2::date
     LIMIT 1`,
    [currencyCode, dateStr]
  );
  if (exact.rows.length > 0) {
    return parseFloat(exact.rows[0].rate_to_eur);
  }

  const ecbByDate = await fetchHistoricalFromEcb90d();
  const ecbRatesForDate = ecbByDate.get(dateStr);
  if (ecbRatesForDate && ecbRatesForDate[currencyCode]) {
    const ecbRate = ecbRatesForDate[currencyCode];
    if (saveFetchedHistoricalRate) {
      await saveHistoricalRate(currencyCode, dateStr, ecbRate);
    }
    return ecbRate;
  }

  const nearest = await getNearestRateFromDatabase(currencyCode, dateStr);
  if (nearest !== undefined) return nearest;

  return undefined;
}

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
  historicalEcb90dCache = null;
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
/**
 * Convert an amount from `fromCurrency` to EUR.
 * Backwards-compatible wrapper around the generic convert function.
 */
export async function convertToEur(amount, fromCurrency) {
  return convertToCurrency(amount, fromCurrency, 'EUR');
}

/**
 * Convert amounts in a SQL result set to EUR.
 * Designed for use with transaction queries that include `amount` and `currency` columns.
 *
 * @param {Array<{amount: number|string, currency: string|null}>} rows
 * @returns {Promise<Array<{...row, amount_eur: number}>>}
 */
/**
 * Convert an array of rows to a target currency (default EUR).
 * Returns the same rows with `amount_eur` field containing the converted
 * amount in the requested target currency (keeps the original property name
 * for compatibility with existing consumers).
 *
 * @param {Array<{amount:number|string,currency:string}>} rows
 * @param {string} [targetCurrency='EUR']
 */
export async function convertRowsToEur(rows, targetCurrency = 'EUR', options = {}) {
  if (!rows || rows.length === 0) return [];

  const { useHistoricalRatesByDate = false, dateField = null } = options || {};

  // Normalize target
  const toCur = (targetCurrency || 'EUR').toUpperCase().trim();

  // Pre-warm once for all rows
  const rates = await getRates();

  const historicalRateCache = new Map();

  function resolveDateFromRow(row) {
    if (dateField && row[dateField]) return normalizeDateInput(row[dateField]);
    return normalizeDateInput(row.date || row.day || row.transaction_date || row.planned_date || row.rate_date);
  }

  async function getRate(currencyCode, rowDate) {
    if (!useHistoricalRatesByDate || !rowDate) {
      return rates[currencyCode];
    }
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
    ])]
      .filter(Boolean);

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
    const amount = typeof row.amount === 'string' ? parseFloat(row.amount) : row.amount;
    const rowDate = resolveDateFromRow(row);

    // Fast-path identical currencies
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
      // fallback: convert to EUR
      converted.push({ ...row, amount_eur: amount * rateFrom });
      continue;
    }

    // Convert: amount_in_target = amount * rateFrom (→ EUR) / rateTo (EUR→target)
    const amountTarget = (amount * rateFrom) / rateTo;
    converted.push({ ...row, amount_eur: amountTarget });
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

export { FALLBACK_RATES };
export default {
  convertToEur,
  convertRowsToEur,
  convertToCurrency,
  warmCache,
  clearMemoryCache,
  backfillPortfolioHistoricalRates,
  FALLBACK_RATES,
};
