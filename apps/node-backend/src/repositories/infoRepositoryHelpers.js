/**
 * Shared helpers for infoRepository sub-modules.
 * Not intended for direct use outside this folder.
 */

import { query } from '../database/connection.js';
import { convertRowsToEur } from '../services/currency/currencyConversionService.js';
import { toDecimal, toNumber } from '../lib/money.js';

// ── Materialized-view cache ────────────────────────────────────────────────
// Keyed by view name; cleared via clearMvCache() after bulk import.
// Stores entries as { value: boolean, expires: number | null } so that a
// negative result (view missing or empty) does not force a DB round-trip on
// every request — without it, a fresh DB or a missing MV produces N hits
// per second under load. Positive entries never expire (the view existing
// is a stable schema fact); negative entries expire after a short TTL so
// that a freshly created view is picked up quickly.
const mvCache = new Map();
const MV_NEGATIVE_CACHE_TTL_MS = 60_000;

// Allowlist of materialized-view names that may be passed to mvAvailable.
// The function builds raw SQL with the name interpolated, which is safe
// today because every caller passes a literal — but pinning the set here
// keeps it that way and makes a future caller adding a user-controlled
// name fail loudly instead of opening an injection vector.
const ALLOWED_MV_NAMES = new Set([
  'mv_category_totals',
  'mv_monthly_summary',
]);

/**
 * Check if a materialized view exists and has rows.
 * Positive results cached in-process indefinitely; negative results cached
 * for {@link MV_NEGATIVE_CACHE_TTL_MS} so we recover quickly after MV creation.
 *
 * @throws {Error} if {@code viewName} is not in the allowlist.
 */
export async function mvAvailable(viewName) {
  if (!ALLOWED_MV_NAMES.has(viewName)) {
    throw new Error(`mvAvailable: unknown materialized view "${viewName}"`);
  }
  const cached = mvCache.get(viewName);
  if (cached !== undefined) {
    if (cached.expires === null || cached.expires > Date.now()) {
      return cached.value;
    }
    mvCache.delete(viewName);
  }
  try {
    const r = await query(`SELECT 1 FROM ${viewName} LIMIT 1`);
    const available = r.rows.length > 0;
    if (available) {
      mvCache.set(viewName, { value: true, expires: null });
    } else {
      mvCache.set(viewName, { value: false, expires: Date.now() + MV_NEGATIVE_CACHE_TTL_MS });
    }
    return available;
  } catch {
    mvCache.set(viewName, { value: false, expires: Date.now() + MV_NEGATIVE_CACHE_TTL_MS });
    return false;
  }
}

/**
 * Clear the materialized-view availability cache.
 * Call after schema changes or when views are known to have been recreated.
 */
export function clearMvCache() {
  mvCache.clear();
}

// ── Numeric helpers ────────────────────────────────────────────────────────

export function roundToCents(value) {
  return Math.round(value * 100) / 100;
}

// ── Date helpers ───────────────────────────────────────────────────────────

export function formatDateToYmd(date) {
  return date.toISOString().split('T')[0];
}

export function formatDateToYm(date) {
  return date.toISOString().substring(0, 7);
}

export function formatYearMonthKey(year, month) {
  return `${year}-${String(month).padStart(2, '0')}`;
}

export function addDaysUtc(date, days = 1) {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

export function getDayKeyUtc(date) {
  const yyyy = date.getUTCFullYear();
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(date.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

export function getUtcDayEndTimestamp(date) {
  return Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate(),
    23, 59, 59, 999
  );
}

export function extractYearMonth(value) {
  return String(value).substring(0, 7);
}

// ── Aggregation helpers ────────────────────────────────────────────────────

export function buildMonthlySummary(months) {
  return {
    total_spending: toNumber(months.reduce((sum, m) => sum.plus(toDecimal(m.total_spending)), toDecimal(0))),
    total_income: toNumber(months.reduce((sum, m) => sum.plus(toDecimal(m.total_income)), toDecimal(0))),
    net_amount: toNumber(months.reduce((sum, m) => sum.plus(toDecimal(m.net_amount)), toDecimal(0))),
    // eslint-disable-next-line vision-local-money/no-raw-money-arithmetic
    transaction_count: months.reduce((sum, m) => sum + m.transaction_count, 0),
    period_start: months[0]?.period_start,
    period_end: months[months.length - 1]?.period_end,
  };
}

export function mapRowsForAmountConversion(rows, amountField = 'amount', fallbackToZero = true) {
  return rows.map(row => ({
    ...row,
    amount: fallbackToZero
      ? toNumber(toDecimal(row[amountField] ?? 0))
      : toNumber(toDecimal(row[amountField])),
  }));
}

// ── Category helpers ───────────────────────────────────────────────────────

export function getCategoryKey(categoryId) {
  return categoryId === -1 ? 'null' : String(categoryId);
}

export function parseCategoryId(categoryId) {
  return categoryId === -1 ? null : parseInt(categoryId, 10);
}

export function buildCategoryFromConvertedRows(convertedRows) {
  const categoryMap = new Map();

  for (const row of convertedRows) {
    const key = getCategoryKey(row.category_id);
    const eur = row.amount_eur;
    const count = parseInt(row.count, 10);

    const existing = categoryMap.get(key);
    if (existing) {
      existing.count += count;
      existing.total += roundToCents(eur);
      continue;
    }

    categoryMap.set(key, {
      id: parseCategoryId(row.category_id),
      name: row.name,
      count,
      total: roundToCents(eur),
    });
  }

  return Array.from(categoryMap.values());
}

// ── Currency conversion helpers ────────────────────────────────────────────

export async function convertRowsWithHistoricalRateFallback(rows, targetCurrency, dateField = 'date') {
  try {
    return await convertRowsToEur(rows, targetCurrency, { useHistoricalRatesByDate: true, dateField });
  } catch {
    return await convertRowsToEur(rows, targetCurrency);
  }
}

/**
 * Convert multiple independent row groups with a single historical-rate DB query.
 *
 * Instead of N separate `convertRowsToEur` calls (each querying `exchange_rates`),
 * this combines all groups into one batch, converts once, then splits back.
 *
 * The `_batchGroup` tag is stripped from all returned rows.
 *
 * @param {Array<Array<Object>>} groups - Each group has rows with `amount` + `currency`
 * @param {string} targetCurrency
 * @param {string} [dateField='date'] - Date field used for historical rate lookup
 * @returns {Promise<Array<Array<Object>>>} Converted groups in the same order as input
 */
export async function batchConvertGroupsWithHistoricalRateFallback(groups, targetCurrency, dateField = 'date') {
  const TAG = '_batchGroup';
  const tagged = groups.flatMap((group, groupIdx) =>
    group.map(row => ({ ...row, [TAG]: groupIdx }))
  );

  let converted;
  try {
    converted = await convertRowsToEur(tagged, targetCurrency, { useHistoricalRatesByDate: true, dateField });
  } catch {
    converted = await convertRowsToEur(tagged, targetCurrency);
  }

  return groups.map((_, i) =>
    converted
      .filter(r => r[TAG] === i)
      .map(({ [TAG]: _tag, ...rest }) => rest)
  );
}

// ── Investment spike sanitizer ─────────────────────────────────────────────

export function sanitizeIsolatedDailyInvestmentSpikes(snapshots) {
  if (!Array.isArray(snapshots) || snapshots.length < 3) {
    return Array.isArray(snapshots) ? snapshots : [];
  }

  const sanitized = snapshots.map(s => ({ ...s }));
  const minJump = Math.log(1.18);
  const neighborTolerance = Math.log(1.12);
  const localNeedleRatio = 1.8;

  for (let i = 1; i < sanitized.length - 1; i += 1) {
    const prev = Number(sanitized[i - 1]?.investments);
    const current = Number(sanitized[i]?.investments);
    const next = Number(sanitized[i + 1]?.investments);

    if (!Number.isFinite(prev) || !Number.isFinite(current) || !Number.isFinite(next)) continue;
    if (prev <= 0 || current <= 0 || next <= 0) continue;

    const jump = Math.log(current / prev);
    const revert = Math.log(next / current);
    const bridge = Math.log(next / prev);

    const oppositeDirections = (jump > 0 && revert < 0) || (jump < 0 && revert > 0);
    const largeMove = Math.abs(jump) >= minJump && Math.abs(revert) >= minJump;
    const bridgeLooksNormal = Math.abs(bridge) <= neighborTolerance;

    const maxNeighbor = Math.max(prev, next);
    const minNeighbor = Math.min(prev, next);
    const localNeedlePeak = current >= maxNeighbor * localNeedleRatio && bridgeLooksNormal;
    const localNeedleTrough = current * localNeedleRatio <= minNeighbor && bridgeLooksNormal;

    if ((oppositeDirections && largeMove && bridgeLooksNormal) || localNeedlePeak || localNeedleTrough) {
      const correctedInvestments = Math.sqrt(prev * next);
      const liquid = Number(sanitized[i]?.liquid) || 0;
      sanitized[i].investments = roundToCents(correctedInvestments);
      sanitized[i].netWorth = roundToCents(liquid + correctedInvestments);
    }
  }

  return sanitized;
}
