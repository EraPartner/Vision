/**
 * Quote Backfill Service
 *
 * Manages the lifecycle of daily close quotes in asset_price_history.
 * Computes holding windows from transactions and backfills quotes only
 * for periods where a position was actually held (units > 0).
 *
 * Provides:
 * - Startup full backfill
 * - Hourly lightweight refresh (open positions only)
 * - Transaction-triggered per-investment refresh
 * - Stale quote cleanup (outside holding windows)
 * - Provider-agnostic spike sanitization before persistence
 */

import { logger } from '../config/logger.js';
import { query } from '../database/connection.js';
import { getDayKeyUtc } from '../repositories/infoRepositoryHelpers.js';
import { madReturnStats, isRobustNeedle } from '../lib/math.js';
import { forEachConcurrent } from '../lib/concurrency.js';
import {
  fetchHistoricalPrices,
  saveHistoricalPointsToDatabase,
} from './priceProviderService.js';

/**
 * Provider-config subset of `InvestmentRow` (types/rows.js) this module reads
 * off `HOLDING_WINDOW_SELECT` — a bespoke projection, not `SELECT i.*`, so it
 * only lists the columns actually selected there. Matches
 * `fetchHistoricalPrices`'s own `investment` param shape (priceProviderService.js).
 * @typedef {object} HoldingWindowInvestment
 * @property {number} id
 * @property {string} asset_class
 * @property {string} currency
 * @property {string} price_provider
 * @property {string|null} price_provider_id
 * @property {string|null} symbol
 * @property {string|null} price_provider_url
 * @property {string|null} price_provider_latest_url
 * @property {string|null} price_provider_latest_path
 * @property {string|null} price_provider_history_url
 * @property {string|null} price_provider_history_path
 * @property {string|null} price_provider_history_ts_path
 * @property {string|null} price_provider_history_price_path
 */

/**
 * One buy/gift/sell leg, as `HOLDING_WINDOW_SELECT` projects it for
 * `computeHoldingWindows`.
 * @typedef {object} HoldingWindowTx
 * @property {number} id
 * @property {string} type `portfolio_txn_type` enum, filtered to 'buy'|'gift'|'sell'.
 * @property {string} date 'YYYY-MM-DD' — `to_char`-formatted in the query.
 * @property {number} units
 */

/**
 * A raw `HOLDING_WINDOW_SELECT` row: `HoldingWindowInvestment`'s columns
 * (unconverted — pg-raw) plus the `tx_*`-prefixed transaction columns.
 * @typedef {object} HoldingWindowRow
 * @property {number} id
 * @property {string} asset_class
 * @property {string} currency
 * @property {string} price_provider
 * @property {string|null} price_provider_id
 * @property {string|null} symbol
 * @property {string|null} price_provider_url
 * @property {string|null} price_provider_latest_url
 * @property {string|null} price_provider_latest_path
 * @property {string|null} price_provider_history_url
 * @property {string|null} price_provider_history_path
 * @property {string|null} price_provider_history_ts_path
 * @property {string|null} price_provider_history_price_path
 * @property {number} tx_id
 * @property {string} tx_type
 * @property {string} tx_date 'YYYY-MM-DD'
 * @property {string} tx_units NUMERIC — coerced with `Number()` by `mapRowToHoldingTx`.
 */

/**
 * A holding window: a continuous period where net units > 0.
 * @typedef {{ fromDate: string, toDate: string|null }} HoldingWindow
 */

// ─── Constants ──────────────────────────────────────────────────────────────

const SPIKE_RATIO_THRESHOLD = 3; // 3× single-day jump = spike
const HISTORY_DAY_MS = 24 * 60 * 60 * 1000;
const HOURLY_LOOKBACK_DAYS = 7;
const BACKFILL_CONCURRENCY = 4;
// A stored daily series within a holding window should have no consecutive-date gap larger
// than this. Weekend (Fri→Mon = 3d) and multi-day market holidays stay under it; a biweekly
// (~14d) sparse series trips it. Tuned above realistic holiday closures to avoid re-fetching
// already-dense or genuinely-low-cadence (e.g. weekly) series every day.
const GAP_THRESHOLD_DAYS = 9;

// ─── Pure Functions ─────────────────────────────────────────────────────────

/**
 * Compute holding windows from an array of transactions for a single investment.
 * A holding window is a continuous period where net units > 0.
 *
 * @param {Array<{ id: number, type: string, date: string, units: number }>} transactions
 *   Transactions for ONE investment. Will be sorted internally.
 * @returns {Array<{ fromDate: string, toDate: string | null }>}
 *   Holding windows. toDate = null means position is still open.
 */
export function computeHoldingWindows(transactions) {
  if (!Array.isArray(transactions) || transactions.length === 0) return [];

  const sorted = [...transactions].sort((a, b) => {
    const dateCompare = String(a.date).localeCompare(String(b.date));
    if (dateCompare !== 0) return dateCompare;
    return Number(a.id) - Number(b.id);
  });

  const windows = [];
  let balance = 0;
  let windowStart = null;

  for (const tx of sorted) {
    const units = Number(tx.units) || 0;
    const prevBalance = balance;

    if (tx.type === 'buy' || tx.type === 'gift') {
      balance += units;
    } else if (tx.type === 'sell') {
      balance -= units;
    }

    // Clamp to zero to handle floating point drift
    if (balance < 0) balance = 0;

    if (prevBalance <= 0 && balance > 0) {
      windowStart = String(tx.date).slice(0, 10);
    }

    if (prevBalance > 0 && balance <= 0 && windowStart !== null) {
      windows.push({ fromDate: windowStart, toDate: String(tx.date).slice(0, 10) });
      windowStart = null;
    }
  }

  // Still holding — open window
  if (balance > 0 && windowStart !== null) {
    windows.push({ fromDate: windowStart, toDate: null });
  }

  return windows;
}

/**
 * Detect and replace isolated single-day price spikes.
 * Provider-agnostic — works on any array of { timestampMs, price } points.
 *
 * A spike is detected when:
 * 1. price[i] / price[i-1] > SPIKE_RATIO_THRESHOLD AND price[i] / price[i+1] > SPIKE_RATIO_THRESHOLD (or inverse)
 * 2. Statistical outlier via MAD-based sigma (second pass for subtler spikes)
 *
 * Spikes are replaced with the geometric mean of their neighbors.
 *
 * @param {Array<{ timestampMs: number, price: number }>} points - Sorted price points
 * @returns {Array<{ timestampMs: number, price: number }>} - Cleaned copy (immutable)
 */
export function sanitizeIsolatedSpikes(points) {
  if (!Array.isArray(points) || points.length < 3) return points ? [...points] : [];

  const sanitized = points.map((p) => ({ ...p }));

  // Pass 1: Simple ratio-based detection for obvious spikes (e.g. 10× jumps)
  for (let i = 1; i < sanitized.length - 1; i += 1) {
    const prev = sanitized[i - 1]?.price;
    const current = sanitized[i]?.price;
    const next = sanitized[i + 1]?.price;

    if (!_isPositive(prev) || !_isPositive(current) || !_isPositive(next)) continue;

    const jumpUp = current / prev;
    const jumpDown = current / next;
    const dropUp = prev / current;
    const dropDown = next / current;

    const isSpikeUp = jumpUp >= SPIKE_RATIO_THRESHOLD && jumpDown >= SPIKE_RATIO_THRESHOLD;
    const isSpikeDn = dropUp >= SPIKE_RATIO_THRESHOLD && dropDown >= SPIKE_RATIO_THRESHOLD;

    if (isSpikeUp || isSpikeDn) {
      sanitized[i] = { ...sanitized[i], price: Math.sqrt(prev * next) };
    }
  }

  // Pass 2: Statistical MAD-based detection for subtler spikes
  if (sanitized.length < 5) return sanitized;

  const logReturns = [];
  for (let i = 1; i < sanitized.length; i += 1) {
    const prev = sanitized[i - 1]?.price;
    const current = sanitized[i]?.price;
    if (!_isPositive(prev) || !_isPositive(current)) continue;
    logReturns.push(Math.log(current / prev));
  }

  if (logReturns.length < 4) return sanitized;

  const stats = madReturnStats(logReturns);

  for (let i = 1; i < sanitized.length - 1; i += 1) {
    const prev = sanitized[i - 1]?.price;
    const current = sanitized[i]?.price;
    const next = sanitized[i + 1]?.price;
    if (!_isPositive(prev) || !_isPositive(current) || !_isPositive(next)) continue;

    if (isRobustNeedle(prev, current, next, stats)) {
      sanitized[i] = { ...sanitized[i], price: Math.sqrt(prev * next) };
    }
  }

  return sanitized;
}

// ─── Database Functions ─────────────────────────────────────────────────────

// Shared projection for the "investment + its buy/gift/sell legs" join. Both the
// all-investments and single-investment loaders select the identical columns and
// only differ in their WHERE/ORDER BY, so keep the column list + asset-class
// filter in one place (was duplicated verbatim across the two queries).
const HOLDING_WINDOW_SELECT = `
  SELECT
    i.id,
    i.asset_class,
    i.currency,
    i.price_provider,
    i.price_provider_id,
    i.symbol,
    i.price_provider_url,
    i.price_provider_latest_url,
    i.price_provider_latest_path,
    i.price_provider_history_url,
    i.price_provider_history_path,
    i.price_provider_history_ts_path,
    i.price_provider_history_price_path,
    pt.id   AS tx_id,
    pt.type AS tx_type,
    to_char(pt.date::date, 'YYYY-MM-DD') AS tx_date,
    COALESCE(pt.units, 0) AS tx_units
  FROM investments i
  JOIN portfolio_transactions pt
    ON pt.investment_id = i.id
   AND pt.type IN ('buy', 'gift', 'sell')`;

// Priceable asset classes — the only ones with a provider quote series to backfill.
const HOLDING_ASSET_CLASS_FILTER = `i.asset_class IN ('stock', 'etf', 'crypto', 'metals')`;

/**
 * Map a HOLDING_WINDOW_SELECT row's investment columns to the provider-config object.
 * @param {HoldingWindowRow} row
 * @returns {HoldingWindowInvestment}
 */
function mapRowToInvestment(row) {
  return {
    id: Number(row.id),
    asset_class: row.asset_class,
    currency: row.currency,
    price_provider: row.price_provider,
    price_provider_id: row.price_provider_id,
    symbol: row.symbol,
    price_provider_url: row.price_provider_url,
    price_provider_latest_url: row.price_provider_latest_url,
    price_provider_latest_path: row.price_provider_latest_path,
    price_provider_history_url: row.price_provider_history_url,
    price_provider_history_path: row.price_provider_history_path,
    price_provider_history_ts_path: row.price_provider_history_ts_path,
    price_provider_history_price_path: row.price_provider_history_price_path,
  };
}

/**
 * Map a HOLDING_WINDOW_SELECT row's transaction columns to a holding-window tx.
 * @param {HoldingWindowRow} row
 * @returns {HoldingWindowTx}
 */
function mapRowToHoldingTx(row) {
  return {
    id: Number(row.tx_id),
    type: row.tx_type,
    date: row.tx_date,
    units: Number(row.tx_units),
  };
}

/**
 * Fetch all unit-based investments with their buy/gift/sell transactions,
 * compute holding windows, and return a structured map.
 *
 * Includes ALL investments with transactions, regardless of is_active flag.
 *
 * @returns {Promise<Map<number, { investment: HoldingWindowInvestment, holdingWindows: HoldingWindow[] }>>}
 */
export async function getInvestmentsWithHoldingWindows() {
  const result = await query(
    `${HOLDING_WINDOW_SELECT}
     WHERE ${HOLDING_ASSET_CLASS_FILTER}
     ORDER BY i.id, pt.date, pt.id`,
    []
  );

  /** @type {HoldingWindowRow[]} */
  const rows = result.rows || [];
  /** @type {Map<number, { investment: HoldingWindowInvestment, transactions: HoldingWindowTx[] }>} */
  const investmentMap = new Map();

  for (const row of rows) {
    const invId = Number(row.id);

    if (!investmentMap.has(invId)) {
      investmentMap.set(invId, {
        investment: mapRowToInvestment(row),
        transactions: [],
      });
    }

    investmentMap.get(invId).transactions.push(mapRowToHoldingTx(row));
  }

  // Compute holding windows per investment
  /** @type {Map<number, { investment: HoldingWindowInvestment, holdingWindows: HoldingWindow[] }>} */
  const resultMap = new Map();
  for (const [invId, { investment, transactions }] of investmentMap) {
    const holdingWindows = computeHoldingWindows(transactions);
    if (holdingWindows.length > 0) {
      resultMap.set(invId, { investment, holdingWindows });
    }
  }

  return resultMap;
}

/**
 * Fetch holding windows for a single investment by ID.
 *
 * @param {number} investmentId
 * @returns {Promise<{ investment: HoldingWindowInvestment, holdingWindows: HoldingWindow[] } | null>}
 */
async function getInvestmentWithHoldingWindows(investmentId) {
  const result = await query(
    `${HOLDING_WINDOW_SELECT}
     WHERE i.id = $1
       AND ${HOLDING_ASSET_CLASS_FILTER}
     ORDER BY pt.date, pt.id`,
    [Number(investmentId)]
  );

  /** @type {HoldingWindowRow[]} */
  const rows = result.rows || [];
  if (rows.length === 0) return null;

  const investment = mapRowToInvestment(rows[0]);
  const transactions = rows.map(mapRowToHoldingTx);

  const holdingWindows = computeHoldingWindows(transactions);
  if (holdingWindows.length === 0) return null;

  return { investment, holdingWindows };
}

/**
 * Load the sorted set of dates (YYYY-MM-DD) that already have a stored price row.
 *
 * @param {number} investmentId
 * @returns {Promise<string[]>}
 */
async function getStoredPriceDates(investmentId) {
  const result = await query(
    `SELECT to_char(price_date, 'YYYY-MM-DD') AS d
       FROM asset_price_history
      WHERE investment_id = $1
      ORDER BY price_date`,
    [Number(investmentId)]
  );
  return (result.rows || []).map((/** @type {{ d: string }} */ row) => row.d);
}

/**
 * @param {string} aYmd 'YYYY-MM-DD'
 * @param {string} bYmd 'YYYY-MM-DD'
 * @returns {number}
 */
function _daysBetween(aYmd, bYmd) {
  const a = Date.parse(`${aYmd}T00:00:00.000Z`);
  const b = Date.parse(`${bYmd}T00:00:00.000Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  return Math.round((b - a) / HISTORY_DAY_MS);
}

/**
 * Decide whether any holding window has an interior (or edge) date gap large enough to warrant
 * a forced provider re-fetch. Pure — easy to unit-test.
 *
 * For each window we walk [windowStart, ...storedDatesInWindow, windowEnd] and look for any
 * consecutive pair more than thresholdDays apart. An empty window (no stored rows) trips on the
 * full-span gap. Open windows use todayUtc as their end.
 *
 * @param {Array<{ fromDate: string, toDate: string | null }>} holdingWindows
 * @param {string[]} storedDates - sorted YYYY-MM-DD dates already in asset_price_history
 * @param {{ thresholdDays?: number, todayUtc?: string }} [opts]
 * @returns {boolean}
 */
export function holdingWindowsNeedBackfill(holdingWindows, storedDates, { thresholdDays = GAP_THRESHOLD_DAYS, todayUtc } = {}) {
  if (!Array.isArray(holdingWindows) || holdingWindows.length === 0) return false;
  const today = todayUtc || getDayKeyUtc(new Date());
  const sortedStored = Array.isArray(storedDates) ? [...storedDates].sort() : [];

  for (const window of holdingWindows) {
    const fromDate = window?.fromDate;
    const toDate = window?.toDate !== null && window?.toDate !== undefined ? window.toDate : today;
    if (!fromDate || !toDate || fromDate > toDate) continue;

    const inWindow = sortedStored.filter((d) => d >= fromDate && d <= toDate);
    const boundaries = [fromDate, ...inWindow, toDate];
    for (let i = 1; i < boundaries.length; i += 1) {
      if (_daysBetween(boundaries[i - 1], boundaries[i]) > thresholdDays) return true;
    }
  }

  return false;
}

// ─── Backfill Orchestration ─────────────────────────────────────────────────

/**
 * Backfill quotes for a single investment across all its holding windows.
 * Fetches historical prices, sanitizes spikes, and persists cleaned data.
 *
 * @param {HoldingWindowInvestment} investment - Investment object with provider config
 * @param {HoldingWindow[]} holdingWindows
 * @param {{ force?: boolean }} [opts] - force re-queries the provider even when the stored
 *   series already spans the window endpoints (needed to repopulate interior gaps).
 * @returns {Promise<{ hasHistory: boolean, windowCount: number }>}
 */
async function backfillInvestmentQuotes(investment, holdingWindows, { force = false } = {}) {
  let hasHistory = false;

  for (const window of holdingWindows) {
    const fromMs = Date.parse(`${window.fromDate}T00:00:00.000Z`);
    const toMs = window.toDate !== null
      ? Date.parse(`${window.toDate}T23:59:59.999Z`)
      : Date.now();

    if (!Number.isFinite(fromMs)) continue;

    const rawPoints = await fetchHistoricalPrices(investment, { fromMs, toMs, force });

    if (rawPoints.length > 0) {
      hasHistory = true;
      const cleanPoints = sanitizeIsolatedSpikes(rawPoints);

      // Re-save cleaned points — upsert overwrites any bad values
      const provider = investment.price_provider || 'provider';
      await saveHistoricalPointsToDatabase(investment.id, cleanPoints, provider);
    }
  }

  return { hasHistory, windowCount: holdingWindows.length };
}

/**
 * Full backfill: fetch and store quotes for ALL investments with holding windows.
 * Runs on startup. Also cleans up stale quotes outside holding windows.
 *
 * @returns {Promise<{ processed: number, withHistory: number, failed: number }>}
 */
export async function backfillHistoricalAssetQuotes() {
  const investmentWindows = await getInvestmentsWithHoldingWindows();

  if (investmentWindows.size === 0) {
    logger.info('Historical asset quote backfill skipped: no investments with holding windows');
    return { processed: 0, withHistory: 0, failed: 0 };
  }

  let withHistory = 0;
  let failed = 0;

  await forEachConcurrent(
    [...investmentWindows.entries()],
    BACKFILL_CONCURRENCY,
    async ([invId, { investment, holdingWindows }]) => {
      try {
        const result = await backfillInvestmentQuotes(investment, holdingWindows);
        if (result.hasHistory) withHistory += 1;
      } catch (error) {
        failed += 1;
        logger.warn('Historical quote backfill failed for investment', {
          investmentId: invId,
          error: error?.message,
        });
      }
    }
  );

  // Cleanup stale quotes outside holding windows
  try {
    await cleanupStaleQuotes(investmentWindows);
  } catch (error) {
    logger.warn('Stale quote cleanup failed', { error: error?.message });
  }

  logger.info('Historical asset quote backfill complete', {
    processed: investmentWindows.size,
    withHistory,
    failed,
  });

  return {
    processed: investmentWindows.size,
    withHistory,
    failed,
  };
}

/**
 * Lightweight refresh for currently-open holding windows only.
 * Fetches recent quotes (last N days) to keep data fresh.
 * Designed to run on an hourly interval.
 *
 * @returns {Promise<{ refreshed: number, failed: number }>}
 */
export async function refreshActiveHoldingQuotes() {
  const investmentWindows = await getInvestmentsWithHoldingWindows();
  let refreshed = 0;
  let failed = 0;

  await forEachConcurrent(
    [...investmentWindows.entries()],
    BACKFILL_CONCURRENCY,
    async ([invId, { investment, holdingWindows }]) => {
      const openWindows = holdingWindows.filter((w) => w.toDate === null);
      if (openWindows.length === 0) return;

      try {
        const lookbackMs = Date.now() - HOURLY_LOOKBACK_DAYS * HISTORY_DAY_MS;
        for (const window of openWindows) {
          const fromMs = Math.max(
            Date.parse(`${window.fromDate}T00:00:00.000Z`),
            lookbackMs
          );

          const rawPoints = await fetchHistoricalPrices(investment, {
            fromMs,
            toMs: Date.now(),
          });

          if (rawPoints.length > 0) {
            const cleanPoints = sanitizeIsolatedSpikes(rawPoints);
            const provider = investment.price_provider || 'provider';
            await saveHistoricalPointsToDatabase(investment.id, cleanPoints, provider);
          }
        }
        refreshed += 1;
      } catch (error) {
        failed += 1;
        logger.warn('Periodic quote refresh failed for investment', {
          investmentId: invId,
          error: error?.message,
        });
      }
    }
  );

  logger.info('Periodic active quote refresh complete', { refreshed, failed });
  return { refreshed, failed };
}

/**
 * Gap-filling backfill: for each investment whose stored daily series has a hole larger than
 * GAP_THRESHOLD_DAYS inside a holding window, force a provider re-fetch to densify it.
 *
 * Unlike the hourly refresh (last 7 days, open positions only) this heals interior gaps across
 * the full history — including closed windows — and unlike the startup full backfill it is
 * idempotent and skips already-dense investments, so it is cheap to run on a daily schedule.
 *
 * @param {{ thresholdDays?: number }} [opts]
 * @returns {Promise<{ checked: number, needed: number, filled: number, failed: number }>}
 */
export async function backfillHoldingGaps({ thresholdDays = GAP_THRESHOLD_DAYS } = {}) {
  const investmentWindows = await getInvestmentsWithHoldingWindows();
  if (investmentWindows.size === 0) {
    return { checked: 0, needed: 0, filled: 0, failed: 0 };
  }

  const todayUtc = getDayKeyUtc(new Date());
  let checked = 0;
  let needed = 0;
  let filled = 0;
  let failed = 0;

  await forEachConcurrent(
    [...investmentWindows.entries()],
    BACKFILL_CONCURRENCY,
    async ([invId, { investment, holdingWindows }]) => {
      checked += 1;
      try {
        const storedDates = await getStoredPriceDates(invId);
        if (!holdingWindowsNeedBackfill(holdingWindows, storedDates, { thresholdDays, todayUtc })) {
          return;
        }

        needed += 1;
        const before = storedDates.length;
        await backfillInvestmentQuotes(investment, holdingWindows, { force: true });
        const after = (await getStoredPriceDates(invId)).length;
        if (after > before) filled += 1;
      } catch (error) {
        failed += 1;
        logger.warn('Holding-gap backfill failed for investment', {
          investmentId: invId,
          error: error?.message,
        });
      }
    }
  );

  logger.info('Holding-gap backfill complete', { checked, needed, filled, failed });
  return { checked, needed, filled, failed };
}

/**
 * Refresh quotes for a single investment after a transaction change.
 * Fire-and-forget — does not block the calling route.
 *
 * @param {number} investmentId
 * @returns {Promise<void>}
 */
export async function refreshQuotesForInvestment(investmentId) {
  const data = await getInvestmentWithHoldingWindows(investmentId);

  if (!data) {
    // No holding windows — clean up any existing quotes for this investment
    await query(
      'DELETE FROM asset_price_history WHERE investment_id = $1',
      [Number(investmentId)]
    );
    return;
  }

  const { investment, holdingWindows } = data;

  try {
    await backfillInvestmentQuotes(investment, holdingWindows);
  } catch (error) {
    logger.warn('Transaction-triggered quote refresh failed', {
      investmentId,
      error: error?.message,
    });
  }

  // Cleanup quotes outside the (possibly updated) holding windows
  try {
    const singleMap = new Map([[investmentId, { investment, holdingWindows }]]);
    await cleanupStaleQuotes(singleMap);
  } catch (error) {
    logger.warn('Post-transaction stale quote cleanup failed', {
      investmentId,
      error: error?.message,
    });
  }
}

// ─── Stale Quote Cleanup ────────────────────────────────────────────────────

/**
 * Delete asset_price_history rows that fall outside any holding window
 * for the given investments.
 *
 * @param {Map<number, { investment: HoldingWindowInvestment, holdingWindows: HoldingWindow[] }>} investmentWindows
 * @returns {Promise<number>} Total rows deleted
 */
export async function cleanupStaleQuotes(investmentWindows) {
  // Flatten all windows into parallel arrays so the cleanup is ONE statement
  // (was one DELETE per investment — N round-trips on every maintenance pass).
  const invIds = [];
  const windowInvIds = [];
  const fromDates = [];
  const toDates = [];

  // asset_price_history.price_date is stored in UTC; the open-window sentinel
  // must be UTC-today as well, otherwise a server in a non-UTC timezone
  // deletes valid quotes around midnight.
  const todayUtc = getDayKeyUtc(new Date());

  for (const [invId, { holdingWindows }] of investmentWindows) {
    if (holdingWindows.length === 0) continue;
    invIds.push(invId);
    for (const w of holdingWindows) {
      windowInvIds.push(invId);
      fromDates.push(w.fromDate);
      toDates.push(w.toDate !== null ? w.toDate : todayUtc);
    }
  }

  if (invIds.length === 0) return 0;

  let totalDeleted = 0;
  try {
    const result = await query(
      `DELETE FROM asset_price_history aph
       WHERE aph.investment_id = ANY($1::int[])
         AND NOT EXISTS (
           SELECT 1 FROM unnest($2::int[], $3::date[], $4::date[]) AS w(inv_id, from_date, to_date)
           WHERE w.inv_id = aph.investment_id
             AND aph.price_date >= w.from_date AND aph.price_date <= w.to_date
         )`,
      [invIds, windowInvIds, fromDates, toDates]
    );
    totalDeleted = result.rowCount || 0;
  } catch (error) {
    logger.warn('Failed to cleanup stale quotes', {
      investmentCount: invIds.length,
      error: error?.message,
    });
  }

  if (totalDeleted > 0) {
    logger.info('Stale quote cleanup complete', { deletedRows: totalDeleted });
  }

  return totalDeleted;
}

// ─── Private Helpers ────────────────────────────────────────────────────────

/** @param {number|null|undefined} value */
function _isPositive(value) {
  return Number.isFinite(value) && value > 0;
}
