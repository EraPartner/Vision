/**
 * Walk-forward backtest harness.
 * For each of the last K months, train each method on history strictly
 * before that month, forecast its days, compare to actual. Report MAE,
 * RMSE, MAPE (on end-of-month cumulative) per method + residual series.
 */

const DEFAULT_BACKTEST_MONTHS = 12;

function addMonths(iso, delta) {
  const [y, m] = iso.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function daysInMonth(yyyymm) {
  const [y, m] = yyyymm.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

function monthDates(yyyymm) {
  const n = daysInMonth(yyyymm);
  const out = [];
  for (let d = 1; d <= n; d++) out.push(`${yyyymm}-${String(d).padStart(2, '0')}`);
  return out;
}

function filterHistoryBefore(history, yyyymm) {
  return history.filter((r) => r.date.slice(0, 7) < yyyymm);
}

function actualForMonth(history, yyyymm) {
  const byDate = new Map();
  for (const r of history) {
    if (r.date.slice(0, 7) === yyyymm) {
      byDate.set(r.date, (byDate.get(r.date) ?? 0) + r.net);
    }
  }
  return monthDates(yyyymm).map((date) => ({ date, net: byDate.get(date) ?? 0 }));
}

function stats(predictedSeries, actualSeries) {
  const n = actualSeries.length;
  let sumAbs = 0;
  let sumSq = 0;
  let cumPred = 0;
  let cumActual = 0;
  const residuals = new Array(n);
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
  const mape = Math.abs(cumActual) > 1e-9 ? Math.abs(cumPred - cumActual) / Math.abs(cumActual) : 0;
  return { mae, rmse, mape, residuals, cumPred, cumActual, sampleDays: n };
}

/**
 * @param {{
 *   history: Array<{date: string, net: number}>,
 *   methods: Array<{id: string, label: string, forecast: Function}>,
 *   asOfMonth: string,
 *   windowMonths?: number,
 * }} ctx
 */
export function walkForwardBacktest({ history, methods, asOfMonth, windowMonths = DEFAULT_BACKTEST_MONTHS }) {
  const perMethod = new Map();
  for (const m of methods) {
    perMethod.set(m.id, { id: m.id, label: m.label, perMonth: [], aggregate: null });
  }

  for (let k = windowMonths; k >= 1; k--) {
    const targetMonth = addMonths(asOfMonth, -k);
    const trainHistory = filterHistoryBefore(history, targetMonth);
    if (trainHistory.length === 0) continue;
    const actual = actualForMonth(history, targetMonth);
    const forecastDates = actual.map((a) => a.date);
    if (forecastDates.length === 0) continue;

    for (const method of methods) {
      let predicted;
      try {
        const out = method.forecast({ history: trainHistory, forecastDates });
        predicted = Array.isArray(out) ? out : out.series;
      } catch {
        predicted = forecastDates.map((date) => ({ date, value: 0 }));
      }
      const s = stats(predicted, actual);
      perMethod.get(method.id).perMonth.push({
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
      entry.aggregate = { mae: 0, rmse: 0, mape: 0, months: 0 };
      continue;
    }
    let mae = 0;
    let rmse = 0;
    let mape = 0;
    for (const m of entry.perMonth) {
      mae += m.mae;
      rmse += m.rmse;
      mape += m.mape;
    }
    const n = entry.perMonth.length;
    entry.aggregate = { mae: mae / n, rmse: rmse / n, mape: mape / n, months: n };
  }

  return Array.from(perMethod.values());
}

export default { walkForwardBacktest };
