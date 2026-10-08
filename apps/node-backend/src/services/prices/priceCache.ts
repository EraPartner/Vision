/**
 * Price Cache
 *
 * In-memory TTL cache for live prices and historical point sets,
 * plus the DB read/write layer for asset_price_history.
 */

import { query } from "../../database/connection.ts";
import { logger } from "../../config/logger.ts";
import {
  epochMsToUtcYmd,
  normalizeDateLikeToYmd,
} from "../../lib/dateFormat.ts";
import { ymdToEpochDay } from "../../lib/timezone.ts";
import { validateInt4Ids } from "../../lib/filterBuilder.ts";
import type {
  AssetPriceHistoryRow,
  PricePoint,
} from "../../types/rows.ts";

export type { AssetPriceHistoryRow, PricePoint };

/**
 * A raw, unvalidated price point as it arrives from a provider adapter or a DB
 * projection — both fields may be missing, non-finite, or the wrong type;
 * `normalizeHistoryPoints` is the gate that turns these into {@link PricePoint}s.
 */
export type RawPricePoint = { timestampMs?: unknown; price?: unknown };

/** Optional epoch-millis bounds; non-finite values are ignored. */
export interface PointRange {
  fromMs?: number;
  toMs?: number;
}

/** True when a thrown value carries the given pg/Node error `code`. */
function hasErrorCode(
  error: unknown,
  code: string,
): error is object & { code: string } {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}

/** Latest point per investment; `price` is unvalidated (NUMERIC-coerced). */
export interface LatestHistoricalPoint {
  timestampMs: number;
  price: number | undefined;
}

const PRICE_CACHE_TTL_MS = 5 * 60_000;
const HISTORY_DAY_MS = 24 * 60 * 60 * 1000;

// Key: `${provider}:${providerId}` — Value: { data, expiresAt }
// The payload differs per call site (a live quote, a point array, a provider
// response) and this module never inspects it, so it stays `any`.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const _cache = new Map<string, { data: any; expiresAt: number }>();

// ─── Shared numeric helpers ───────────────────────────────────────────────────

/**
 * Coerce to a finite number, or undefined. Deliberately accepts anything —
 * it is applied to raw provider JSON and to NUMERIC columns (pg strings).
 */
export function toNumber(value: unknown): number | undefined {
  const num = Number(value);
  return Number.isFinite(num) ? num : undefined;
}

/**
 * True only for a value that coerces to a finite, strictly-positive number.
 * Narrows to `number` because every caller passes the output of
 * {@link toNumber}, so a passing value is already a number.
 */
export function isValidPrice(value: unknown): value is number {
  const num = toNumber(value);
  return num !== undefined && num > 0;
}

// ─── Date / timestamp helpers ─────────────────────────────────────────────────

/** @returns the UTC calendar day as 'YYYY-MM-DD' */
function toDateOnly(timestampMs: number): string | undefined {
  if (!Number.isFinite(timestampMs)) return undefined;
  return epochMsToUtcYmd(timestampMs);
}

/**
 * @param dateOnly a 'YYYY-MM-DD' string or a pg DATE (local-midnight `Date`)
 * @returns epoch ms at UTC noon of that day, or NaN when unparseable
 */
function dateOnlyToTimestampMs(
  dateOnly: string | Date | null | undefined,
): number {
  const ymd = normalizeDateLikeToYmd(dateOnly);
  if (!ymd) return Number.NaN;
  try {
    return ymdToEpochDay(ymd) * HISTORY_DAY_MS + 12 * 60 * 60 * 1000;
  } catch {
    return Number.NaN;
  }
}

// ─── History point helpers ────────────────────────────────────────────────────

/**
 * Validate, de-duplicate by calendar day (last one wins) and date-sort a raw
 * point series. Non-array input and malformed points are dropped, not thrown.
 *
 * @returns date-ascending, one point per day
 */
export function normalizeHistoryPoints(
  points: readonly RawPricePoint[] | null | undefined,
): PricePoint[] {
  if (!Array.isArray(points) || points.length === 0) return [];
  const byDate = new Map<string, PricePoint>();

  for (const point of points) {
    const timestampMs = Number(point?.timestampMs);
    const price = toNumber(point?.price);
    if (!Number.isFinite(timestampMs) || !isValidPrice(price)) continue;
    const dateOnly = toDateOnly(timestampMs);
    if (!dateOnly) continue;
    byDate.set(dateOnly, {
      timestampMs: dateOnlyToTimestampMs(dateOnly),
      price,
    });
  }

  return [...byDate.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([, point]) => point);
}

export function filterPointsByRange(
  points: readonly PricePoint[],
  { fromMs, toMs }: PointRange = {},
): PricePoint[] {
  const from = Number.isFinite(Number(fromMs)) ? Number(fromMs) : undefined;
  const to = Number.isFinite(Number(toMs)) ? Number(toMs) : undefined;

  return (Array.isArray(points) ? points : []).filter((p) => {
    if (from !== undefined && p.timestampMs < from) return false;
    if (to !== undefined && p.timestampMs > to) return false;
    return true;
  });
}

export function needsHistoryRefresh(
  points: readonly RawPricePoint[] | null | undefined,
  { fromMs, toMs }: PointRange = {},
): boolean {
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
 */
export function countChangedPointPrices(
  beforePoints: readonly RawPricePoint[] | null | undefined,
  afterPoints: readonly RawPricePoint[] | null | undefined,
): number {
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
 * @param key `${provider}:${providerId}`
 * @returns the cached payload, or undefined when absent/expired
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function cacheGet(key: string): any {
  const entry = _cache.get(key);
  if (!entry) return undefined;
  if (Date.now() > entry.expiresAt) {
    _cache.delete(key);
    return undefined;
  }
  return entry.data;
}

/**
 * @param key `${provider}:${providerId}`
 * @param data payload shape varies per call site
 */
export function cacheSet(key: string, data: unknown): void {
  _cache.set(key, { data, expiresAt: Date.now() + PRICE_CACHE_TTL_MS });
}

export function resetPriceCache(): void {
  _cache.clear();
}

const CACHE_SWEEP_INTERVAL_MS = 5 * 60_000;

function sweepExpiredCacheEntries(now: number = Date.now()): number {
  let removed = 0;
  for (const [key, entry] of _cache) {
    if (now > entry.expiresAt) {
      _cache.delete(key);
      removed += 1;
    }
  }
  return removed;
}

const _sweepInterval = setInterval(
  sweepExpiredCacheEntries,
  CACHE_SWEEP_INTERVAL_MS,
);
if (typeof _sweepInterval.unref === "function") _sweepInterval.unref();

// ─── DB persistence ───────────────────────────────────────────────────────────

export async function loadHistoricalPointsFromDatabase(
  investmentId: number,
  { fromMs, toMs }: PointRange = {},
): Promise<PricePoint[]> {
  if (!Number.isFinite(Number(investmentId))) return [];
  const fromDate = Number.isFinite(Number(fromMs))
    ? toDateOnly(Number(fromMs))
    : null;
  const toDateVal = Number.isFinite(Number(toMs))
    ? toDateOnly(Number(toMs))
    : null;

  try {
    const result = await query<
      Pick<AssetPriceHistoryRow, "price_date" | "close_price">
    >(
      `SELECT price_date, close_price
       FROM asset_price_history
       WHERE investment_id = $1
         AND ($2::date IS NULL OR price_date >= $2::date)
         AND ($3::date IS NULL OR price_date <= $3::date)
       ORDER BY price_date ASC`,
      [Number(investmentId), fromDate, toDateVal],
    );

    return normalizeHistoryPoints(
      result.rows.map((row) => ({
        timestampMs: dateOnlyToTimestampMs(row.price_date),
        price: toNumber(row.close_price),
      })),
    );
  } catch (error) {
    if (hasErrorCode(error, "42P01")) return [];
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
 */
export async function loadLatestHistoricalPointByInvestmentIds(
  investmentIds: readonly number[],
): Promise<Map<number, LatestHistoricalPoint>> {
  const ids = [...new Set(validateInt4Ids(investmentIds, "investmentIds"))];
  if (ids.length === 0) return new Map();

  try {
    const result = await query<
      Pick<AssetPriceHistoryRow, "investment_id" | "price_date" | "close_price">
    >(
      `SELECT DISTINCT ON (investment_id) investment_id, price_date, close_price
       FROM asset_price_history
       WHERE investment_id = ANY($1::int[])
       ORDER BY investment_id, price_date DESC`,
      [ids],
    );

    const byId = new Map<number, LatestHistoricalPoint>();
    for (const row of result.rows) {
      byId.set(row.investment_id, {
        timestampMs: dateOnlyToTimestampMs(row.price_date),
        price: toNumber(row.close_price),
      });
    }
    return byId;
  } catch (error) {
    if (hasErrorCode(error, "42P01")) return new Map();
    throw error;
  }
}

async function _dropForeignKey(): Promise<void> {
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
    logger.warn("Failed to drop asset price history FK constraint", {
      error:
        typeof error === "object" && error !== null && "message" in error
          ? error.message
          : undefined,
    });
  }
}

/**
 * Upsert a normalized point series for one investment. Silently no-ops when the
 * table is absent (42P01) or nothing survives normalization.
 *
 * @param source provider id; defaults to 'provider'
 */
export async function saveHistoricalPointsToDatabase(
  investmentId: number,
  points: readonly RawPricePoint[] | null | undefined,
  source: string | null | undefined,
): Promise<void> {
  const normalized = normalizeHistoryPoints(points);
  if (!Number.isFinite(Number(investmentId)) || normalized.length === 0) return;

  const priceDates: string[] = [];
  const closePrices: number[] = [];

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
  const upsertArgs = [
    Number(investmentId),
    source || "provider",
    priceDates,
    closePrices,
  ];

  try {
    await query(upsertSql, upsertArgs);
  } catch (error) {
    if (hasErrorCode(error, "42P01")) return;
    if (hasErrorCode(error, "23503")) {
      throw Object.assign(error, {
        context:
          "priceCache upsert: orphan investment_id — resolve via investigation of FK violation, never auto-drop",
      });
    }
    throw error;
  }
}

export {
  PRICE_CACHE_TTL_MS as __PRICE_CACHE_TTL_MS,
  toDateOnly as __toDateOnly,
  dateOnlyToTimestampMs,
  sweepExpiredCacheEntries as __sweepExpiredCacheEntries,
};
