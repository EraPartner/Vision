/**
 * Shared helpers for infoRepository sub-modules.
 * Not intended for direct use outside this folder.
 */

import { query } from "../database/connection.ts";
import { convertRowsToEur } from "../services/currency/currencyConversionService.ts";
import { toDecimal, toNumber, roundMoney } from "../lib/money.ts";
import type { DecimalInput } from "../lib/money.ts";
import settingsRepository from "./settingsRepository.ts";

/**
 * Whether internal transfers (ADR-083) should be counted in cash-flow
 * aggregates. Default false (exclude); user-toggleable via the
 * `includeTransfers` setting. When true, callers should also bypass the
 * transfer-excluding materialized views and use the base-table path.
 */
export async function getIncludeTransfers(): Promise<boolean> {
  return (await settingsRepository.get("includeTransfers")) === true;
}

// ── Materialized-view cache ────────────────────────────────────────────────
// Keyed by view name. There is no production caller that clears it after an
// import: entries self-heal via the short TTL below. A freshly created view is
// picked up promptly, while a view dropped during the process lifetime stops
// being treated as available. clearMvCache() exists only as a test-reset seam.
// Stores entries as { value: boolean, expires: number }; the TTL avoids a DB
// round-trip on every request without making either result permanent.
const mvCache = new Map<string, { value: boolean; expires: number }>();
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
 * @throws {Error} if {@code viewName} is not in the allowlist.
 */
export async function mvAvailable(viewName: string): Promise<boolean> {
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
export function clearMvCache(): void {
  mvCache.clear();
}

// ── Aggregation helpers ────────────────────────────────────────────────────

/**
 * A row as returned by `convertRowsToEur`. That module is still JavaScript and
 * types its rows loosely, so the shape is derived from its declaration rather
 * than restated here.
 */
export type ConvertedRow = Awaited<ReturnType<typeof convertRowsToEur>>[number];

export interface PeriodPivotShape {
  idField: string;
  labelField: string;
  idKey: string;
  labelKey: string;
}

/** One entity in a period pivot; `idKey`/`labelKey` carry the identity. */
export type PeriodPivotEntity = {
  total: number;
  transactionCount: number;
  [key: string]: unknown;
};

/** A monthly row aggregated by {@link buildMonthlySummary}. */
export type MonthlySummaryInput = {
  total_spending: DecimalInput;
  total_income: DecimalInput;
  net_amount: DecimalInput;
  transaction_count: number;
  period_start?: string | null;
  period_end?: string | null;
};

/**
 * Shape converted `{ period, <idField>, <labelField>, amount_eur, cnt }` rows
 * into `{ [period]: [{ [idKey], [labelKey], total, transactionCount }] }`,
 * summing absolute EUR per (period, entity), rounding totals to cents, and
 * sorting each period ascending by total. Shared by the recipient and tag
 * period-pivots (SIMP-49).
 */
export function buildPeriodPivot(
  convertedRows: ConvertedRow[],
  { idField, labelField, idKey, labelKey }: PeriodPivotShape,
): Record<string, PeriodPivotEntity[]> {
  const periodMap: Record<string, Record<string, PeriodPivotEntity>> = {};
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

  const pivot: Record<string, PeriodPivotEntity[]> = {};
  for (const [period, entities] of Object.entries(periodMap)) {
    pivot[period] = Object.values(entities)
      .map((e) => ({ ...e, total: roundMoney(e.total) }))
      .sort((a, b) => a.total - b.total);
  }
  return pivot;
}

export function buildMonthlySummary(months: MonthlySummaryInput[]) {
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
 * @returns rows with a numeric `amount` merged in
 */
export function mapRowsForAmountConversion<T extends Record<string, unknown>>(
  rows: T[],
  amountField = "amount",
  fallbackToZero = true,
): Array<Omit<T, "amount"> & { amount: number }> {
  return rows.map((row) => ({
    ...row,
    amount: fallbackToZero
      ? toNumber(toDecimal((row[amountField] as DecimalInput) ?? 0))
      : toNumber(toDecimal(row[amountField] as DecimalInput)),
  }));
}

// ── Category helpers ───────────────────────────────────────────────────────

/**
 * @param categoryId `-1` is the "uncategorised" sentinel.
 */
function getCategoryKey(categoryId: number | string): string {
  return categoryId === -1 ? "null" : String(categoryId);
}

/**
 * @param categoryId A number or numeric string; `-1` is the "uncategorised"
 *   sentinel. `String()` mirrors the coercion `parseInt` applies to a number.
 */
function parseCategoryId(categoryId: number | string): number | null {
  return categoryId === -1 ? null : parseInt(String(categoryId), 10);
}

export interface CategoryTotal {
  id: number | null;
  name: string;
  count: number;
  total: number;
}

export function buildCategoryFromConvertedRows(
  convertedRows: ConvertedRow[],
): CategoryTotal[] {
  const categoryMap = new Map<string, CategoryTotal>();

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
 * @param rows Rows with `amount` + `currency`.
 * @param dateField Date field used for the historical rate lookup.
 * @returns rows with `amount_eur` merged in
 */
export async function convertRowsWithHistoricalRateFallback(
  rows: Array<Record<string, unknown>>,
  targetCurrency: string,
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
 * @param groups - Each group has rows with `amount` + `currency`
 * @param dateField - Date field used for historical rate lookup
 * @returns Converted groups in the same order as input
 */
export async function batchConvertGroupsWithHistoricalRateFallback(
  groups: Array<Array<Record<string, unknown>>>,
  targetCurrency: string,
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
