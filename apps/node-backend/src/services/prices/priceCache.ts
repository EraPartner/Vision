/**
 * Price Cache
 *
 * In-memory TTL cache for live prices and historical point sets,
 * plus the DB read/write layer for asset_price_history.
 */

import { sql } from "kysely";
import { asInvestmentId } from "@vision/types/brands";
import type { InvestmentId } from "@vision/types/brands";
import { checkedRows, db } from "../../database/db.ts";
import {
  latestPricePointDbRowSchema,
  pricePointDbRowSchema,
} from "../../database/rows/portfolio.ts";
import {
  epochMsToUtcYmd,
  normalizeDateLikeToYmd,
} from "../../lib/dateFormat.ts";
import { ymdToEpochDay } from "../../lib/timezone.ts";
import { validateInt4Ids } from "../../lib/filterBuilder.ts";
import type { PricePoint } from "../../types/rows.ts";

export type { PricePoint };

/**
 * A raw, unvalidated price point as it arrives from a provider adapter or a DB
 * projection — both fields may be missing, non-finite, or the wrong type;
 * `normalizeHistoryPoints` is the gate that turns these into {@link PricePoint}s.
 */
export type RawPricePoint = { timestampMs?: unknown; price?: unknown };

/** Optional epoch-millis bounds; non-finite values are ignored. */
export interface PointRange {
  fromMs?: number | undefined;
  toMs?: number | undefined;
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

/**
 * What the price layer caches per key: a live quote (`price`) or a history
 * series (`points`), with the source that produced it. This module never
 * inspects the payload; the call sites in priceProviderService read it back.
 */
export type PriceCachePayload = {
  price?: number;
  points?: PricePoint[];
  source?: string;
};

// Key: `${provider}:${providerId}` — Value: { data, expiresAt }
const _cache = new Map<string, { data: PriceCachePayload; expiresAt: number }>();

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
 * `Array.isArray` narrows a `readonly T[]` to `any[]`; this keeps the element
 * type. Anything that is not an array (a missing series) reads as empty.
 */
export function readonlyArrayOrEmpty<T>(
  value: readonly T[] | null | undefined,
): readonly T[] {
  return Array.isArray(value) ? (value as readonly T[]) : [];
}

/**
 * Validate, de-duplicate by calendar day (last one wins) and date-sort a raw
 * point series. Non-array input and malformed points are dropped, not thrown.
 *
 * @returns date-ascending, one point per day
 */
export function normalizeHistoryPoints(
  points: readonly RawPricePoint[] | null | undefined,
): PricePoint[] {
  const rawPoints = readonlyArrayOrEmpty<RawPricePoint | null | undefined>(points);
  if (rawPoints.length === 0) return [];
  const byDate = new Map<string, PricePoint>();

  for (const point of rawPoints) {
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

  return readonlyArrayOrEmpty(points).filter((p) => {
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
  if (
    firstTs === undefined ||
    lastTs === undefined ||
    !Number.isFinite(firstTs) ||
    !Number.isFinite(lastTs)
  )
    return true;

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
  const before = readonlyArrayOrEmpty<RawPricePoint | null | undefined>(beforePoints);
  const after = readonlyArrayOrEmpty<RawPricePoint | null | undefined>(afterPoints);
  const len = Math.min(before.length, after.length);
  let changed = 0;
  for (let i = 0; i < len; i += 1) {
    const beforePrice = toNumber(before[i]?.price);
    const afterPrice = toNumber(after[i]?.price);
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
export function cacheGet(key: string): PriceCachePayload | undefined {
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
 * @param data a live quote or a history series
 */
export function cacheSet(key: string, data: PriceCachePayload): void {
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
  if (!Number.isFinite(investmentId)) return [];
  const fromDate = Number.isFinite(Number(fromMs))
    ? toDateOnly(Number(fromMs))
    : null;
  const toDateVal = Number.isFinite(Number(toMs))
    ? toDateOnly(Number(toMs))
    : null;

  try {
    let builder = db
      .selectFrom("asset_price_history")
      .select(["price_date", "close_price"])
      .where("investment_id", "=", asInvestmentId(investmentId))
      .orderBy("price_date", "asc");
    if (fromDate !== null)
      builder = builder.where("price_date", ">=", sql<Date>`${fromDate}::date`);
    if (toDateVal !== null)
      builder = builder.where("price_date", "<=", sql<Date>`${toDateVal}::date`);
    const rows = await checkedRows(pricePointDbRowSchema, builder);

    return normalizeHistoryPoints(
      rows.map((row) => ({
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
    const rows = await checkedRows(
      latestPricePointDbRowSchema,
      db
        .selectFrom("asset_price_history")
        .distinctOn("investment_id")
        .select(["investment_id", "price_date", "close_price"])
        .where("investment_id", "=", sql<InvestmentId>`ANY(${ids}::int[])`)
        .orderBy("investment_id")
        .orderBy("price_date", "desc"),
    );

    const byId = new Map<number, LatestHistoricalPoint>();
    for (const row of rows) {
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

/**
 * Upsert a normalized point series for one investment. Silently no-ops when the
 * table is absent (42P01) or nothing survives normalization. Points whose price
 * and source are unchanged are not rewritten: the startup backfill re-saves
 * every stored series, and rewriting identical rows only produced dead tuples.
 *
 * @param source provider id; defaults to 'provider'
 */
export async function saveHistoricalPointsToDatabase(
  investmentId: number,
  points: readonly RawPricePoint[] | null | undefined,
  source: string | null | undefined,
): Promise<void> {
  const normalized = normalizeHistoryPoints(points);
  if (!Number.isFinite(investmentId) || normalized.length === 0) return;

  const priceDates: string[] = [];
  const closePrices: number[] = [];

  for (const point of normalized) {
    const dateOnly = toDateOnly(point.timestampMs);
    if (!dateOnly || !isValidPrice(point.price)) continue;
    priceDates.push(dateOnly);
    closePrices.push(point.price);
  }

  if (priceDates.length === 0) return;

  try {
    await sql`INSERT INTO asset_price_history (investment_id, price_date, close_price, source)
     SELECT ${investmentId}, p.price_date::date, p.close_price::numeric, ${source || "provider"}
     FROM UNNEST(${priceDates}::date[], ${closePrices}::numeric[]) AS p(price_date, close_price)
     ON CONFLICT (investment_id, price_date)
     DO UPDATE SET
       close_price = EXCLUDED.close_price,
       source = EXCLUDED.source,
       fetched_at = NOW(),
       updated_at = NOW()
     WHERE (asset_price_history.close_price, asset_price_history.source)
       IS DISTINCT FROM (EXCLUDED.close_price, EXCLUDED.source)`.execute(db);
  } catch (error) {
    if (hasErrorCode(error, "42P01")) return;
    if (hasErrorCode(error, "23503")) {
      Object.assign(error, {
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
