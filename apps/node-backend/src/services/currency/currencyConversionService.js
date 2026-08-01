/**
 * Currency Conversion Service
 *
 * Converts currencies to EUR using ECB exchange rates.
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
import { recordSuccess as recordProviderSuccess, recordError as recordProviderError } from '../providerHealthService.js';
import {
  CACHE_LIFETIME_MS,
  normalizeDateInput,
  fetchFromEcb,
  fetchFromErApi,
  fetchHistoricalFromEcbFull,
  rateOnOrBeforeFromMap,
  loadFromDatabase,
  saveToDatabase,
  saveHistoricalRate,
  buildHistoricalRateIndex,
  findNearestRateInIndex,
  getRateToEurForDate,
  clearHistoricalCache,
} from './rateFetcher.js';
import { settingsRepository } from '../../repositories/settingsRepository.js';

/**
 * @typedef {import('../../types/rows.js').ExchangeRateRow} ExchangeRateRow
 * @typedef {import('../../types/rows.js').HistoricalRateIndex} HistoricalRateIndex
 * @typedef {import('../../types/rows.js').RateTable} RateTable
 */

// In-memory cache: { rates: {...}, timestamp: number } | null
/** @type {{ rates: RateTable, timestamp: number } | null} */
let memoryCache = null;

// Process-level cache of the built historical-rate index. Historical-FX row
// conversion (convertRowsToEur, dataFetcherTax) otherwise reloaded the full
// exchange_rates history and rebuilt the index on EVERY request. The index is
// built for a growing union of requested currencies so a request with a new
// currency set doesn't invalidate it; it's invalidated whenever rates are
// refreshed (warmCache), the memory cache is cleared, or a backfill runs, and
// expires after CACHE_LIFETIME_MS as a backstop. Cache misses still resolve
// correctly via the per-date fallback paths, so conversion results are unchanged.
/** @type {{ index: HistoricalRateIndex, currencies: string[], builtAt: number } | null} */
let historicalIndexCache = null;

// Static hardcoded fallback rates. Never mutated.
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

// Live fallback — refreshed to latest fetched rates so cache-miss + DB-miss still gets fresh data.
/** @type {Record<string, number>} */
let liveFallbackRates = FALLBACK_RATES;

// ─── Cache helpers ────────────────────────────────────────────────────────────

/**
 * Get current rates using the cache hierarchy:
 *   1. In-memory cache (24-hour TTL)
 *   2. Database (latest rows)
 *   3. Hardcoded fallback
 *
 * @returns {Promise<RateTable>}
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
  // Return the reference (callers never mutate) so warmCache can detect that
  // the fallback path was taken via identity comparison.
  return liveFallbackRates;
}

/**
 * Clear in-memory cache to force fresh data on next request.
 */
export function clearMemoryCache() {
  memoryCache = null;
  clearHistoricalCache();
  clearHistoricalIndexCache();
  logger.debug('Cleared exchange rate memory cache');
}

/** Drop the cached historical-rate index (rebuilt on next demand). */
export function clearHistoricalIndexCache() {
  historicalIndexCache = null;
}

/**
 * Historical-rate index for the given currencies, cached at process level and
 * shared across call sites. Builds (or extends) the index for the union of
 * already-cached and newly-requested currencies so distinct currency sets don't
 * thrash the cache. A superset index is safe: per-currency lookups
 * (findNearestRateInIndex / findRateOnOrBeforeInIndex) are unaffected by extra
 * currencies being present.
 *
 * @param {string[]} currencies
 * @returns {Promise<Map<string, Array<{date: string, rate: number}>>>}
 */
export async function getHistoricalRateIndex(currencies) {
  const wanted = [...new Set(currencies)].filter(Boolean);
  if (wanted.length === 0) return new Map();

  const fresh = historicalIndexCache !== null
    && Date.now() - historicalIndexCache.builtAt < CACHE_LIFETIME_MS;
  if (fresh && wanted.every((c) => historicalIndexCache.currencies.includes(c))) {
    return historicalIndexCache.index;
  }

  const union = fresh
    ? [...new Set([...historicalIndexCache.currencies, ...wanted])]
    : wanted;
  const result = await query(
    `SELECT currency_code, to_char(rate_date, 'YYYY-MM-DD') AS rate_date, rate_to_eur
     FROM exchange_rates
     WHERE currency_code = ANY($1::text[])
     ORDER BY currency_code ASC, rate_date ASC`,
    [union]
  );
  const index = buildHistoricalRateIndex(result.rows || []);
  historicalIndexCache = { index, currencies: union, builtAt: Date.now() };
  return index;
}

/**
 * Latest stored exchange-rate rows (`is_latest = true`), one per currency,
 * ordered by currency code. Returns the raw pg result — the /exchange-rates
 * route owns response shaping (ADR-067: routes call services, never the
 * database layer directly).
 */
export async function listLatestStoredRates() {
  return query(`
      SELECT currency_code, rate_to_eur, rate_date, fetched_at
      FROM exchange_rates
      WHERE is_latest = true
      ORDER BY currency_code ASC
    `);
}

/**
 * Fetch fresh rates from both sources, update DB, memory cache, and fallback map.
 * ECB is fetched first and takes priority; open.er-api fills in currencies ECB doesn't publish.
 * Called on startup and every 12 hours by the scheduler in main.js.
 */
export async function warmCache() {
  try {
    const [ecbRates, erarRates] = await Promise.all([fetchFromEcb(), fetchFromErApi()]);

    if (ecbRates) {
      recordProviderSuccess('ecb');
    } else {
      recordProviderError('ecb', 'ECB fetch returned no rates');
    }

    if (erarRates) {
      recordProviderSuccess('open.er-api');
    } else {
      recordProviderError('open.er-api', 'open.er-api fetch returned no rates');
    }

    if (!ecbRates && !erarRates) {
      const rates = await getRates();
      logger.warn(`Exchange rate cache warmed from ${rates === liveFallbackRates ? 'fallback' : 'database'} (all APIs unavailable)`);
      return;
    }

    // Supplementary first, then ECB overwrites any overlaps
    /** @type {Record<string, number>} */
    const mergedRates = {
      ...(erarRates ?? {}),
      ...(ecbRates  ?? {}),
    };

    const ecbCount  = ecbRates  ? Object.keys(ecbRates).length  - 1 : 0;
    const totalCount = Object.keys(mergedRates).length - 1;
    // Supplementary = er-api currencies that survived the ECB-priority merge,
    // i.e. total minus ECB (not erarCount − ecbCount, which miscounted when
    // the two sources didn't fully overlap).
    logger.info(`Merged exchange rates: ${ecbCount} from ECB + ${totalCount - ecbCount} supplementary = ${totalCount} total`);

    liveFallbackRates = mergedRates;
    await saveToDatabase(mergedRates);
    memoryCache = { rates: mergedRates, timestamp: Date.now() };
    // Fresh rates were written — drop the cached historical index so the 12h
    // refresh cycle is the primary invalidation hook for it.
    clearHistoricalIndexCache();
  } catch (err) {
    logger.warn('Failed to warm exchange rate cache', { error: err.message });
  }
}

// ─── Conversion helpers ───────────────────────────────────────────────────────

/**
 * Convert an amount from `fromCurrency` to EUR.
 *
 * @param {number} amount
 * @param {string|null|undefined} fromCurrency falsy is treated as "already EUR"
 * @returns {Promise<number>}
 */
export async function convertToEur(amount, fromCurrency) {
  return convertToCurrency(amount, fromCurrency, 'EUR');
}

/**
 * Convert an array of rows to a target currency (default EUR).
 * Rows must have `amount` and `currency` fields.
 * Returns rows with an `amount_eur` field containing the converted amount.
 *
 * @param {Array<Record<string, any>>} rows
 * @param {string} [targetCurrency='EUR']
 * @param {{ useHistoricalRatesByDate?: boolean, dateField?: string|null }} [options]
 * @returns {Promise<Array<Record<string, any>>>}
 */
export async function convertRowsToEur(rows, targetCurrency = 'EUR', options = {}) {
  if (!rows || rows.length === 0) return [];

  const { useHistoricalRatesByDate = false, dateField = null } = options || {};
  const toCur = (targetCurrency || 'EUR').toUpperCase().trim();
  const rates = await getRates();

  /** @type {Map<string, number|undefined>} */
  const historicalRateCache = new Map();

  // Per-request memo for currencies the historical index knows NOTHING about.
  // The index is empty for a currency only when `exchange_rates` holds no row
  // for it at all, and then the per-date point lookup below misses on EVERY
  // date and goes to the network. A daily series (balance history: up to 366
  // distinct days per request) turned that into hundreds of sequential
  // round-trips, each of which is a multi-second timeout when offline. One
  // attempt per currency per request is enough: it saves what it fetches, so
  // the index has a row to interpolate from next time.
  /** @type {Map<string, number|undefined>} */
  const unindexedCurrencyRate = new Map();

  /**
   * @param {Record<string, any>} row
   * @returns {string|null} 'YYYY-MM-DD', or null when the row carries no usable date
   */
  function resolveDateFromRow(row) {
    if (dateField && row[dateField]) return normalizeDateInput(row[dateField]);
    return normalizeDateInput(row.date || row.day || row.transaction_date || row.planned_date || row.rate_date);
  }

  /**
   * @param {string} currencyCode
   * @param {string|null} rowDate
   * @returns {Promise<number|undefined>}
   */
  async function getRate(currencyCode, rowDate) {
    if (!useHistoricalRatesByDate || !rowDate) return rates[currencyCode];
    const key = `${currencyCode}:${rowDate}`;
    if (historicalRateCache.has(key)) return historicalRateCache.get(key);
    const value = await getRateToEurForDate(currencyCode, rowDate, { saveFetchedHistoricalRate: true });
    historicalRateCache.set(key, value);
    return value;
  }

  // Resolve a rate for one side of the conversion. Returns the rate plus a
  // boolean flagging whether we fell back to current rates because the
  // requested historical rate was missing. Callers surface this so the
  // frontend can label affected rows.
  /**
   * @param {string} code
   * @param {string|null} rowDate
   * @returns {Promise<{ rate: number|undefined, fellBack: boolean }>}
   */
  async function resolveRateWithFallback(code, rowDate) {
    if (code === 'EUR') return { rate: 1, fellBack: false };

    if (!useHistoricalRatesByDate || !rowDate) {
      return { rate: rates[code], fellBack: false };
    }

    const historical = historicalIndex
      ? findNearestRateInIndex(historicalIndex, code, rowDate)
      : undefined;
    if (historical !== undefined) return { rate: historical, fellBack: false };

    // Index built but empty for this currency (findNearestRateInIndex only
    // misses when the currency has no entries at all): one network attempt per
    // request, not one per date. See unindexedCurrencyRate above.
    let fetched;
    if (historicalIndex && unindexedCurrencyRate.has(code)) {
      fetched = unindexedCurrencyRate.get(code);
    } else {
      fetched = await getRate(code, rowDate);
      if (historicalIndex) unindexedCurrencyRate.set(code, fetched);
    }
    if (fetched !== undefined) return { rate: fetched, fellBack: false };

    const fallback = rates[code];
    if (fallback !== undefined) {
      logger.warn('Historical FX missing, falling back to current rate', { currency: code, date: rowDate });
      return { rate: fallback, fellBack: true };
    }
    // No rate found anywhere — flag as fellBack so the frontend shows the indicator.
    return { rate: undefined, fellBack: true };
  }

  /** @type {HistoricalRateIndex|null} */
  let historicalIndex = null;
  if (useHistoricalRatesByDate) {
    const relevantCurrencies = [...new Set([
      ...rows.map(row => (row.currency || 'EUR').toUpperCase().trim()),
      toCur,
    ])].filter(Boolean);

    if (relevantCurrencies.length > 0) {
      historicalIndex = await getHistoricalRateIndex(relevantCurrencies);
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

    const fromResolved = await resolveRateWithFallback(currency, rowDate);
    const toResolved = await resolveRateWithFallback(toCur, rowDate);
    const fellBack = fromResolved.fellBack || toResolved.fellBack;
    const fallbackFields = fellBack
      ? { used_fallback_rate: true, fallback_reason: 'historical_rate_missing' }
      : {};

    if (!fromResolved.rate) {
      logger.warn(`Unsupported source currency ${currency}, using 1:1 conversion`);
      converted.push({ ...row, amount_eur: amount, ...fallbackFields });
      continue;
    }
    if (!toResolved.rate) {
      logger.warn(`Unsupported target currency ${toCur}, falling back to EUR`);
      // eslint-disable-next-line vision-local-money/no-raw-money-arithmetic
      converted.push({ ...row, amount_eur: amount * fromResolved.rate, ...fallbackFields });
      continue;
    }

    // eslint-disable-next-line vision-local-money/no-raw-money-arithmetic
    converted.push({ ...row, amount_eur: (amount * fromResolved.rate) / toResolved.rate, ...fallbackFields });
  }

  return converted;
}

/**
 * Generic converter from any currency to any currency.
 *
 * @param {number} amount
 * @param {string|null|undefined} fromCurrency falsy short-circuits to `amount`
 * @param {string|null|undefined} toCurrency defaults to EUR when falsy
 * @returns {Promise<number>}
 */
export async function convertToCurrency(amount, fromCurrency, toCurrency) {
  if (!fromCurrency || fromCurrency.toUpperCase().trim() === (toCurrency || 'EUR').toUpperCase().trim()) {
    return amount;
  }
  const rates = await getRates();
  return convertWithRates(amount, fromCurrency, toCurrency, rates);
}

/**
 * Fetch the current rate table once. Callers that convert many rows in a loop
 * should call this once and pass the result to {@link convertWithRates},
 * avoiding a per-row `await` on the (already memory-cached) rate lookup.
 *
 * @returns {Promise<RateTable>}
 */
export async function loadCurrentRates() {
  return getRates();
}

/**
 * Synchronous conversion against a pre-fetched rate table. Mirrors the logic of
 * {@link convertToCurrency} exactly — only the rate acquisition is hoisted out.
 *
 * @param {number} amount
 * @param {string|null|undefined} fromCurrency falsy short-circuits to `amount`
 * @param {string|null|undefined} toCurrency defaults to EUR when falsy
 * @param {RateTable} rates
 * @returns {number}
 */
export function convertWithRates(amount, fromCurrency, toCurrency, rates) {
  if (!fromCurrency || fromCurrency.toUpperCase().trim() === (toCurrency || 'EUR').toUpperCase().trim()) {
    return amount;
  }

  const from = fromCurrency.toUpperCase().trim();
  const to = (toCurrency || 'EUR').toUpperCase().trim();

  const rateFrom = rates[from];
  const rateTo = rates[to];

  if (!rateFrom) {
    logger.warn(`Unsupported currency ${from}, using 1:1 conversion`);
    return amount;
  }
  if (!rateTo) {
    logger.warn(`Unsupported target currency ${to}, falling back to EUR conversion`);
    // eslint-disable-next-line vision-local-money/no-raw-money-arithmetic
    return amount * rateFrom;
  }

  // eslint-disable-next-line vision-local-money/no-raw-money-arithmetic
  return (amount * rateFrom) / rateTo;
}

// ─── Historical backfill ──────────────────────────────────────────────────────

// One-time repair marker: before the full-history tier existed, the backfill
// saved nearest-known rates under old transaction dates (fabricated history).
// The repair overwrites those rows with true ECB rates; the flag is only set
// once the full-history download succeeded so offline starts retry later.
const FX_FULL_HISTORY_REPAIR_FLAG = 'fx_full_history_repair_done';

/**
 * Bulk writes must target the inheritance base table when the legacy layout is
 * present — `portfolio_transactions` is a non-updatable view there.
 */
async function portfolioTxTableForBulkWrites() {
  const result = await query(
    "SELECT to_regclass('public.portfolio_transactions_base') AS base_table"
  );
  return result.rows[0]?.base_table ? 'portfolio_transactions_base' : 'portfolio_transactions';
}

/**
 * Overwrite stored txn-date rates with true ECB full-history values (one-time).
 *
 * @param {Array<{currency_code: string, rate_date: string|Date}>} pairs distinct non-EUR (currency, date) pairs
 * @returns {Promise<number|undefined>} rows repaired, or undefined when the repair could not run (offline)
 */
async function repairHistoricalRatesFromFullHistory(pairs) {
  if ((await settingsRepository.get(FX_FULL_HISTORY_REPAIR_FLAG)) === true) return 0;

  const fullByDate = await fetchHistoricalFromEcbFull();
  if (fullByDate.size === 0) return undefined;

  const currencies = [...new Set(pairs.map((p) => String(p.currency_code || '').toUpperCase().trim()))].filter(Boolean);
  const storedResult = await query(
    `SELECT currency_code, to_char(rate_date, 'YYYY-MM-DD') AS rate_date, rate_to_eur
     FROM exchange_rates
     WHERE currency_code = ANY($1::text[])`,
    [currencies]
  );
  const storedByKey = new Map(
    /** @type {Array<Pick<ExchangeRateRow, 'currency_code'|'rate_to_eur'> & { rate_date: string }>} */
    (storedResult.rows).map((r) => [`${r.currency_code}:${r.rate_date}`, toNumber(toDecimal(r.rate_to_eur))])
  );

  let repaired = 0;
  for (const pair of pairs) {
    const code = String(pair.currency_code || '').toUpperCase().trim();
    const dateStr = normalizeDateInput(pair.rate_date);
    if (!code || !dateStr) continue;

    const truth = rateOnOrBeforeFromMap(fullByDate, code, dateStr);
    if (truth === undefined) continue; // currency not published by ECB

    const stored = storedByKey.get(`${code}:${dateStr}`);
    if (stored !== undefined && Math.abs(stored - truth) <= Math.abs(truth) * 1e-9) continue;

    await saveHistoricalRate(code, dateStr, truth);
    repaired += 1;
  }

  await settingsRepository.set(FX_FULL_HISTORY_REPAIR_FLAG, true);
  return repaired;
}

/**
 * Stamp `fx_rate_to_eur` onto non-EUR transactions that lack it, using the
 * stored rate on-or-before the transaction date (≤ 7 days back — the standard
 * weekend/holiday convention). Distant nearest rates are never stamped; those
 * rows stay NULL and read paths keep resolving them per-date with a fallback flag.
 */
async function stampTransactionFxRates() {
  const table = await portfolioTxTableForBulkWrites();
  const result = await query(
    `UPDATE ${table} pt
     SET fx_rate_to_eur = sub.rate
     FROM (
       SELECT pt2.id,
              (SELECT er.rate_to_eur
               FROM exchange_rates er
               WHERE er.currency_code = UPPER(pt2.currency::text)
                 AND er.rate_date <= pt2.date::date
                 AND er.rate_date >= pt2.date::date - INTERVAL '7 days'
               ORDER BY er.rate_date DESC
               LIMIT 1) AS rate
       FROM ${table} pt2
       WHERE pt2.fx_rate_to_eur IS NULL
         AND pt2.currency IS NOT NULL
         AND UPPER(pt2.currency::text) <> 'EUR'
     ) sub
     WHERE pt.id = sub.id AND sub.rate IS NOT NULL`
  );
  return result.rowCount ?? 0;
}

export async function backfillPortfolioHistoricalRates() {
  const pairsResult = await query(
    `SELECT pt.currency::text AS currency_code, pt.date::date AS rate_date
     FROM portfolio_transactions pt
     WHERE pt.currency IS NOT NULL
       AND UPPER(pt.currency::text) <> 'EUR'
     GROUP BY pt.currency::text, pt.date::date
     ORDER BY pt.date::date ASC`
  );
  if (pairsResult.rows.length === 0) return { inserted: 0, missing: 0, repaired: 0, stamped: 0 };

  let repaired = 0;
  try {
    repaired = (await repairHistoricalRatesFromFullHistory(pairsResult.rows)) ?? 0;
  } catch (err) {
    logger.warn('Full-history FX repair failed — will retry next startup', { error: err.message });
  }

  const missingResult = await query(
    `SELECT pt.currency::text AS currency_code, pt.date::date AS rate_date
     FROM portfolio_transactions pt
     LEFT JOIN exchange_rates er
       ON er.currency_code = UPPER(pt.currency::text)
      AND er.rate_date = pt.date::date
     WHERE pt.currency IS NOT NULL
       AND UPPER(pt.currency::text) <> 'EUR'
       AND er.id IS NULL
     GROUP BY pt.currency::text, pt.date::date
     ORDER BY pt.date::date ASC`
  );

  let inserted = 0;
  let unresolved = 0;

  const resolvedPairs = [];
  for (const row of missingResult.rows) {
    const currencyCode = String(row.currency_code || '').toUpperCase().trim();
    const rateDate = normalizeDateInput(row.rate_date);
    if (!currencyCode || !rateDate) continue;

    // getRateToEurForDate persists rates it sources from ECB (90d or full
    // history). When it falls through to a nearest-stored rate no exact row
    // appears — count those as unresolved rather than fabricating history.
    await getRateToEurForDate(currencyCode, rateDate, { saveFetchedHistoricalRate: true });
    resolvedPairs.push({ currencyCode, rateDate });
  }

  // One batched existence check for every attempted pair, replacing the former
  // per-row SELECT (the N+1). Same accounting: a pair with an exact stored row
  // now counts as inserted, everything else unresolved.
  if (resolvedPairs.length > 0) {
    const codes = resolvedPairs.map((p) => p.currencyCode);
    const dates = resolvedPairs.map((p) => p.rateDate);
    const existsResult = await query(
      `SELECT er.currency_code, er.rate_date::text AS rate_date
         FROM exchange_rates er
         JOIN UNNEST($1::text[], $2::text[]) AS want(currency_code, rate_date)
           ON er.currency_code = want.currency_code
          AND er.rate_date = want.rate_date::date`,
      [codes, dates]
    );
    const present = new Set(
      /** @type {Array<Pick<ExchangeRateRow, 'currency_code'> & { rate_date: string }>} */
      (existsResult.rows).map((r) => `${r.currency_code}|${String(r.rate_date).slice(0, 10)}`)
    );
    for (const p of resolvedPairs) {
      if (present.has(`${p.currencyCode}|${p.rateDate}`)) inserted += 1;
      else unresolved += 1;
    }
  }

  let stamped = 0;
  try {
    stamped = await stampTransactionFxRates();
  } catch (err) {
    logger.warn('Stamping fx_rate_to_eur onto transactions failed', { error: err.message });
  }

  if (inserted > 0 || unresolved > 0 || repaired > 0 || stamped > 0) {
    logger.info('Portfolio historical FX backfill complete', { inserted, unresolved, repaired, stamped });
  }

  if (inserted > 0 || repaired > 0) {
    clearHistoricalCache();
    clearHistoricalIndexCache();
  }

  return { inserted, missing: unresolved, repaired, stamped };
}

export default {
  convertToEur,
  convertRowsToEur,
  convertToCurrency,
  convertWithRates,
  loadCurrentRates,
  listLatestStoredRates,
  warmCache,
  clearMemoryCache,
  backfillPortfolioHistoricalRates,
  FALLBACK_RATES,
};
