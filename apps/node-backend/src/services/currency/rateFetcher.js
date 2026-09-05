/**
 * Rate Fetcher
 *
 * Fetches exchange rates from ECB (primary) and open.er-api.com (supplementary),
 * persists them to the database, and provides historical rate lookup utilities.
 */

import { query, withTransaction } from "../../database/connection.js";
import { logger } from "../../config/logger.js";
import { toDecimal, toNumber } from "../../lib/money.js";
import { todayAppDateString } from "../../lib/timezone.js";
import { formatDateToYmd, epochMsToUtcYmd } from "../../lib/dateFormat.js";

/**
 * @typedef {import('../../types/rows.js').ExchangeRateRow} ExchangeRateRow
 * @typedef {import('../../types/rows.js').HistoricalRatePoint} HistoricalRatePoint
 * @typedef {import('../../types/rows.js').HistoricalRateIndex} HistoricalRateIndex
 * @typedef {import('../../types/rows.js').RateTable} RateTable
 */

/**
 * A parsed ECB history feed: 'YYYY-MM-DD' → that day's rate table.
 *
 * @typedef {Map<string, RateTable>} RatesByDate
 */

const ECB_LATEST_URL =
  "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml";
const ERAR_LATEST_URL = "https://open.er-api.com/v6/latest/EUR";
const ECB_HISTORY_90D_URL =
  "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-hist-90d.xml";
// Full ECB reference-rate history (one ~6 MB XML, daily back to 1999). Only
// fetched when a rate older than the 90-day window is actually needed.
const ECB_HISTORY_FULL_URL =
  "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-hist.xml";

export const CACHE_LIFETIME_MS = 24 * 60 * 60 * 1000; // 24 hours

// Idle window after which the full-history cache (~6 MB parsed) is dropped so a
// single old-date lookup doesn't pin it in memory for the process lifetime. The
// timer is reset on every access, so an actively-used cache is retained.
 const HISTORICAL_FULL_CACHE_IDLE_MS = 60 * 60 * 1000; // 1 hour

// { byDate: Map<YYYY-MM-DD, ratesMap>, timestamp }
/** @type {{ byDate: RatesByDate, timestamp: number } | null} */
let historicalEcb90dCache = null;
/** @type {{ byDate: RatesByDate, timestamp: number } | null} */
let historicalEcbFullCache = null;
/** @type {ReturnType<typeof setTimeout> | null} */
let historicalEcbFullEvictTimer = null;

/**
 * (Re)arm the idle-eviction timer for the full-history cache. Called on populate
 * and on every cache hit so the cache lives as long as it's being used, then is
 * nulled once idle for HISTORICAL_FULL_CACHE_IDLE_MS. The timer is unref'd so it
 * never keeps the process (or a test runner) alive. Guards on typeof so the
 * module stays safe in environments without timers.
 */
function scheduleHistoricalFullEviction() {
  if (typeof setTimeout !== "function") return;
  if (historicalEcbFullEvictTimer && typeof clearTimeout === "function") {
    clearTimeout(historicalEcbFullEvictTimer);
  }
  historicalEcbFullEvictTimer = setTimeout(() => {
    historicalEcbFullCache = null;
    historicalEcbFullEvictTimer = null;
  }, HISTORICAL_FULL_CACHE_IDLE_MS);
  if (
    historicalEcbFullEvictTimer &&
    typeof historicalEcbFullEvictTimer.unref === "function"
  ) {
    historicalEcbFullEvictTimer.unref();
  }
}

// ─── Date helpers ─────────────────────────────────────────────────────────────

/**
 * Coerce whatever a caller has for a date into a 'YYYY-MM-DD' calendar day.
 *
 * Accepts the two shapes that actually reach it: a pg DATE/TIMESTAMPTZ value
 * (a `Date`) and an already-stringy day (`to_char` projections, request query
 * params). Anything else is stringified and matched against the leading
 * YYYY-MM-DD, so unparseable input yields `null` rather than throwing.
 *
 * @param {string|Date|null|undefined} dateValue
 * @returns {string|null} 'YYYY-MM-DD', or null when the input is empty/unparseable
 */
export function normalizeDateInput(dateValue) {
  if (!dateValue) return null;
  // pg returns DATE columns as a local-midnight JS Date, whose String() form is
  // "Sun Jun 01 2025 …" — the regex below never matched it, so historical-FX
  // conversion silently fell back to today's rate at every DB-row call site.
  // Recover the local calendar day (mirrors services/calculations/portfolioMath.js).
  if (dateValue instanceof Date) {
    if (isNaN(dateValue.getTime())) return null;
    return formatDateToYmd(dateValue);
  }
  const str = String(dateValue);
  const m = str.match(/^\d{4}-\d{2}-\d{2}/);
  return m ? m[0] : null;
}

// ─── XML parsing ──────────────────────────────────────────────────────────────

/**
 * Parse ECB daily/historical XML into a { EUR: 1, USD: x, ... } rates map.
 * ECB publishes EUR->X rates; we store X->EUR (1 / eurToX).
 * Handles both single-quoted and double-quoted attributes.
 *
 * @param {string} xmlText
 * @returns {RateTable|null} null when the document contained no usable rates
 */
function parseEcbXml(xmlText) {
  /** @type {RateTable} */
  const rates = { EUR: 1.0 };
  const q = `['"]`;
  const currencyPattern = new RegExp(
    `<Cube\\s+currency=${q}([A-Z]{3})${q}\\s+rate=${q}([0-9.]+)${q}\\s*\\/>`,
    "g",
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

/**
 * Split an ECB history document into per-day rate tables.
 *
 * @param {string} xmlText
 * @returns {RatesByDate}
 */
function parseEcbHistoricalXml(xmlText) {
  /** @type {RatesByDate} */
  const byDate = new Map();
  const dayBlocks =
    xmlText.match(
      /<Cube\s+time=['"][0-9]{4}-[0-9]{2}-[0-9]{2}['"][\s\S]*?<\/Cube>/g,
    ) || [];
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
 *
 * @returns {Promise<RateTable|null>}
 */
export async function fetchFromEcb() {
  try {
    const response = await fetch(ECB_LATEST_URL, {
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) {
      logger.error(`ECB API returned ${response.status}`);
      return null;
    }
    const xmlText = await response.text();
    const rates = parseEcbXml(xmlText);
    if (rates) {
      logger.debug(
        `Fetched ${Object.keys(rates).length - 1} exchange rates from ECB`,
      );
    }
    return rates;
  } catch (err) {
    logger.error("Failed to fetch exchange rates from ECB", {
      error: err.message,
    });
    return null;
  }
}

/**
 * Fetch the latest rates from open.er-api.com (supplementary source).
 * Returns a { EUR: 1, USD: x, ... } map (X->EUR), or null on failure.
 *
 * @returns {Promise<RateTable|null>}
 */
export async function fetchFromErApi() {
  try {
    const response = await fetch(ERAR_LATEST_URL, {
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) {
      logger.error(`open.er-api returned ${response.status}`);
      return null;
    }
    const data = await response.json();
    if (data.result !== "success" || !data.rates) {
      logger.error("Unexpected response from open.er-api", {
        result: data.result,
      });
      return null;
    }
    /** @type {RateTable} */
    const rates = { EUR: 1.0 };
    for (const [currency, eurToX] of Object.entries(data.rates)) {
      if (
        currency !== "EUR" &&
        Number.isFinite(eurToX) &&
        eurToX > 0.0001 &&
        eurToX < 100000
      ) {
        rates[currency] = 1.0 / eurToX;
      }
    }
    logger.debug(
      `Fetched ${Object.keys(rates).length - 1} exchange rates from open.er-api`,
    );
    return rates;
  } catch (err) {
    logger.error("Failed to fetch exchange rates from open.er-api", {
      error: err.message,
    });
    return null;
  }
}

/**
 * The last ~90 days of ECB reference rates, memoised for CACHE_LIFETIME_MS.
 *
 * @returns {Promise<RatesByDate>} empty map when the feed is unreachable
 */
 async function fetchHistoricalFromEcb90d() {
  if (
    historicalEcb90dCache &&
    Date.now() - historicalEcb90dCache.timestamp < CACHE_LIFETIME_MS
  ) {
    return historicalEcb90dCache.byDate;
  }
  try {
    const response = await fetch(ECB_HISTORY_90D_URL, {
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) return new Map();
    const xmlText = await response.text();
    const byDate = parseEcbHistoricalXml(xmlText);
    historicalEcb90dCache = { byDate, timestamp: Date.now() };
    return byDate;
  } catch {
    return new Map();
  }
}

/**
 * The full ECB reference-rate history (daily, back to 1999), memoised for
 * CACHE_LIFETIME_MS and idle-evicted by {@link scheduleHistoricalFullEviction}.
 *
 * @returns {Promise<RatesByDate>} empty map when the feed is unreachable
 */
export async function fetchHistoricalFromEcbFull() {
  if (
    historicalEcbFullCache &&
    Date.now() - historicalEcbFullCache.timestamp < CACHE_LIFETIME_MS
  ) {
    scheduleHistoricalFullEviction(); // touch: keep a live cache from being evicted
    return historicalEcbFullCache.byDate;
  }
  try {
    const response = await fetch(ECB_HISTORY_FULL_URL, {
      signal: AbortSignal.timeout(30000),
    });
    if (!response.ok) return new Map();
    const xmlText = await response.text();
    const byDate = parseEcbHistoricalXml(xmlText);
    if (byDate.size > 0) {
      historicalEcbFullCache = { byDate, timestamp: Date.now() };
      scheduleHistoricalFullEviction();
      logger.info(`Fetched full ECB rate history: ${byDate.size} days`);
    }
    return byDate;
  } catch (err) {
    logger.warn("Failed to fetch full ECB rate history", {
      error: err.message,
    });
    return new Map();
  }
}

export function clearHistoricalCache() {
  historicalEcb90dCache = null;
  historicalEcbFullCache = null;
  if (historicalEcbFullEvictTimer && typeof clearTimeout === "function") {
    clearTimeout(historicalEcbFullEvictTimer);
  }
  historicalEcbFullEvictTimer = null;
}

/**
 * Resolve a rate from an ECB by-date map using the standard FX convention for
 * non-business days: the most recent published rate ON or BEFORE the date,
 * looking back at most `maxLookbackDays`.
 *
 * @param {Map<string, Record<string, number>>} byDate
 * @param {string} currencyCode
 * @param {string} dateStr YYYY-MM-DD
 * @param {number} [maxLookbackDays]
 * @returns {number|undefined}
 */
export function rateOnOrBeforeFromMap(
  byDate,
  currencyCode,
  dateStr,
  maxLookbackDays = 7,
) {
  if (!byDate || byDate.size === 0) return undefined;
  const [y, m, d] = dateStr.split("-").map(Number);
  let ts = Date.UTC(y, m - 1, d);
  for (let back = 0; back <= maxLookbackDays; back += 1) {
    const day = epochMsToUtcYmd(ts);
    const rates = byDate.get(day);
    if (rates && rates[currencyCode] !== undefined) return rates[currencyCode];
    ts -= 86_400_000;
  }
  return undefined;
}

// ─── Database ─────────────────────────────────────────────────────────────────

/**
 * Load the stored latest rates from the database.
 * Returns null if no rows exist.
 *
 * @returns {Promise<RateTable|null>} null when nothing is stored or the query failed
 */
export async function loadFromDatabase() {
  try {
    const result = await query(
      `SELECT currency_code, rate_to_eur FROM exchange_rates WHERE is_latest = true`,
    );
    if (result.rows.length === 0) return null;

    /** @type {RateTable} */
    const rates = { EUR: 1.0 };
    for (const row of /** @type {Pick<ExchangeRateRow, 'currency_code'|'rate_to_eur'>[]} */ (
      result.rows
    )) {
      rates[row.currency_code] = toNumber(toDecimal(row.rate_to_eur));
    }
    logger.debug(`Loaded ${result.rows.length} exchange rates from database`);
    return rates;
  } catch (err) {
    logger.error("Failed to load exchange rates from database", {
      error: err.message,
    });
    return null;
  }
}

/**
 * Replace stored rates with the freshly-fetched set.
 * Single transaction: clear latest markers, then upsert new rates.
 *
 * @param {RateTable} rates
 * @returns {Promise<void>}
 */
export async function saveToDatabase(rates) {
  try {
    // rate_date is compared against APP_TIMEZONE calendar days throughout the
    // calc layer (historical lookups, snapshot day-walk) — stamp in the same zone.
    const today = todayAppDateString();
    const entries = Object.entries(rates).filter(([c]) => c !== "EUR");
    if (entries.length === 0) return;

    await withTransaction(async (client) => {
      await client.query(
        `UPDATE exchange_rates
         SET is_latest = false, updated_at = NOW()
         WHERE currency_code = ANY($1::text[]) AND is_latest = true`,
        [entries.map(([currency]) => currency)],
      );

      for (const [currency, rate] of entries) {
        await client.query(
          `INSERT INTO exchange_rates (currency_code, rate_to_eur, rate_date, is_latest)
           VALUES ($1, $2, $3, true)
           ON CONFLICT (currency_code, rate_date)
           DO UPDATE SET
             rate_to_eur = EXCLUDED.rate_to_eur,
             is_latest = true,
             fetched_at = NOW(),
             updated_at = NOW()`,
          [currency, rate, today],
        );
      }
    });
    logger.debug(
      `Saved ${Object.keys(rates).length - 1} latest exchange rates to database`,
    );
  } catch (err) {
    logger.error("Failed to save exchange rates to database", {
      error: err.message,
    });
  }
}

/**
 * Upsert one historical (non-latest) rate row.
 *
 * @param {string} currencyCode
 * @param {string} dateStr 'YYYY-MM-DD'
 * @param {number} rateToEur
 * @returns {Promise<void>}
 */
export async function saveHistoricalRate(currencyCode, dateStr, rateToEur) {
  await query(
    `INSERT INTO exchange_rates (currency_code, rate_to_eur, rate_date, is_latest)
     VALUES ($1, $2, $3, false)
     ON CONFLICT (currency_code, rate_date)
     DO UPDATE SET
       rate_to_eur = EXCLUDED.rate_to_eur,
       updated_at = NOW()`,
    [currencyCode, rateToEur, dateStr],
  );
}

/**
 * Resolve many previously-unindexed currency/date pairs from ECB feeds.
 *
 * The caller has already proved that these currencies have no stored history,
 * so doing an exact and nearest database lookup for every date cannot produce
 * a result. Both ECB feeds are loaded at most once, all dates are resolved in
 * memory, and successful points are persisted with one set-based statement.
 *
 * @param {Map<string, string[]>} datesByCurrency normalized currency → YYYY-MM-DD dates
 * @param {{ saveFetchedHistoricalRates?: boolean }} [options]
 * @returns {Promise<Map<string, number>>} `${currency}:${date}` → rate
 */
export async function getUnindexedRatesToEurForDates(
  datesByCurrency,
  { saveFetchedHistoricalRates = true } = {},
) {
  const pairs = [];
  for (const [rawCurrency, rawDates] of datesByCurrency || []) {
    const currency = String(rawCurrency || "")
      .toUpperCase()
      .trim();
    if (!currency || currency === "EUR") continue;
    for (const rawDate of new Set(rawDates || [])) {
      const date = normalizeDateInput(rawDate);
      if (date) pairs.push({ currency, date });
    }
  }
  if (pairs.length === 0) return new Map();

  const resolved = new Map();
  const recentByDate = await fetchHistoricalFromEcb90d();
  const unresolved = [];
  for (const pair of pairs) {
    const rate = rateOnOrBeforeFromMap(recentByDate, pair.currency, pair.date);
    if (rate === undefined) unresolved.push(pair);
    else resolved.set(`${pair.currency}:${pair.date}`, rate);
  }

  if (unresolved.length > 0) {
    const fullByDate = await fetchHistoricalFromEcbFull();
    for (const pair of unresolved) {
      const rate = rateOnOrBeforeFromMap(fullByDate, pair.currency, pair.date);
      if (rate !== undefined)
        resolved.set(`${pair.currency}:${pair.date}`, rate);
    }
  }

  if (saveFetchedHistoricalRates && resolved.size > 0) {
    const currencies = [];
    const dates = [];
    const rates = [];
    for (const [key, rate] of resolved) {
      const separator = key.indexOf(":");
      currencies.push(key.slice(0, separator));
      dates.push(key.slice(separator + 1));
      rates.push(rate);
    }
    await query(
      `INSERT INTO exchange_rates (currency_code, rate_to_eur, rate_date, is_latest)
       SELECT currency_code, rate_to_eur, rate_date::date, false
       FROM UNNEST($1::text[], $2::numeric[], $3::text[])
         AS fetched(currency_code, rate_to_eur, rate_date)
       ON CONFLICT (currency_code, rate_date)
       DO UPDATE SET
         rate_to_eur = EXCLUDED.rate_to_eur,
         updated_at = NOW()`,
      [currencies, rates, dates],
    );
  }

  return resolved;
}

/**
 * Nearest stored rate for a currency at ANY distance from the date — the last
 * resort of {@link getRateToEurForDate}.
 *
 * @param {string} currencyCode
 * @param {string} dateStr 'YYYY-MM-DD'
 * @returns {Promise<number|undefined>} undefined when nothing is stored for the currency
 */
 async function getNearestRateFromDatabase(currencyCode, dateStr) {
  const result = await query(
    `SELECT rate_to_eur
     FROM exchange_rates
     WHERE currency_code = $1
     ORDER BY ABS(rate_date - $2::date) ASC, rate_date DESC
     LIMIT 1`,
    [currencyCode, dateStr],
  );
  if (result.rows.length === 0) return undefined;
  return toNumber(toDecimal(result.rows[0].rate_to_eur));
}

/**
 * DB-only lookup of the most recent stored rate ON or BEFORE a date, looking
 * back at most `maxLookbackDays`. Cheap and offline-safe — used on transaction
 * write paths to stamp `fx_rate_to_eur` without ever blocking on HTTP.
 *
 * @param {string} currencyCode
 * @param {string|Date} dateValue
 * @param {number} [maxLookbackDays]
 * @returns {Promise<number|undefined>}
 */
export async function getStoredRateToEurOnOrBefore(
  currencyCode,
  dateValue,
  maxLookbackDays = 7,
) {
  const code = String(currencyCode || "")
    .toUpperCase()
    .trim();
  if (!code) return undefined;
  if (code === "EUR") return 1.0;
  const dateStr = normalizeDateInput(dateValue);
  if (!dateStr) return undefined;
  const result = await query(
    `SELECT rate_to_eur
     FROM exchange_rates
     WHERE currency_code = $1
       AND rate_date <= $2::date
       AND rate_date >= $2::date - make_interval(days => $3)
     ORDER BY rate_date DESC
     LIMIT 1`,
    [code, dateStr, maxLookbackDays],
  );
  if (result.rows.length === 0) return undefined;
  return toNumber(toDecimal(result.rows[0].rate_to_eur));
}

// ─── Historical rate index (in-memory binary search) ─────────────────────────

/**
 * Group stored `exchange_rates` rows into a per-currency, date-ascending index
 * for binary search.
 *
 * `rate_date` is typed loosely on purpose: both call sites (`getHistoricalRateIndex`
 * and `loadHistoricalRateIndex` in portfolioSummaryService) now project
 * `to_char(rate_date, 'YYYY-MM-DD')` (a wire string) rather than the raw DATE
 * column, avoiding the local-midnight `Date` → UTC-extraction day-shift that a
 * naive read of that column would reintroduce. `normalizeDateInput` still
 * accepts a `Date` too, so a future caller that selects the raw column stays
 * correct rather than silently wrong.
 *
 * @param {Array<Pick<ExchangeRateRow, 'currency_code'|'rate_to_eur'> & { rate_date: Date|string }>} rows
 * @returns {HistoricalRateIndex}
 */
export function buildHistoricalRateIndex(rows) {
  /** @type {HistoricalRateIndex} */
  const byCurrency = new Map();
  for (const row of rows) {
    const currency = String(row.currency_code || "")
      .toUpperCase()
      .trim();
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

/**
 * Shared skeleton for the index searchers: EUR shortcut, then binary search
 * of the per-currency date-sorted entries. On an exact date hit the rate is
 * returned directly; otherwise `resolve(prev, next)` — called with the
 * nearest entry on each side (null when absent) — decides the boundary
 * semantics (nearest vs on-or-before).
 *
 * @param {Map<string, {date: string, rate: number}[]>} index
 * @param {string} currencyCode
 * @param {string} dateStr
 * @param {(prev: {date: string, rate: number} | null, next: {date: string, rate: number} | null) => number | undefined} resolve
 * @returns {number | undefined}
 */
function searchRateIndex(index, currencyCode, dateStr, resolve) {
  if (currencyCode === "EUR") return 1.0;
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

  return resolve(
    hi >= 0 ? entries[hi] : null,
    lo < entries.length ? entries[lo] : null,
  );
}

/**
 * Rate for a currency at the date, or the closest published date on EITHER
 * side when the exact day is absent.
 *
 * @param {HistoricalRateIndex} index
 * @param {string} currencyCode
 * @param {string} dateStr 'YYYY-MM-DD'
 * @returns {number|undefined}
 */
export function findNearestRateInIndex(index, currencyCode, dateStr) {
  return searchRateIndex(index, currencyCode, dateStr, (prev, next) => {
    if (!prev) return next?.rate;
    if (!next) return prev.rate;

    const prevDist = Math.abs(
      new Date(prev.date).getTime() - new Date(dateStr).getTime(),
    );
    const nextDist = Math.abs(
      new Date(next.date).getTime() - new Date(dateStr).getTime(),
    );
    return prevDist <= nextDist ? prev.rate : next.rate;
  });
}

/**
 * Like {@link findNearestRateInIndex} but strictly ON-or-BEFORE the date —
 * the standard FX convention (a Saturday uses Friday's close, never Monday's).
 * Returns undefined when no rate exists on or before the date.
 *
 * @param {HistoricalRateIndex} index
 * @param {string} currencyCode
 * @param {string} dateStr 'YYYY-MM-DD'
 * @returns {number|undefined}
 */
export function findRateOnOrBeforeInIndex(index, currencyCode, dateStr) {
  return searchRateIndex(index, currencyCode, dateStr, (prev) =>
    prev ? prev.rate : undefined,
  );
}

// ─── Historical rate point lookup ─────────────────────────────────────────────

/**
 * Point lookup of a currency's rate on a specific day, walking the tiers:
 * exact stored row → 90-day ECB feed → full ECB history → nearest stored row.
 *
 * @param {string} currencyCode
 * @param {string|Date|null|undefined} dateValue
 * @param {{ saveFetchedHistoricalRate?: boolean }} [options] persist rates sourced from ECB (default true)
 * @returns {Promise<number|undefined>} undefined when the date is unparseable or nothing resolves
 */
export async function getRateToEurForDate(
  currencyCode,
  dateValue,
  { saveFetchedHistoricalRate = true } = {},
) {
  if (!currencyCode || currencyCode === "EUR") return 1.0;
  const dateStr = normalizeDateInput(dateValue);
  if (!dateStr) return undefined;

  const exact = await query(
    `SELECT rate_to_eur
     FROM exchange_rates
     WHERE currency_code = $1 AND rate_date = $2::date
     LIMIT 1`,
    [currencyCode, dateStr],
  );
  if (exact.rows.length > 0) {
    return toNumber(toDecimal(exact.rows[0].rate_to_eur));
  }

  // Recent dates: 90-day ECB feed (small download), on-or-before for weekends.
  const ecbByDate = await fetchHistoricalFromEcb90d();
  const recentRate = rateOnOrBeforeFromMap(ecbByDate, currencyCode, dateStr);
  if (recentRate !== undefined) {
    if (saveFetchedHistoricalRate) {
      await saveHistoricalRate(currencyCode, dateStr, recentRate);
    }
    return recentRate;
  }

  // Older dates: full ECB history (back to 1999). Cached for 24h, and every
  // resolved rate is persisted, so the big download happens at most rarely.
  const fullByDate = await fetchHistoricalFromEcbFull();
  const historicalRate = rateOnOrBeforeFromMap(
    fullByDate,
    currencyCode,
    dateStr,
  );
  if (historicalRate !== undefined) {
    if (saveFetchedHistoricalRate) {
      await saveHistoricalRate(currencyCode, dateStr, historicalRate);
    }
    return historicalRate;
  }

  // Last resort (e.g. non-ECB currencies): nearest stored rate, any distance.
  return getNearestRateFromDatabase(currencyCode, dateStr);
}

export { HISTORICAL_FULL_CACHE_IDLE_MS as __HISTORICAL_FULL_CACHE_IDLE_MS, fetchHistoricalFromEcb90d as __fetchHistoricalFromEcb90d, getNearestRateFromDatabase as __getNearestRateFromDatabase };
