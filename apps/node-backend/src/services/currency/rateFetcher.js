/**
 * Rate Fetcher
 *
 * Fetches exchange rates from ECB (primary) and open.er-api.com (supplementary),
 * persists them to the database, and provides historical rate lookup utilities.
 */

import { query } from '../../database/connection.js';
import { logger } from '../../config/logger.js';
import { toDecimal, toNumber } from '../../lib/money.js';

const ECB_LATEST_URL      = 'https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml';
const ERAR_LATEST_URL     = 'https://open.er-api.com/v6/latest/EUR';
const ECB_HISTORY_90D_URL = 'https://www.ecb.europa.eu/stats/eurofxref/eurofxref-hist-90d.xml';

export const CACHE_LIFETIME_MS = 24 * 60 * 60 * 1000; // 24 hours

// { byDate: Map<YYYY-MM-DD, ratesMap>, timestamp }
let historicalEcb90dCache = null;

// ─── Date helpers ─────────────────────────────────────────────────────────────

export function normalizeDateInput(dateValue) {
  if (!dateValue) return null;
  const str = String(dateValue);
  const m = str.match(/^\d{4}-\d{2}-\d{2}/);
  return m ? m[0] : null;
}

// ─── XML parsing ──────────────────────────────────────────────────────────────

/**
 * Parse ECB daily/historical XML into a { EUR: 1, USD: x, ... } rates map.
 * ECB publishes EUR->X rates; we store X->EUR (1 / eurToX).
 * Handles both single-quoted and double-quoted attributes.
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
    if (Number.isFinite(eurToX) && eurToX > 0.0001 && eurToX < 100000) {
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

// ─── API fetchers ─────────────────────────────────────────────────────────────

/**
 * Fetch the latest rates from the ECB daily feed.
 * Returns a { EUR: 1, USD: x, ... } map (X->EUR), or null on failure.
 */
export async function fetchFromEcb() {
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
 * Returns a { EUR: 1, USD: x, ... } map (X->EUR), or null on failure.
 */
export async function fetchFromErApi() {
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
      if (
        currency !== 'EUR' &&
        Number.isFinite(eurToX) &&
        eurToX > 0.0001 &&
        eurToX < 100000
      ) {
        rates[currency] = 1.0 / eurToX;
      }
    }
    logger.info(`Fetched ${Object.keys(rates).length - 1} exchange rates from open.er-api`);
    return rates;
  } catch (err) {
    logger.error('Failed to fetch exchange rates from open.er-api', { error: err.message });
    return null;
  }
}

export async function fetchHistoricalFromEcb90d() {
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

export function clearHistoricalCache() {
  historicalEcb90dCache = null;
}

// ─── Database ─────────────────────────────────────────────────────────────────

/**
 * Load the stored latest rates from the database.
 * Returns null if no rows exist.
 */
export async function loadFromDatabase() {
  try {
    const result = await query(
      `SELECT currency_code, rate_to_eur FROM exchange_rates WHERE is_latest = true`
    );
    if (result.rows.length === 0) return null;

    const rates = { EUR: 1.0 };
    for (const row of result.rows) {
      rates[row.currency_code] = toNumber(toDecimal(row.rate_to_eur));
    }
    logger.debug(`Loaded ${result.rows.length} exchange rates from database`);
    return rates;
  } catch (err) {
    logger.error('Failed to load exchange rates from database', { error: err.message });
    return null;
  }
}

/**
 * Replace stored rates with the freshly-fetched set.
 * Single transaction: clear latest markers, then upsert new rates.
 */
export async function saveToDatabase(rates) {
  try {
    const today = new Date().toISOString().split('T')[0];
    const entries = Object.entries(rates).filter(([c]) => c !== 'EUR');
    if (entries.length === 0) return;

    await query('BEGIN');
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

export async function saveHistoricalRate(currencyCode, dateStr, rateToEur) {
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

export async function getNearestRateFromDatabase(currencyCode, dateStr) {
  const result = await query(
    `SELECT rate_to_eur
     FROM exchange_rates
     WHERE currency_code = $1
     ORDER BY ABS(rate_date - $2::date) ASC, rate_date DESC
     LIMIT 1`,
    [currencyCode, dateStr]
  );
  if (result.rows.length === 0) return undefined;
  return toNumber(toDecimal(result.rows[0].rate_to_eur));
}

// ─── Historical rate index (in-memory binary search) ─────────────────────────

export function buildHistoricalRateIndex(rows) {
  const byCurrency = new Map();
  for (const row of rows) {
    const currency = String(row.currency_code || '').toUpperCase().trim();
    const date = normalizeDateInput(row.rate_date);
    const rate = toNumber(toDecimal(row.rate_to_eur));
    if (!currency || !date || !Number.isFinite(rate)) continue;
    if (!byCurrency.has(currency)) byCurrency.set(currency, []);
    byCurrency.get(currency).push({ date, rate });
  }
  for (const entries of byCurrency.values()) {
    entries.sort((a, b) => a.date.localeCompare(b.date));
  }
  return byCurrency;
}

export function findNearestRateInIndex(index, currencyCode, dateStr) {
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

// ─── Historical rate point lookup ─────────────────────────────────────────────

export async function getRateToEurForDate(currencyCode, dateValue, { saveFetchedHistoricalRate = true } = {}) {
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
    return toNumber(toDecimal(exact.rows[0].rate_to_eur));
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

  return getNearestRateFromDatabase(currencyCode, dateStr);
}
