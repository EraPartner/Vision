/**
 * Price Cache
 *
 * In-memory TTL cache for live prices and historical point sets,
 * plus the DB read/write layer for asset_price_history.
 */

import { query } from '../../database/connection.js';
import { logger } from '../../config/logger.js';
import { epochMsToUtcYmd } from '../../lib/dateFormat.js';
import { validateInt4Ids } from '../../lib/filterBuilder.js';

/**
 * @typedef {import('../../types/rows.js').AssetPriceHistoryRow} AssetPriceHistoryRow
 * @typedef {import('../../types/rows.js').PricePoint} PricePoint
 */

/**
 * A raw, unvalidated price point as it arrives from a provider adapter or a DB
 * projection — both fields may be missing, non-finite, or the wrong type;
 * `normalizeHistoryPoints` is the gate that turns these into {@link PricePoint}s.
 *
 * @typedef {{ timestampMs?: any, price?: any }} RawPricePoint
 */

export const PRICE_CACHE_TTL_MS = 5 * 60_000;
const HISTORY_DAY_MS = 24 * 60 * 60 * 1000;

// Key: `${provider}:${providerId}` — Value: { data, expiresAt }
// The payload differs per call site (a live quote, a point array, a provider
// response) and this module never inspects it, so it stays `any`.
/** @type {Map<string, { data: any, expiresAt: number }>} */
const _cache = new Map();

// ─── Shared numeric helpers ───────────────────────────────────────────────────

/**
 * Coerce to a finite number, or undefined. Deliberately accepts anything —
 * it is applied to raw provider JSON and to NUMERIC columns (pg strings).
 *
 * @param {any} value
 * @returns {number|undefined}
 */
export function toNumber(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : undefined;
}

/**
 * @param {any} value
 * @returns {boolean} true only for a finite, strictly-positive number
 */
export function isValidPrice(value) {
  const num = toNumber(value);
  return num !== undefined && num > 0;
}

// ─── Date / timestamp helpers ─────────────────────────────────────────────────

/**
 * @param {number} timestampMs
 * @returns {string|undefined} the UTC calendar day as 'YYYY-MM-DD'
 */
export function toDateOnly(timestampMs) {
  if (!Number.isFinite(timestampMs)) return undefined;
  return epochMsToUtcYmd(timestampMs);
}

/**
 * @param {string|Date|null|undefined} dateOnly a 'YYYY-MM-DD' string or a pg DATE (local-midnight `Date`)
 * @returns {number} epoch ms at UTC noon of that day, or NaN when unparseable
 */
export function dateOnlyToTimestampMs(dateOnly) {
  if (!dateOnly) return Number.NaN;
  // pg returns DATE columns as local-midnight Date objects. String() on one is
  // "Wed Jul 01 2026 …" — no parseable y-m-d in ANY timezone — so every
  // DB-cached price-history read NaN'd out and normalizeHistoryPoints filtered
  // every row: a silent live re-fetch (provider-quota burn) or an empty chart
  // under db_only, in every deployment. Extract the calendar day with local
  // getters (the day pg meant), then pin to UTC noon like the string path.
  if (dateOnly instanceof Date) {
    if (Number.isNaN(dateOnly.getTime())) return Number.NaN;
    return Date.UTC(dateOnly.getFullYear(), dateOnly.getMonth(), dateOnly.getDate(), 12, 0, 0, 0);
  }
  const [y, m, d] = String(dateOnly).split('-').map(Number);
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return Number.NaN;
  return Date.UTC(y, m - 1, d, 12, 0, 0, 0);
}

// ─── History point helpers ────────────────────────────────────────────────────

/**
 * Validate, de-duplicate by calendar day (last one wins) and date-sort a raw
 * point series. Non-array input and malformed points are dropped, not thrown.
 *
 * @param {RawPricePoint[]|null|undefined} points
 * @returns {PricePoint[]} date-ascending, one point per day
 */
export function normalizeHistoryPoints(points) {
  if (!Array.isArray(points) || points.length === 0) return [];
  /** @type {Map<string, PricePoint>} */
  const byDate = new Map();

  for (const point of points) {
    const timestampMs = Number(point?.timestampMs);
    const price = toNumber(point?.price);
    if (!Number.isFinite(timestampMs) || !isValidPrice(price)) continue;
    const dateOnly = toDateOnly(timestampMs);
    if (!dateOnly) continue;
    byDate.set(dateOnly, { timestampMs: dateOnlyToTimestampMs(dateOnly), price });
  }

  return [...byDate.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([, point]) => point);
}

/**
 * @param {Array<{ timestampMs: number, price: number }>} points
 * @param {{ fromMs?: number, toMs?: number }} [range]
 */
export function filterPointsByRange(points, { fromMs, toMs } = {}) {
  const from = Number.isFinite(Number(fromMs)) ? Number(fromMs) : undefined;
  const to = Number.isFinite(Number(toMs)) ? Number(toMs) : undefined;

  return (Array.isArray(points) ? points : []).filter((p) => {
    if (from !== undefined && p.timestampMs < from) return false;
    if (to !== undefined && p.timestampMs > to) return false;
    return true;
  });
}

/**
 * @param {Array<{ timestampMs: number, price: number }>} points
 * @param {{ fromMs?: number, toMs?: number }} [range]
 */
export function needsHistoryRefresh(points, { fromMs, toMs } = {}) {
  const normalized = normalizeHistoryPoints(points);
  if (normalized.length === 0) return true;

  const firstTs = normalized[0]?.timestampMs;
  const lastTs = normalized[normalized.length - 1]?.timestampMs;
  if (!Number.isFinite(firstTs) || !Number.isFinite(lastTs)) return true;

  const from = Number.isFinite(Number(fromMs)) ? Number(fromMs) : undefined;
  const to = Number.isFinite(Number(toMs)) ? Number(toMs) : undefined;

  if (from !== undefined && firstTs > from + HISTORY_DAY_MS) return true;
  if (to !== undefined && lastTs < to - HISTORY_DAY_MS) return true;
  return false;
}

/**
 * Count positionally-aligned points whose price actually moved. Used to report
 * how much a refetch changed; non-array or malformed input counts as 0.
 *
 * @param {RawPricePoint[]|null|undefined} beforePoints
 * @param {RawPricePoint[]|null|undefined} afterPoints
 * @returns {number}
 */
export function countChangedPointPrices(beforePoints, afterPoints) {
  if (!Array.isArray(beforePoints) || !Array.isArray(afterPoints)) return 0;
  const len = Math.min(beforePoints.length, afterPoints.length);
  let changed = 0;
  for (let i = 0; i < len; i += 1) {
    const beforePrice = toNumber(beforePoints[i]?.price);
    const afterPrice = toNumber(afterPoints[i]?.price);
    if (!isValidPrice(beforePrice) || !isValidPrice(afterPrice)) continue;
    if (Math.abs(beforePrice - afterPrice) > 1e-9) changed += 1;
  }
  return changed;
}

// ─── In-memory cache ──────────────────────────────────────────────────────────

/**
 * @param {string} key `${provider}:${providerId}`
 * @returns {any} the cached payload, or undefined when absent/expired
 */
export function cacheGet(key) {
  const entry = _cache.get(key);
  if (!entry) return undefined;
  if (Date.now() > entry.expiresAt) { _cache.delete(key); return undefined; }
  return entry.data;
}

/**
 * @param {string} key `${provider}:${providerId}`
 * @param {any} data payload shape varies per call site
 * @returns {void}
 */
export function cacheSet(key, data) {
  _cache.set(key, { data, expiresAt: Date.now() + PRICE_CACHE_TTL_MS });
}

export function resetPriceCache() {
  _cache.clear();
}

const CACHE_SWEEP_INTERVAL_MS = 5 * 60_000;

export function sweepExpiredCacheEntries(now = Date.now()) {
  let removed = 0;
  for (const [key, entry] of _cache) {
    if (now > entry.expiresAt) {
      _cache.delete(key);
      removed += 1;
    }
  }
  return removed;
}

const _sweepInterval = setInterval(sweepExpiredCacheEntries, CACHE_SWEEP_INTERVAL_MS);
if (typeof _sweepInterval.unref === 'function') _sweepInterval.unref();

// ─── DB persistence ───────────────────────────────────────────────────────────

/**
 * @param {number} investmentId
 * @param {{ fromMs?: number, toMs?: number }} [range]
 */
export async function loadHistoricalPointsFromDatabase(investmentId, { fromMs, toMs } = {}) {
  if (!Number.isFinite(Number(investmentId))) return [];
  const fromDate = Number.isFinite(Number(fromMs)) ? toDateOnly(Number(fromMs)) : null;
  const toDateVal = Number.isFinite(Number(toMs)) ? toDateOnly(Number(toMs)) : null;

  try {
    const result = await query(
      `SELECT price_date, close_price
       FROM asset_price_history
       WHERE investment_id = $1
         AND ($2::date IS NULL OR price_date >= $2::date)
         AND ($3::date IS NULL OR price_date <= $3::date)
       ORDER BY price_date ASC`,
      [Number(investmentId), fromDate, toDateVal]
    );

    return normalizeHistoryPoints(
      /** @type {Pick<AssetPriceHistoryRow, 'price_date'|'close_price'>[]} */
      (result.rows).map((row) => ({
        timestampMs: dateOnlyToTimestampMs(row.price_date),
        price: toNumber(row.close_price),
      }))
    );
  } catch (error) {
    if (error?.code === '42P01') return [];
    throw error;
  }
}

/**
 * Batched variant of {@link loadHistoricalPointsFromDatabase} that returns only
 * the single most-recent persisted point per investment. One query for the
 * whole set instead of one per investment.
 *
 * Ids are validated, not filtered. The previous `.map(Number).filter(isFinite)`
 * both dropped and mis-accepted: a dropped id silently returned no fallback
 * price for that investment (the valuation shows it unpriced rather than
 * failing), while `Number.isFinite` let a non-integer like 1.5 through to the
 * `::int[]` cast below. The only caller feeds `inv.id` off investment rows, so
 * nothing malformed reaches this today; a throw here means a real bug, and the
 * caller already downgrades it to a logged warning rather than a failed load.
 *
 * @param {number[]} investmentIds
 * @returns {Promise<Map<number, { timestampMs: number, price: number }>>}
 */
export async function loadLatestHistoricalPointByInvestmentIds(investmentIds) {
  const ids = [...new Set(validateInt4Ids(investmentIds, 'investmentIds'))];
  if (ids.length === 0) return new Map();

  try {
    const result = await query(
      `SELECT DISTINCT ON (investment_id) investment_id, price_date, close_price
       FROM asset_price_history
       WHERE investment_id = ANY($1::int[])
       ORDER BY investment_id, price_date DESC`,
      [ids]
    );

    /** @type {Map<number, PricePoint>} */
    const byId = new Map();
    for (const row of /** @type {Pick<AssetPriceHistoryRow, 'investment_id'|'price_date'|'close_price'>[]} */ (result.rows)) {
      byId.set(row.investment_id, {
        timestampMs: dateOnlyToTimestampMs(row.price_date),
        price: toNumber(row.close_price),
      });
    }
    return byId;
  } catch (error) {
    if (error?.code === '42P01') return new Map();
    throw error;
  }
}

async function _dropForeignKey() {
  try {
    await query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1
          FROM pg_constraint c
          WHERE c.conname = 'fk_asset_price_history_investment'
            AND c.conrelid = 'asset_price_history'::regclass
        ) THEN
          ALTER TABLE asset_price_history
            DROP CONSTRAINT fk_asset_price_history_investment;
        END IF;
      END $$;
    `);
  } catch (error) {
    logger.warn('Failed to drop asset price history FK constraint', { error: error?.message });
  }
}

/**
 * Upsert a normalized point series for one investment. Silently no-ops when the
 * table is absent (42P01) or nothing survives normalization.
 *
 * @param {number} investmentId
 * @param {RawPricePoint[]|null|undefined} points
 * @param {string|null|undefined} source provider id; defaults to 'provider'
 * @returns {Promise<void>}
 */
export async function saveHistoricalPointsToDatabase(investmentId, points, source) {
  const normalized = normalizeHistoryPoints(points);
  if (!Number.isFinite(Number(investmentId)) || normalized.length === 0) return;

  const priceDates = [];
  const closePrices = [];

  for (const point of normalized) {
    const dateOnly = toDateOnly(point.timestampMs);
    if (!dateOnly || !isValidPrice(point.price)) continue;
    priceDates.push(dateOnly);
    closePrices.push(point.price);
  }

  if (priceDates.length === 0) return;

  const upsertSql = `INSERT INTO asset_price_history (investment_id, price_date, close_price, source)
     SELECT $1, p.price_date::date, p.close_price::numeric, $2
     FROM UNNEST($3::date[], $4::numeric[]) AS p(price_date, close_price)
     ON CONFLICT (investment_id, price_date)
     DO UPDATE SET
       close_price = EXCLUDED.close_price,
       source = EXCLUDED.source,
       fetched_at = NOW(),
       updated_at = NOW()`;
  const upsertArgs = [Number(investmentId), source || 'provider', priceDates, closePrices];

  try {
    await query(upsertSql, upsertArgs);
  } catch (error) {
    if (error?.code === '42P01') return;
    if (error?.code === '23503') {
      throw Object.assign(error, {
        context: 'priceCache upsert: orphan investment_id — resolve via investigation of FK violation, never auto-drop',
      });
    }
    throw error;
  }
}
