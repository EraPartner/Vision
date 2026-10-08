/**
 * Per-category forecast breakdown with hierarchical reconciliation.
 *
 * Uses simple-average per category (cheap), then scales each category's
 * forecast so that Σ categories = aggregate reference (simple_avg) for
 * every future date. This ensures bottom-up consistency with the aggregate.
 */

import * as simpleAverage from "./methods/simpleAverage.ts";

export interface CategoryHistoryRow {
  date: string;
  category_id: number | null;
  general: string;
  detail: string;
  path_name?: string;
  net: number;
}

export interface CategoryKey {
  key: string;
  category_id: number | null;
  general: string;
  detail: string;
  path_name: string;
}

export interface SeriesPoint {
  date: string;
  value: number;
}

export interface ActualPoint {
  date: string;
  net: number | null;
  cumulative: number | null;
}

export interface CategoryBreakdownEntry {
  category_id: number | null;
  general: string;
  detail: string;
  path_name: string;
  actual: ActualPoint[];
  forecast: SeriesPoint[];
  cumulative: SeriesPoint[];
}

export function buildCategoryBreakdown({
  historyByCategory,
  currentActualByCategory,
  scheduledActualByCategory = [],
  future,
  all,
  todayDay,
  referenceDaily,
}: {
  historyByCategory: CategoryHistoryRow[];
  currentActualByCategory: CategoryHistoryRow[];
  scheduledActualByCategory?: CategoryHistoryRow[];
  future: string[];
  all: string[];
  todayDay: number;
  /** simple_avg daily from aggregate */
  referenceDaily: SeriesPoint[];
}): CategoryBreakdownEntry[] {
  const categories = extractCategories(
    currentActualByCategory,
    scheduledActualByCategory,
    historyByCategory,
  );

  const refByDate = new Map(referenceDaily.map((p) => [p.date, p.value]));

  const categoryForecasts = categories.map((cat) => {
    const trainHistory = historyByCategory
      .filter((r) => catKey(r) === cat.key)
      .map((r) => ({ date: r.date, net: r.net }));

    const rawSeries =
      trainHistory.length > 0
        ? simpleAverage.forecast({
            history: trainHistory,
            forecastDates: future,
          })
        : future.map((date) => ({ date, value: 0 }));

    const series = rawSeries.map((p) => ({
      date: p.date,
      value: Number.isFinite(p.value) ? p.value : 0,
    }));

    return { cat, series };
  });

  const reconciled = reconcileCategoryForecasts(
    categoryForecasts,
    future,
    refByDate,
  );

  return reconciled.map(({ cat, series }) => {
    const actualByDate = buildActualByDate(
      currentActualByCategory.filter((r) => catKey(r) === cat.key),
      all,
      todayDay,
    );

    const lastActualCum =
      todayDay > 0
        ? (actualByDate.find((r) => r.date === all[todayDay - 1])?.cumulative ??
          0)
        : 0;

    const scheduledByDate = new Map(
      scheduledActualByCategory
        .filter((r) => catKey(r) === cat.key)
        .map((r) => [r.date, r.net]),
    );
    const cumulative = buildCumulative(
      series,
      actualByDate,
      all,
      todayDay,
      lastActualCum,
      scheduledByDate,
    );

    return {
      category_id: cat.category_id,
      general: cat.general,
      detail: cat.detail,
      path_name: cat.path_name,
      actual: actualByDate,
      forecast: series,
      cumulative,
    };
  });
}

// --- helpers ---

function catKey(r: CategoryHistoryRow) {
  // The stable category ID, not a mutable label, owns each forecast series.
  return r.category_id == null ? "uncategorized" : String(r.category_id);
}

function extractCategories(...rowGroups: CategoryHistoryRow[][]): CategoryKey[] {
  const seen = new Map<string, CategoryKey>();
  for (const r of rowGroups.flat()) {
    const k = catKey(r);
    if (!seen.has(k)) {
      seen.set(k, {
        key: k,
        category_id: r.category_id ?? null,
        general: r.general ?? "Uncategorized",
        detail: r.detail ?? "Uncategorized",
        path_name:
          r.path_name ??
          ([r.general, r.detail].filter(Boolean).join(":") || "Uncategorized"),
      });
    }
  }
  return [...seen.values()].sort((a, b) =>
    a.path_name.localeCompare(b.path_name),
  );
}

function reconcileCategoryForecasts(
  categoryForecasts: Array<{ cat: CategoryKey; series: SeriesPoint[] }>,
  future: string[],
  refByDate: Map<string, number>,
): Array<{ cat: CategoryKey; series: SeriesPoint[] }> {
  const sumByDate = new Map<string, number>();
  const totalAbsByDate = new Map<string, number>();
  for (const date of future) {
    let s = 0;
    let absSum = 0;
    for (const { series } of categoryForecasts) {
      const p = series.find((x) => x.date === date);
      const v = p?.value ?? 0;
      s += v;
      absSum += Math.abs(v);
    }
    sumByDate.set(date, s);
    totalAbsByDate.set(date, absSum);
  }

  const catCount = categoryForecasts.length || 1;

  // Additive residual distribution instead of multiplicative ref/sum scaling.
  // Scaling is only valid when components share a sign; category daily nets are
  // mixed-sign (income +, expenses −), so `sum` is a small difference of large
  // numbers and ref/sum is unbounded (and flips sign when sum and ref disagree).
  // Spreading the residual diff = ref − sum proportionally to each category's
  // magnitude keeps Σ categories === ref exactly while bounding each adjustment
  // by |diff| and preserving each component's sign.
  return categoryForecasts.map(({ cat, series }) => ({
    cat,
    series: series.map((p) => {
      const ref = refByDate.get(p.date) ?? 0;
      const sum = sumByDate.get(p.date) ?? 0;
      const totalAbs = totalAbsByDate.get(p.date) ?? 0;
      // eslint-disable-next-line vision-local-money/no-raw-money-arithmetic
      const diff = ref - sum;
      let adjustment: number;
      if (totalAbs > 0) {
        adjustment = diff * (Math.abs(p.value) / totalAbs);
      } else {
        adjustment = diff / catCount;
      }
      return { date: p.date, value: p.value + adjustment };
    }),
  }));
}

function buildActualByDate(
  rows: CategoryHistoryRow[],
  allDates: string[],
  todayDay: number,
): ActualPoint[] {
  const byDate = new Map<string, number>();
  for (const r of rows) byDate.set(r.date, (byDate.get(r.date) ?? 0) + r.net);
  const out: ActualPoint[] = [];
  let cum = 0;
  for (let i = 0; i < allDates.length; i++) {
    const date = allDates[i];
    if (i + 1 > todayDay) {
      out.push({ date, net: null, cumulative: null });
      continue;
    }
    const net = byDate.get(date) ?? 0;
    cum += net;
    out.push({ date, net, cumulative: cum });
  }
  return out;
}

function buildCumulative(
  forecastSeries: SeriesPoint[],
  actualByDate: ActualPoint[],
  allDates: string[],
  todayDay: number,
  lastActualCum: number,
  scheduledByDate: Map<string, number>,
): SeriesPoint[] {
  const actualCumByDate = new Map<string, number>();
  for (const r of actualByDate) {
    if (r.cumulative !== null) actualCumByDate.set(r.date, r.cumulative);
  }
  const forecastByDate = new Map(forecastSeries.map((p) => [p.date, p.value]));
  let cum = lastActualCum;
  return allDates.map((date, i) => {
    if (i + 1 <= todayDay)
      return { date, value: actualCumByDate.get(date) ?? 0 };
    const daily = forecastByDate.get(date) ?? 0;
    cum += daily + (scheduledByDate.get(date) ?? 0);
    return { date, value: cum };
  });
}

export { reconcileCategoryForecasts as __reconcileCategoryForecasts };
