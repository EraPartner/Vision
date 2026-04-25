/**
 * Cash flow forecast orchestrator.
 * Assembles actual + per-method forecasts + optional planned overlay +
 * diagnostics for the current month. Methods plug in via registry.
 * Backtest runs on demand; accuracy persisted for future ensemble.
 */

import { infoRepository } from '../../../repositories/infoRepository.js';
import { buildEnvelope } from '../aggregation/_envelope.js';
import { fnv1aHash } from './prng.js';

import * as simpleAverage from './methods/simpleAverage.js';
import * as weightedAverage from './methods/weightedAverage.js';
import * as ewma from './methods/ewma.js';
import * as holtWinters from './methods/holtWinters.js';
import * as prophetLite from './methods/prophetLite.js';
import * as monteCarloParametric from './methods/monteCarloParametric.js';
import * as monteCarloBlockBootstrap from './methods/monteCarloBlockBootstrap.js';
import * as ensemble from './methods/ensemble.js';

import { buildCategoryBreakdown } from './categoryBreakdown.js';
import { walkForwardBacktest } from './backtest.js';
import { recordAccuracy, getLatestAccuracyByMethod } from './accuracyStore.js';
import mcCacheRepo from '../../../repositories/cashflowForecastMcRepository.js';
import { logger } from '../../../config/logger.js';

const DEFAULT_HISTORY_MONTHS = 36;
const DEFAULT_MC_PATHS = 1000;
const DEFAULT_MC_PERCENTILES = [10, 50, 90];

const POINT_METHODS = [simpleAverage, weightedAverage, ewma, holtWinters, prophetLite];
const MC_METHODS = [monteCarloParametric, monteCarloBlockBootstrap];

function currentMonthDates() {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const daysInMonth = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  const todayDay = now.getUTCDate();
  const all = [];
  const future = [];
  for (let d = 1; d <= daysInMonth; d++) {
    const iso = `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    all.push(iso);
    if (d > todayDay) future.push(iso);
  }
  return { all, future, todayDay, daysInMonth, yyyymm: `${y}-${String(m + 1).padStart(2, '0')}` };
}

function actualCumulativeDaily(currentActual, allDates, todayDay) {
  const byDate = new Map(currentActual.map((r) => [r.date, r.net]));
  const out = [];
  let cum = 0;
  for (let i = 0; i < allDates.length; i++) {
    const date = allDates[i];
    const day = i + 1;
    if (day > todayDay) {
      out.push({ date, net: null, cumulative: null });
      continue;
    }
    const net = byDate.get(date) ?? 0;
    cum += net;
    out.push({ date, net, cumulative: cum });
  }
  return out;
}

function plannedDailyMap(plannedCurrent) {
  const map = new Map();
  for (const r of plannedCurrent) map.set(r.date, (map.get(r.date) ?? 0) + r.net);
  return map;
}

function buildSeed({ yyyymm, filterHash }) {
  return fnv1aHash(`${yyyymm}|${filterHash}`);
}

function filterHash({ excludedCategoryIds, excludedRecipientIds, currency, includePlanned }) {
  const cats = [...(excludedCategoryIds ?? [])].sort((a, b) => a - b).join(',');
  const recs = [...(excludedRecipientIds ?? [])].sort((a, b) => a - b).join(',');
  return `${currency}|${cats}|${recs}|${includePlanned ? 1 : 0}`;
}

function isDefaultMcParams(mcPaths, mcPercentiles) {
  if (mcPaths !== DEFAULT_MC_PATHS) return false;
  if (mcPercentiles.length !== DEFAULT_MC_PERCENTILES.length) return false;
  return DEFAULT_MC_PERCENTILES.every((p, i) => p === mcPercentiles[i]);
}

export async function computeCashflowForecast({
  excludedCategoryIds = [],
  excludedRecipientIds = [],
  targetCurrency = 'EUR',
  includePlanned = false,
  historyMonths = DEFAULT_HISTORY_MONTHS,
  mcPaths = DEFAULT_MC_PATHS,
  mcPercentiles = DEFAULT_MC_PERCENTILES,
  includeBacktest = true,
  includeBreakdown = false,
  userId = 'anonymous',
  // Internal flag used by nightly job to bypass cache read and force a cache write.
  _forceCache = false,
} = {}) {
  const { all, future, todayDay, daysInMonth, yyyymm } = currentMonthDates();
  const hash = filterHash({ excludedCategoryIds, excludedRecipientIds, currency: targetCurrency, includePlanned });

  // Try cache when not forcing a refresh and using default MC params.
  if (!_forceCache && isDefaultMcParams(mcPaths, mcPercentiles)) {
    try {
      const cached = await mcCacheRepo.get({ userId, month: yyyymm, filterHash: hash });
      // Don't serve a diagnostics-free cache entry when backtest is needed.
      const diagnosticsOk = !includeBacktest || cached?.payload?.diagnostics != null;
      if (cached && mcCacheRepo.isFresh(cached.computed_at) && diagnosticsOk) {
        if (includeBreakdown) {
          // Reconstruct effective values from the cached payload's actual array.
          const cachedActualCount = cached.payload.actual.filter((r) => r.cumulative !== null).length;
          const cachedEffectiveTodayDay = cachedActualCount > 0 ? todayDay : 0;
          const cachedEffectiveFuture = cachedEffectiveTodayDay === 0 ? all : future;
          const payload = await augmentPayloadWithBreakdown(cached.payload, {
            excludedCategoryIds, excludedRecipientIds, targetCurrency,
            historyMonths, all, future: cachedEffectiveFuture, todayDay: cachedEffectiveTodayDay,
          });
          return buildEnvelope(payload, { source: 'cache', computedAt: cached.computed_at });
        }
        return buildEnvelope(cached.payload, { source: 'cache', computedAt: cached.computed_at });
      }
    } catch (err) {
      logger.warn('Cashflow forecast MC cache read failed, computing live', { error: err.message });
    }
  }

  const {
    history,
    currentActual,
    plannedCurrent,
  } = await infoRepository.getCashflowForecastData(
    historyMonths,
    excludedCategoryIds,
    excludedRecipientIds,
    targetCurrency
  );

  const seed = buildSeed({ yyyymm, filterHash: hash });

  // When no current-month data imported, forecast the full month instead of only remaining days.
  const effectiveTodayDay = currentActual.length > 0 ? todayDay : 0;
  const effectiveFuture = effectiveTodayDay === 0 ? all : future;

  const actualDaily = actualCumulativeDaily(currentActual, all, effectiveTodayDay);
  const plannedMap = plannedDailyMap(plannedCurrent);

  // Forecast history: historical net + actual-so-far this month (so methods see the latest signal).
  const trainHistory = history.concat(
    currentActual.filter((r) => {
      const day = Number(r.date.slice(8, 10));
      return day <= todayDay;
    })
  );

  const methodOutputs = [];
  for (const mod of POINT_METHODS) {
    try {
      const series = mod.forecast({ history: trainHistory, forecastDates: effectiveFuture });
      methodOutputs.push({
        id: mod.id,
        label: mod.label,
        series: series.map((p) => ({ ...p, value: Number.isFinite(p.value) ? p.value : 0 })),
      });
    } catch {
      methodOutputs.push({
        id: mod.id,
        label: mod.label,
        series: effectiveFuture.map((date) => ({ date, value: 0 })),
        error: 'forecast_failed',
      });
    }
  }

  // Ensemble: inverse-MSE weighted combination of point methods.
  // Weights derived from persisted accuracy; falls back to equal weights.
  try {
    let accuracyRows = [];
    try {
      accuracyRows = await getLatestAccuracyByMethod({ userId });
    } catch {
      // DB unavailable — equal-weight fallback
    }
    const weights = ensemble.computeWeights(accuracyRows, POINT_METHODS.map((m) => m.id));
    const ensembleSeries = ensemble.forecast({
      forecastDates: effectiveFuture,
      methodOutputs: methodOutputs.filter((m) => !m.error),
      weights,
    });
    methodOutputs.push({ id: ensemble.id, label: ensemble.label, series: ensembleSeries });
  } catch {
    methodOutputs.push({
      id: ensemble.id,
      label: ensemble.label,
      series: effectiveFuture.map((date) => ({ date, value: 0 })),
      error: 'forecast_failed',
    });
  }

  for (const mod of MC_METHODS) {
    try {
      const out = mod.forecast({
        history: trainHistory,
        forecastDates: effectiveFuture,
        paths: mcPaths,
        percentiles: mcPercentiles,
        seed,
      });
      methodOutputs.push({
        id: mod.id,
        label: mod.label,
        series: out.series,
        bands: out.bands,
      });
    } catch {
      methodOutputs.push({
        id: mod.id,
        label: mod.label,
        series: effectiveFuture.map((date) => ({ date, value: 0 })),
        error: 'forecast_failed',
      });
    }
  }

  // Fold actual-to-date into each method's cumulative series.
  const actualCumByDate = new Map(actualDaily.filter((r) => r.cumulative !== null).map((r) => [r.date, r.cumulative]));
  const lastActualCum = effectiveTodayDay > 0 ? (actualCumByDate.get(all[effectiveTodayDay - 1]) ?? 0) : 0;

  const cumulativeFor = (dailySeries) => {
    const out = [];
    let cum = lastActualCum;
    const byDate = new Map(dailySeries.map((p) => [p.date, p.value]));
    for (let i = 0; i < all.length; i++) {
      const date = all[i];
      if (i + 1 <= effectiveTodayDay) {
        out.push({ date, value: actualCumByDate.get(date) ?? 0 });
        continue;
      }
      const daily = byDate.get(date) ?? 0;
      const plannedAdd = includePlanned ? plannedMap.get(date) ?? 0 : 0;
      cum += daily + plannedAdd;
      out.push({ date, value: cum });
    }
    return out;
  };

  const methods = methodOutputs.map((m) => ({
    id: m.id,
    label: m.label,
    daily: m.series,
    cumulative: cumulativeFor(m.series),
    bands: m.bands ?? null,
    error: m.error ?? null,
  }));

  let diagnostics = null;
  if (includeBacktest) {
    const backtestMethods = [...POINT_METHODS, ...MC_METHODS].map((mod) => ({
      id: mod.id,
      label: mod.label,
      forecast: (ctx) => {
        const out = mod.forecast({ ...ctx, seed });
        return Array.isArray(out) ? out : out.series;
      },
    }));
    const backtest = walkForwardBacktest({
      history: trainHistory,
      methods: backtestMethods,
      asOfMonth: yyyymm,
    });
    diagnostics = {
      history_months: historyMonths,
      backtest: backtest.map((b) => ({
        method_id: b.id,
        label: b.label,
        mae: b.aggregate.mae,
        rmse: b.aggregate.rmse,
        mape: b.aggregate.mape,
        months: b.aggregate.months,
        per_month: b.perMonth.map(({ month, mae, rmse, mape, sampleDays }) => ({
          month,
          mae,
          rmse,
          mape,
          sample_days: sampleDays,
        })),
      })),
    };
    await Promise.all(backtest.map((b) => recordAccuracy({
      userId,
      methodId: b.id,
      asOfMonth: yyyymm,
      mae: b.aggregate.mae,
      rmse: b.aggregate.rmse,
      mape: b.aggregate.mape,
      sampleDays: b.perMonth.reduce((s, r) => s + r.sampleDays, 0),
    })));
  }

  const basePayload = {
    month: yyyymm,
    currency: targetCurrency,
    days_in_month: daysInMonth,
    current_day: todayDay,
    actual: actualDaily,
    planned: Array.from(plannedMap, ([date, net]) => ({ date, net })).sort((a, b) =>
      a.date.localeCompare(b.date)
    ),
    methods,
    diagnostics,
    history_months: historyMonths,
    include_planned: includePlanned,
  };

  // Write to cache whenever default MC params used (nightly job + any live compute).
  // Cache stores the base payload without breakdown (breakdown is always computed on demand).
  if (isDefaultMcParams(mcPaths, mcPercentiles)) {
    mcCacheRepo.upsert({ userId, month: yyyymm, filterHash: hash, mcPaths, payload: basePayload }).catch((err) => {
      logger.warn('Cashflow forecast MC cache write failed', { error: err.message });
    });
  }

  let payload = basePayload;
  if (includeBreakdown) {
    payload = await augmentPayloadWithBreakdown(basePayload, {
      excludedCategoryIds, excludedRecipientIds, targetCurrency,
      historyMonths, all, future: effectiveFuture, todayDay: effectiveTodayDay,
    });
  }

  return buildEnvelope(payload, { source: 'live' });
}

/**
 * Fetch category-level data and append `category_breakdown` to an existing payload.
 * Used both for cache-hit augmentation and live-compute augmentation.
 */
async function augmentPayloadWithBreakdown(payload, {
  excludedCategoryIds, excludedRecipientIds, targetCurrency,
  historyMonths, all, future, todayDay,
}) {
  const referenceMethod = payload.methods.find((m) => m.id === simpleAverage.id);
  const referenceDaily = referenceMethod?.daily ?? future.map((date) => ({ date, value: 0 }));

  const { historyByCategory, currentActualByCategory } =
    await infoRepository.getCashflowForecastDataByCategory(
      historyMonths,
      excludedCategoryIds,
      excludedRecipientIds,
      targetCurrency,
    );

  const categoryBreakdown = buildCategoryBreakdown({
    historyByCategory,
    currentActualByCategory,
    future,
    all,
    todayDay,
    referenceDaily,
  });

  return { ...payload, category_breakdown: categoryBreakdown };
}

export default { computeCashflowForecast };
