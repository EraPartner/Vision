/**
 * Shared helpers for infoRepository sub-modules.
 * Not intended for direct use outside this folder.
 */

import { query } from "../database/connection.js";
import { convertRowsToEur } from "../services/currency/currencyConversionService.js";
import { toDecimal, toNumber, roundMoney } from "../lib/money.js";
import settingsRepository from "./settingsRepository.js";

/**
 * Whether internal transfers (ADR-083) should be counted in cash-flow
 * aggregates. Default false (exclude); user-toggleable via the
 * `includeTransfers` setting. When true, callers should also bypass the
 * transfer-excluding materialized views and use the base-table path.
 */
export async function getIncludeTransfers() {
  return (await settingsRepository.get("includeTransfers")) === true;
}

// ── Materialized-view cache ────────────────────────────────────────────────
// Keyed by view name. There is no production caller that clears it after an
// import: entries self-heal via the short TTL below. A freshly created view is
// picked up promptly, while a view dropped during the process lifetime stops
// being treated as available. clearMvCache() exists only as a test-reset seam.
// Stores entries as { value: boolean, expires: number }; the TTL avoids a DB
// round-trip on every request without making either result permanent.
const mvCache = new Map();
const MV_CACHE_TTL_MS = 60_000;

// Allowlist of materialized-view names that may be passed to mvAvailable.
// The function builds raw SQL with the name interpolated, which is safe
// today because every caller passes a literal — but pinning the set here
// keeps it that way and makes a future caller adding a user-controlled
// name fail loudly instead of opening an injection vector.
const ALLOWED_MV_NAMES = new Set(["mv_category_totals", "mv_monthly_summary"]);

/**
 * Check if a materialized view exists and has rows.
 * Results are cached for {@link MV_CACHE_TTL_MS}, then re-probed so runtime
 * creation and removal both self-heal without a process restart.
 *
 * @param {string} viewName
 * @returns {Promise<boolean>}
 * @throws {Error} if {@code viewName} is not in the allowlist.
 */
export async function mvAvailable(viewName) {
  if (!ALLOWED_MV_NAMES.has(viewName)) {
    throw new Error(`mvAvailable: unknown materialized view "${viewName}"`);
  }
  const cached = mvCache.get(viewName);
  if (cached !== undefined) {
    if (cached.expires > Date.now()) {
      return cached.value;
    }
    mvCache.delete(viewName);
  }
  try {
    const r = await query(`SELECT 1 FROM ${viewName} LIMIT 1`);
    const available = r.rows.length > 0;
    mvCache.set(viewName, {
      value: available,
      expires: Date.now() + MV_CACHE_TTL_MS,
    });
    return available;
  } catch {
    mvCache.set(viewName, {
      value: false,
      expires: Date.now() + MV_CACHE_TTL_MS,
    });
    return false;
  }
}

/**
 * Clear the materialized-view availability cache. Test-reset seam only — there
 * is no production caller because entries self-heal through the bounded TTL.
 * Kept for tests that need a deterministic starting cache state.
 */
export function clearMvCache() {
  mvCache.clear();
}

// Compatibility re-exports for callers outside the info-repository family.
// Internal consumers import these helpers from their canonical owners.
export { roundMoney as roundToCents } from "../lib/money.js";
export { formatDateToYmd, toWireDate } from "../lib/dateFormat.js";
export {
  formatYearMonthKey,
  addDaysUtc,
  getDayKeyUtc,
  extractYearMonth,
} from "../lib/dateKeys.js";

// ── Aggregation helpers ────────────────────────────────────────────────────

/**
 * Shape converted `{ period, <idField>, <labelField>, amount_eur, cnt }` rows
 * into `{ [period]: [{ [idKey], [labelKey], total, transactionCount }] }`,
 * summing absolute EUR per (period, entity), rounding totals to cents, and
 * sorting each period ascending by total. Shared by the recipient and tag
 * period-pivots (SIMP-49).
 *
 * @param {Array<Record<string, any>>} convertedRows
 * @param {{ idField: string, labelField: string, idKey: string, labelKey: string }} shape
 * @returns {Record<string, Array<Record<string, any>>>}
 */
export function buildPeriodPivot(
  convertedRows,
  { idField, labelField, idKey, labelKey },
) {
  /** @type {Record<string, Record<string, Record<string, any>>>} */
  const periodMap = {};
  for (const row of convertedRows) {
    const period = row.period;
    const id = parseInt(row[idField], 10);
    const eur = Math.abs(row.amount_eur);
    const cnt = parseInt(row.cnt, 10) || 0;

    if (!periodMap[period]) periodMap[period] = {};
    if (!periodMap[period][id]) {
      periodMap[period][id] = {
        [idKey]: id,
        [labelKey]: row[labelField],
        total: 0,
        transactionCount: 0,
      };
    }
    periodMap[period][id].total += eur;
    periodMap[period][id].transactionCount += cnt;
  }

  /** @type {Record<string, Array<Record<string, any>>>} */
  const pivot = {};
  for (const [period, entities] of Object.entries(periodMap)) {
    pivot[period] = Object.values(entities)
      .map((e) => ({ ...e, total: roundMoney(e.total) }))
      .sort((a, b) => a.total - b.total);
  }
  return pivot;
}

/**
 * @param {Array<{
 *   total_spending: number, total_income: number, net_amount: number,
 *   transaction_count: number, period_start?: string|null, period_end?: string|null,
 * }>} months
 */
export function buildMonthlySummary(months) {
  return {
    total_spending: toNumber(
      months.reduce(
        (sum, m) => sum.plus(toDecimal(m.total_spending)),
        toDecimal(0),
      ),
    ),
    total_income: toNumber(
      months.reduce(
        (sum, m) => sum.plus(toDecimal(m.total_income)),
        toDecimal(0),
      ),
    ),
    net_amount: toNumber(
      months.reduce(
        (sum, m) => sum.plus(toDecimal(m.net_amount)),
        toDecimal(0),
      ),
    ),
    // eslint-disable-next-line vision-local-money/no-raw-money-arithmetic
    transaction_count: months.reduce((sum, m) => sum + m.transaction_count, 0),
    period_start: months[0]?.period_start,
    period_end: months[months.length - 1]?.period_end,
  };
}

/**
 * @param {Array<Record<string, any>>} rows
 * @param {string} [amountField]
 * @param {boolean} [fallbackToZero]
 * @returns {Array<Record<string, any>>} rows with a numeric `amount` merged in
 */
export function mapRowsForAmountConversion(
  rows,
  amountField = "amount",
  fallbackToZero = true,
) {
  return rows.map((row) => ({
    ...row,
    amount: fallbackToZero
      ? toNumber(toDecimal(row[amountField] ?? 0))
      : toNumber(toDecimal(row[amountField])),
  }));
}

// ── Category helpers ───────────────────────────────────────────────────────

/**
 * @param {number|string} categoryId `-1` is the "uncategorised" sentinel.
 * @returns {string}
 */
function getCategoryKey(categoryId) {
  return categoryId === -1 ? "null" : String(categoryId);
}

/**
 * @param {any} categoryId A number or numeric string; `-1` is the
 *   "uncategorised" sentinel. (`any` because the value is fed to `parseInt`,
 *   whose declared parameter is `string` — the runtime coercion of a number is
 *   deliberate here.)
 * @returns {number|null}
 */
function parseCategoryId(categoryId) {
  return categoryId === -1 ? null : parseInt(categoryId, 10);
}

/**
 * @param {Array<Record<string, any>>} convertedRows
 * @returns {Array<{ id: number|null, name: string, count: number, total: number }>}
 */
export function buildCategoryFromConvertedRows(convertedRows) {
  /** @type {Map<string, { id: number|null, name: string, count: number, total: number }>} */
  const categoryMap = new Map();

  for (const row of convertedRows) {
    const key = getCategoryKey(row.category_id);
    const eur = row.amount_eur;
    const count = parseInt(row.count, 10);

    const existing = categoryMap.get(key);
    if (existing) {
      existing.count += count;
      existing.total += roundMoney(eur);
      continue;
    }

    categoryMap.set(key, {
      id: parseCategoryId(row.category_id),
      name: row.name,
      count,
      total: roundMoney(eur),
    });
  }

  return Array.from(categoryMap.values());
}

// ── Currency conversion helpers ────────────────────────────────────────────

/**
 * @param {Array<Record<string, any>>} rows Rows with `amount` + `currency`.
 * @param {string} targetCurrency
 * @param {string} [dateField] Date field used for the historical rate lookup.
 * @returns {Promise<Array<Record<string, any>>>} rows with `amount_eur` merged in
 */
export async function convertRowsWithHistoricalRateFallback(
  rows,
  targetCurrency,
  dateField = "date",
) {
  try {
    return await convertRowsToEur(rows, targetCurrency, {
      useHistoricalRatesByDate: true,
      dateField,
    });
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
 * @param {Array<Array<Record<string, any>>>} groups - Each group has rows with `amount` + `currency`
 * @param {string} targetCurrency
 * @param {string} [dateField='date'] - Date field used for historical rate lookup
 * @returns {Promise<Array<Array<Record<string, any>>>>} Converted groups in the same order as input
 */
export async function batchConvertGroupsWithHistoricalRateFallback(
  groups,
  targetCurrency,
  dateField = "date",
) {
  const TAG = "_batchGroup";
  const tagged = groups.flatMap((group, groupIdx) =>
    group.map((row) => ({ ...row, [TAG]: groupIdx })),
  );

  let converted;
  try {
    converted = await convertRowsToEur(tagged, targetCurrency, {
      useHistoricalRatesByDate: true,
      dateField,
    });
  } catch {
    converted = await convertRowsToEur(tagged, targetCurrency);
  }

  return groups.map((_, i) =>
    converted
      .filter((r) => r[TAG] === i)
      .map(({ [TAG]: _tag, ...rest }) => rest),
  );
}
