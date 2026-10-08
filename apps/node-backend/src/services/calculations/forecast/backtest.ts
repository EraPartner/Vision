/**
 * Walk-forward backtest harness.
 * For each of the last K months, train each method on history strictly
 * before that month, forecast its days, compare to actual. Report MAE,
 * RMSE, MAPE (on end-of-month cumulative) per method + residual series.
 */

import { densifyDailyHistory } from "./_densify.ts";
import { epochMsToUtcYmd } from "../../../lib/dateFormat.ts";

const DEFAULT_BACKTEST_MONTHS = 12;

// Percentage error is unavailable at or below one hundredth of a reporting
// currency unit. Absolute errors remain meaningful for near-zero net cashflow.
const MIN_PERCENTAGE_ACTUAL = 0.01;

export interface DailyNetPoint {
  date: string;
  net: number;
}

export interface ForecastPoint {
  date: string;
  value: number;
}

export interface BacktestMethod {
  id: string;
  label: string;
  forecast: (ctx: {
    history: DailyNetPoint[];
    forecastDates: string[];
  }) => ForecastPoint[] | { series: ForecastPoint[] };
}

export interface BacktestMonthResult {
  month: string;
  mae: number;
  rmse: number;
  mape: number | null;
  residuals: number[];
  sampleDays: number;
}

export interface BacktestMethodResult {
  id: string;
  label: string;
  perMonth: BacktestMonthResult[];
  aggregate: {
    mae: number;
    rmse: number;
    mape: number | null;
    months: number;
  };
}

export interface RollingBacktestWindowResult {
  window_end: string;
  mae: number;
  rmse: number;
  mape: number | null;
  sampleDays: number;
}

export interface RollingBacktestMethodResult {
  id: string;
  label: string;
  perWindow: RollingBacktestWindowResult[];
  aggregate: {
    mae: number;
    rmse: number;
    mape: number | null;
    windows: number;
  };
}

function addMonths(iso: string, delta: number) {
  const [y, m] = iso.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

function daysInMonth(yyyymm: string) {
  const [y, m] = yyyymm.split("-").map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

function monthDates(yyyymm: string) {
  const n = daysInMonth(yyyymm);
  const out: string[] = [];
  for (let d = 1; d <= n; d++)
    out.push(`${yyyymm}-${String(d).padStart(2, "0")}`);
  return out;
}

function filterHistoryBefore(history: DailyNetPoint[], yyyymm: string) {
  return history.filter((r) => r.date.slice(0, 7) < yyyymm);
}

function actualForMonth(
  history: DailyNetPoint[],
  yyyymm: string,
): DailyNetPoint[] {
  const byDate = new Map<string, number>();
  for (const r of history) {
    if (r.date.slice(0, 7) === yyyymm) {
      byDate.set(r.date, (byDate.get(r.date) ?? 0) + r.net);
    }
  }
  return monthDates(yyyymm).map((date) => ({
    date,
    net: byDate.get(date) ?? 0,
  }));
}

function stats(predictedSeries: ForecastPoint[], actualSeries: DailyNetPoint[]) {
  const n = actualSeries.length;
  let sumAbs = 0;
  let sumSq = 0;
  let cumPred = 0;
  let cumActual = 0;
  const residuals = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    const pred = predictedSeries[i]?.value ?? 0;
    const act = actualSeries[i].net;
    const err = pred - act;
    residuals[i] = err;
    sumAbs += Math.abs(err);
    sumSq += err * err;
    cumPred += pred;
    cumActual += act;
  }
  const mae = n > 0 ? sumAbs / n : 0;
  const rmse = n > 0 ? Math.sqrt(sumSq / n) : 0;
  const mape =
    Math.abs(cumActual) > MIN_PERCENTAGE_ACTUAL + Number.EPSILON
      ? Math.abs(cumPred - cumActual) / Math.abs(cumActual)
      : null;
  return { mae, rmse, mape, residuals, cumPred, cumActual, sampleDays: n };
}

export function walkForwardBacktest({
  history,
  methods,
  asOfMonth,
  windowMonths = DEFAULT_BACKTEST_MONTHS,
}: {
  history: DailyNetPoint[];
  methods: BacktestMethod[];
  asOfMonth: string;
  windowMonths?: number;
}): BacktestMethodResult[] {
  const perMethod = new Map<string, BacktestMethodResult>();
  for (const m of methods) {
    perMethod.set(m.id, {
      id: m.id,
      label: m.label,
      perMonth: [],
      // Placeholder; always overwritten by the aggregation pass below.
      aggregate: { mae: 0, rmse: 0, mape: null, months: 0 },
    });
  }

  for (let k = windowMonths; k >= 1; k--) {
    const targetMonth = addMonths(asOfMonth, -k);
    // Zero-fill the training window (through the last day before targetMonth) so
    // per-DOM means match the live forecast path; otherwise backtest MAE is
    // computed against a differently-biased model than the one shipped.
    const prevMonth = addMonths(targetMonth, -1);
    const trainEnd = `${prevMonth}-${String(daysInMonth(prevMonth)).padStart(2, "0")}`;
    const trainHistory = densifyDailyHistory(
      filterHistoryBefore(history, targetMonth),
      trainEnd,
    );
    if (trainHistory.length === 0) continue;
    const actual = actualForMonth(history, targetMonth);
    const forecastDates = actual.map((a) => a.date);
    if (forecastDates.length === 0) continue;

    for (const method of methods) {
      let predicted: ForecastPoint[];
      try {
        const out = method.forecast({ history: trainHistory, forecastDates });
        predicted = Array.isArray(out) ? out : out.series;
      } catch {
        predicted = forecastDates.map((date) => ({ date, value: 0 }));
      }
      const s = stats(predicted, actual);
      // Every method id was seeded into `perMethod` above.
      perMethod.get(method.id)!.perMonth.push({
        month: targetMonth,
        mae: s.mae,
        rmse: s.rmse,
        mape: s.mape,
        residuals: s.residuals,
        sampleDays: s.sampleDays,
      });
    }
  }

  for (const entry of perMethod.values()) {
    if (entry.perMonth.length === 0) {
      entry.aggregate = { mae: 0, rmse: 0, mape: null, months: 0 };
      continue;
    }
    let mae = 0;
    let rmse = 0;
    let mape = 0;
    let percentageSamples = 0;
    for (const m of entry.perMonth) {
      mae += m.mae;
      rmse += m.rmse;
      if (m.mape !== null) {
        mape += m.mape;
        percentageSamples++;
      }
    }
    const n = entry.perMonth.length;
    entry.aggregate = {
      mae: mae / n,
      rmse: rmse / n,
      mape: percentageSamples ? mape / percentageSamples : null,
      months: n,
    };
  }

  return Array.from(perMethod.values());
}

/**
 * Walk-forward backtest for rolling-window forecasts.
 * Shifts the anchor back by daysForward steps `windowCount` times and evaluates
 * each method's daysForward-day forecast against confirmed actuals.
 */
export function walkForwardBacktestRolling({
  history,
  methods,
  daysBack: _daysBack,
  daysForward,
  windowCount = 8,
}: {
  history: DailyNetPoint[];
  methods: BacktestMethod[];
  daysBack: number;
  daysForward: number;
  windowCount?: number;
}): RollingBacktestMethodResult[] {
  const now = new Date();
  const todayMs = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
  );
  const isoAt = (offset: number) =>
    epochMsToUtcYmd(todayMs + offset * 86_400_000);

  const perMethod = new Map<string, RollingBacktestMethodResult>();
  for (const m of methods) {
    perMethod.set(m.id, {
      id: m.id,
      label: m.label,
      perWindow: [],
      // Placeholder; always overwritten by the aggregation pass below.
      aggregate: { mae: 0, rmse: 0, mape: null, windows: 0 },
    });
  }

  const actualByDate = new Map(history.map((r) => [r.date, r.net]));

  for (let k = 1; k <= windowCount; k++) {
    // "today" for this past window is shifted back k * daysForward from actual today
    const anchorEndOffset = -(k * daysForward);
    const anchorEnd = isoAt(anchorEndOffset);

    const forecastDates: string[] = [];
    for (let d = anchorEndOffset + 1; d <= anchorEndOffset + daysForward; d++) {
      forecastDates.push(isoAt(d));
    }
    if (forecastDates.length === 0) continue;

    // Train on all data up to (and including) anchorEnd, matching live forecast
    // behaviour — zero-filled to a dense daily grid (same as the live path).
    const trainHistory = densifyDailyHistory(
      history.filter((r) => r.date <= anchorEnd),
      anchorEnd,
    );
    if (trainHistory.length === 0) continue;

    const actualSeries = forecastDates.map((date) => ({
      date,
      net: actualByDate.get(date) ?? 0,
    }));

    for (const method of methods) {
      let predicted: ForecastPoint[];
      try {
        const out = method.forecast({ history: trainHistory, forecastDates });
        predicted = Array.isArray(out) ? out : out.series;
      } catch {
        predicted = forecastDates.map((date) => ({ date, value: 0 }));
      }
      const s = stats(predicted, actualSeries);
      perMethod.get(method.id)!.perWindow.push({
        window_end: anchorEnd,
        mae: s.mae,
        rmse: s.rmse,
        mape: s.mape,
        sampleDays: s.sampleDays,
      });
    }
  }

  for (const entry of perMethod.values()) {
    if (entry.perWindow.length === 0) {
      entry.aggregate = { mae: 0, rmse: 0, mape: null, windows: 0 };
      continue;
    }
    let mae = 0,
      rmse = 0,
      mape = 0;
    let percentageSamples = 0;
    for (const w of entry.perWindow) {
      mae += w.mae;
      rmse += w.rmse;
      if (w.mape !== null) {
        mape += w.mape;
        percentageSamples++;
      }
    }
    const n = entry.perWindow.length;
    entry.aggregate = {
      mae: mae / n,
      rmse: rmse / n,
      mape: percentageSamples ? mape / percentageSamples : null,
      windows: n,
    };
  }

  return Array.from(perMethod.values());
}

export default { walkForwardBacktest, walkForwardBacktestRolling };
