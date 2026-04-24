/**
 * Per-category forecast breakdown with hierarchical reconciliation.
 *
 * Uses simple-average per category (cheap), then scales each category's
 * forecast so that Σ categories = aggregate reference (simple_avg) for
 * every future date. This ensures bottom-up consistency with the aggregate.
 */

import * as simpleAverage from './methods/simpleAverage.js';

/**
 * @param {{
 *   historyByCategory:       Array<{ date: string, category_id: number|null, general: string, detail: string, net: number }>,
 *   currentActualByCategory: Array<{ date: string, category_id: number|null, general: string, detail: string, net: number }>,
 *   future:        string[],
 *   all:           string[],
 *   todayDay:      number,
 *   referenceDaily: Array<{ date: string, value: number }>, // simple_avg daily from aggregate
 * }} args
 * @returns {Array<{
 *   category_id: number|null,
 *   general: string,
 *   detail: string,
 *   actual: Array<{ date: string, net: number|null, cumulative: number|null }>,
 *   forecast: Array<{ date: string, value: number }>,
 *   cumulative: Array<{ date: string, value: number }>,
 * }>}
 */
export function buildCategoryBreakdown({
  historyByCategory,
  currentActualByCategory,
  future,
  all,
  todayDay,
  referenceDaily,
}) {
  const categories = extractCategories(historyByCategory, currentActualByCategory);

  const refByDate = new Map(referenceDaily.map((p) => [p.date, p.value]));

  const categoryForecasts = categories.map((cat) => {
    const trainHistory = historyByCategory
      .filter((r) => catKey(r) === cat.key)
      .map((r) => ({ date: r.date, net: r.net }));

    const rawSeries =
      trainHistory.length > 0
        ? simpleAverage.forecast({ history: trainHistory, forecastDates: future })
        : future.map((date) => ({ date, value: 0 }));

    const series = rawSeries.map((p) => ({
      date: p.date,
      value: Number.isFinite(p.value) ? p.value : 0,
    }));

    return { cat, series };
  });

  const reconciled = reconcileCategoryForecasts(categoryForecasts, future, refByDate);

  return reconciled.map(({ cat, series }) => {
    const actualByDate = buildActualByDate(
      currentActualByCategory.filter((r) => catKey(r) === cat.key),
      all,
      todayDay,
    );

    const lastActualCum =
      todayDay > 0
        ? (actualByDate.find((r) => r.date === all[todayDay - 1])?.cumulative ?? 0)
        : 0;

    const cumulative = buildCumulative(series, actualByDate, all, todayDay, lastActualCum);

    return {
      category_id: cat.category_id,
      general: cat.general,
      detail: cat.detail,
      actual: actualByDate,
      forecast: series,
      cumulative,
    };
  });
}

// --- helpers ---

function catKey(r) {
  return `${r.category_id ?? 'null'}|${r.general}|${r.detail}`;
}

function extractCategories(historyRows, actualRows) {
  const seen = new Map();
  for (const r of [...historyRows, ...actualRows]) {
    const k = catKey(r);
    if (!seen.has(k)) {
      seen.set(k, {
        key: k,
        category_id: r.category_id ?? null,
        general: r.general ?? 'Uncategorized',
        detail: r.detail ?? 'Uncategorized',
      });
    }
  }
  return [...seen.values()].sort((a, b) => a.general.localeCompare(b.general) || a.detail.localeCompare(b.detail));
}

export function reconcileCategoryForecasts(categoryForecasts, future, refByDate) {
  const sumByDate = new Map();
  for (const date of future) {
    let s = 0;
    for (const { series } of categoryForecasts) {
      const p = series.find((x) => x.date === date);
      s += p?.value ?? 0;
    }
    sumByDate.set(date, s);
  }

  return categoryForecasts.map(({ cat, series }) => ({
    cat,
    series: series.map((p) => {
      const sum = sumByDate.get(p.date) ?? 0;
      const ref = refByDate.get(p.date) ?? 0;
      const scale = sum !== 0 ? ref / sum : 1;
      return { date: p.date, value: p.value * scale };
    }),
  }));
}

function buildActualByDate(rows, allDates, todayDay) {
  const byDate = new Map();
  for (const r of rows) byDate.set(r.date, (byDate.get(r.date) ?? 0) + r.net);
  const out = [];
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

function buildCumulative(forecastSeries, actualByDate, allDates, todayDay, lastActualCum) {
  const actualCumByDate = new Map(
    actualByDate.filter((r) => r.cumulative !== null).map((r) => [r.date, r.cumulative]),
  );
  const forecastByDate = new Map(forecastSeries.map((p) => [p.date, p.value]));
  let cum = lastActualCum;
  return allDates.map((date, i) => {
    if (i + 1 <= todayDay) return { date, value: actualCumByDate.get(date) ?? 0 };
    const daily = forecastByDate.get(date) ?? 0;
    cum += daily;
    return { date, value: cum };
  });
}
