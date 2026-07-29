/**
 * Cash flow forecast orchestrator.
 * Assembles actual + per-method forecasts + optional planned overlay +
 * diagnostics for the current month. Methods plug in via registry.
 * Backtest runs on demand; accuracy persisted for future ensemble.
 */

import { infoRepository } from '../../../repositories/infoRepository.js';
import { buildEnvelope } from '../aggregation/_envelope.js';
import { fnv1aHash } from './prng.js';
import { densifyDailyHistory } from './_densify.js';

import * as simpleAverage from './methods/simpleAverage.js';
import * as weightedAverage from './methods/weightedAverage.js';
import * as ewma from './methods/ewma.js';
import * as holtWinters from './methods/holtWinters.js';
import * as prophetLite from './methods/prophetLite.js';
import * as monteCarloParametric from './methods/monteCarloParametric.js';
import * as monteCarloBlockBootstrap from './methods/monteCarloBlockBootstrap.js';
import * as ensemble from './methods/ensemble.js';

import { buildCategoryBreakdown } from './categoryBreakdown.js';
import { walkForwardBacktest, walkForwardBacktestRolling } from './backtest.js';
import { recordAccuracy, getLatestAccuracyByMethod } from './accuracyStore.js';
import mcCacheRepo from '../../../repositories/cashflowForecastMcRepository.js';
import mcRollingCacheRepo from '../../../repositories/cashflowForecastMcRollingRepository.js';
import { logger } from '../../../config/logger.js';
import { todayAppDateString } from '../../../lib/timezone.js';
import { epochMsToUtcYmd } from '../../../lib/dateFormat.js';

const DEFAULT_HISTORY_MONTHS = 36;
const DEFAULT_MC_PATHS = 1000;
const DEFAULT_MC_PERCENTILES = [10, 50, 90];
const DEFAULT_ROLLING_MC_PATHS = 500;
const DEFAULT_ROLLING_MC_PERCENTILES = [25, 75];

/**
 * @typedef {{date: string, net: number}} DailyNetPoint
 * @typedef {{date: string, value: number}} ForecastPoint
 * @typedef {{date: string, net: number|null, cumulative: number|null}} ActualPoint
 * @typedef {{date: string, value: number}} CumulativePoint
 *
 * A point-estimate method module (methods/simpleAverage.js etc.) — forecast()
 * always returns the series array directly.
 * @typedef {{
 *   id: string,
 *   label: string,
 *   forecast: (ctx: { history: DailyNetPoint[], forecastDates: string[] }) => ForecastPoint[],
 * }} PointMethodModule
 *
 * A Monte Carlo method module (methods/monteCarlo*.js) — forecast() always
 * returns { series, bands }.
 * @typedef {{
 *   id: string,
 *   label: string,
 *   forecast: (ctx: {
 *     history: DailyNetPoint[],
 *     forecastDates: string[],
 *     paths?: number,
 *     percentiles?: number[],
 *     seed?: number|string,
 *   }) => { series: ForecastPoint[], bands: Record<string, ForecastPoint[]> },
 * }} McMethodModule
 *
 * One method's output as assembled by `runForecastEngine`, pre-cumulative-fold.
 * @typedef {{
 *   id: string,
 *   label: string,
 *   series: ForecastPoint[],
 *   bands?: Record<string, ForecastPoint[]>,
 *   error?: string,
 * }} MethodOutput
 *
 * One method's output as it appears in the final response payload
 * (post-cumulative-fold, `runForecastEngine`'s `methods` return field).
 * @typedef {{
 *   id: string,
 *   label: string,
 *   daily: ForecastPoint[],
 *   cumulative: CumulativePoint[],
 *   bands: Record<string, ForecastPoint[]> | null,
 *   error: string | null,
 * }} MethodResult
 *
 * @typedef {{
 *   history_months: number,
 *   backtest: Array<{
 *     method_id: string,
 *     label: string,
 *     mae: number,
 *     rmse: number,
 *     mape: number,
 *     months: number,
 *     per_month: Array<{ month: string, mae: number, rmse: number, mape: number, sample_days: number }>,
 *   }>,
 * }} DiagnosticsPayload
 *
 * Response payload shape for `computeCashflowForecast`, matching both a
 * freshly-built `basePayload` and a cache-read `cached.payload` (the cache
 * repo's JSDoc types the column as bare `object` — this is what's actually
 * stored/read).
 * @typedef {{
 *   month: string,
 *   currency: string,
 *   days_in_month: number,
 *   current_day: number,
 *   actual: ActualPoint[],
 *   planned: DailyNetPoint[],
 *   methods: MethodResult[],
 *   diagnostics: DiagnosticsPayload | null,
 *   history_months: number,
 *   include_planned: boolean,
 *   category_breakdown?: unknown,
 * }} ForecastPayload
 */

/** @type {PointMethodModule[]} */
const POINT_METHODS = [simpleAverage, weightedAverage, ewma, holtWinters, prophetLite];
/** @type {McMethodModule[]} */
const MC_METHODS = [monteCarloParametric, monteCarloBlockBootstrap];

function currentMonthDates() {
  // App-timezone today (ADR-009) — the UTC calendar day put the actuals /
  // forecast split on yesterday between local midnight and 01:00/02:00.
  const todayYmd = todayAppDateString();
  const y = Number(todayYmd.slice(0, 4));
  const m = Number(todayYmd.slice(5, 7)) - 1;
  const daysInMonth = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  const todayDay = Number(todayYmd.slice(8, 10));
  const all = [];
  const future = [];
  for (let d = 1; d <= daysInMonth; d++) {
    const iso = `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    all.push(iso);
    if (d > todayDay) future.push(iso);
  }
  return { all, future, todayDay, daysInMonth, yyyymm: `${y}-${String(m + 1).padStart(2, '0')}` };
}

/**
 * @param {DailyNetPoint[]} currentActual
 * @param {string[]} allDates
 * @param {number} todayIndex
 * @returns {ActualPoint[]}
 */
function actualCumulativeDaily(currentActual, allDates, todayIndex) {
  // todayIndex is 1-based count of past+today entries in allDates.
  // Indices < todayIndex carry actuals; indices >= todayIndex are future (null).
  const byDate = new Map(currentActual.map((r) => [r.date, r.net]));
  /** @type {ActualPoint[]} */
  const out = [];
  let cum = 0;
  for (let i = 0; i < allDates.length; i++) {
    const date = allDates[i];
    if (i + 1 > todayIndex) {
      out.push({ date, net: null, cumulative: null });
      continue;
    }
    const net = byDate.get(date) ?? 0;
    cum += net;
    out.push({ date, net, cumulative: cum });
  }
  return out;
}

/**
 * @param {number} daysBack
 * @param {number} daysForward
 */
function rollingWindowDates(daysBack, daysForward) {
  // Builds a date list spanning [today - daysBack ... today + daysForward].
  // Anchored on the app-timezone today (ADR-009); pure calendar math after.
  const todayYmd = todayAppDateString();
  const [ty, tm, td] = todayYmd.split('-').map(Number);
  const todayMs = Date.UTC(ty, tm - 1, td);
  const all = [];
  for (let offset = -daysBack; offset <= daysForward; offset++) {
    const ms = todayMs + offset * 86_400_000;
    all.push(epochMsToUtcYmd(ms));
  }
  const todayIndex = daysBack + 1;
  const future = all.slice(todayIndex);
  const todayIso = all[todayIndex - 1];
  return { all, future, todayIndex, todayIso };
}

/**
 * Runs the 8-method forecast pipeline against an arbitrary anchor + forecast window.
 * Pure orchestration: assumes data is already fetched. Returns method outputs
 * with cumulative folded against actuals + planned overlay.
 *
 * @param {{
 *   history: DailyNetPoint[],
 *   currentActual: DailyNetPoint[],
 *   plannedCurrent: DailyNetPoint[],
 *   all: string[],
 *   future: string[],
 *   todayIndex: number,
 *   todayIso: string,
 *   includePlanned: boolean,
 *   mcPaths: number,
 *   mcPercentiles: number[],
 *   seed: number|string,
 *   userId: string,
 * }} ctx
 * @returns {Promise<{ actualDaily: ActualPoint[], methods: MethodResult[], planned: DailyNetPoint[], trainHistory: DailyNetPoint[] }>}
 */
async function runForecastEngine({
  history,
  currentActual,
  plannedCurrent,
  all,
  future,
  todayIndex,
  todayIso,
  includePlanned,
  mcPaths,
  mcPercentiles,
  seed,
  userId,
}) {
  const actualDaily = actualCumulativeDaily(currentActual, all, todayIndex);
  const plannedMap = plannedDailyMap(plannedCurrent);

  // Methods see all confirmed actuals (history + currentActual on/before today),
  // zero-filled to a dense daily grid through today so per-DOM means divide by
  // month count, not by the count of days that happened to have a transaction.
  const trainHistory = densifyDailyHistory(
    history.concat(currentActual.filter((r) => r.date <= todayIso)),
    todayIso,
  );

  /** @type {MethodOutput[]} */
  const methodOutputs = [];
  for (const mod of POINT_METHODS) {
    try {
      const series = mod.forecast({ history: trainHistory, forecastDates: future });
      methodOutputs.push({
        id: mod.id,
        label: mod.label,
        series: series.map((p) => ({ ...p, value: Number.isFinite(p.value) ? p.value : 0 })),
      });
    } catch {
      methodOutputs.push({
        id: mod.id,
        label: mod.label,
        series: future.map((date) => ({ date, value: 0 })),
        error: 'forecast_failed',
      });
    }
  }

  // Ensemble: inverse-MSE weighted combination of point methods.
  try {
    /**
     * @type {Array<
     *   import('../../../repositories/cashflowForecastAccuracyRepository.js').AccuracyRow
     *   | import('./accuracyStore.js').FallbackAccuracyRow
     * >}
     */
    let accuracyRows = [];
    try {
      accuracyRows = await getLatestAccuracyByMethod({ userId });
    } catch {
      // DB unavailable — equal-weight fallback
    }
    // NOTE (surfaced by typing, not fixed here — see accuracyStore.js's
    // FallbackAccuracyRow doc comment): the real DB path returns snake_case
    // rows (method_id/sample_days) but ensemble.computeWeights reads
    // camelCase (methodId/sampleDays). `r.methodId` is therefore always
    // `undefined` for DB-backed rows, `methodIds.includes(undefined)` is
    // always false, `rows` in computeWeights ends up empty, and it always
    // returns the equal-weight fallback Map — the persisted-accuracy
    // weighting this pipeline exists for never actually activates outside
    // the (differently-shaped) in-memory fallback path. Cast below preserves
    // current behavior; see report for the fix.
    const weights = ensemble.computeWeights(
      /** @type {Array<{methodId: string, rmse: number, sampleDays?: number}>} */ (accuracyRows),
      POINT_METHODS.map((m) => m.id),
    );
    const ensembleSeries = ensemble.forecast({
      forecastDates: future,
      methodOutputs: methodOutputs.filter((m) => !m.error),
      weights,
    });
    methodOutputs.push({ id: ensemble.id, label: ensemble.label, series: ensembleSeries });
  } catch {
    methodOutputs.push({
      id: ensemble.id,
      label: ensemble.label,
      series: future.map((date) => ({ date, value: 0 })),
      error: 'forecast_failed',
    });
  }

  for (const mod of MC_METHODS) {
    try {
      const out = mod.forecast({
        history: trainHistory,
        forecastDates: future,
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
        series: future.map((date) => ({ date, value: 0 })),
        error: 'forecast_failed',
      });
    }
  }

  // Fold actual-to-date into each method's cumulative series.
  /** @type {Map<string, number>} */
  const actualCumByDate = new Map(
    actualDaily
      .filter((r) => r.cumulative !== null)
      .map((r) => [r.date, /** @type {number} */ (r.cumulative)]),
  );
  const lastActualCum = todayIndex > 0 ? (actualCumByDate.get(all[todayIndex - 1]) ?? 0) : 0;

  /**
   * @param {ForecastPoint[]} dailySeries
   * @returns {CumulativePoint[]}
   */
  const cumulativeFor = (dailySeries) => {
    /** @type {CumulativePoint[]} */
    const out = [];
    let cum = lastActualCum;
    const byDate = new Map(dailySeries.map((p) => [p.date, p.value]));
    for (let i = 0; i < all.length; i++) {
      const date = all[i];
      if (i + 1 <= todayIndex) {
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

  const planned = Array.from(plannedMap, ([date, net]) => ({ date, net })).sort((a, b) =>
    a.date.localeCompare(b.date),
  );

  return { actualDaily, methods, planned, trainHistory };
}

/**
 * @param {DailyNetPoint[]} plannedCurrent
 * @returns {Map<string, number>}
 */
function plannedDailyMap(plannedCurrent) {
  /** @type {Map<string, number>} */
  const map = new Map();
  for (const r of plannedCurrent) map.set(r.date, (map.get(r.date) ?? 0) + r.net);
  return map;
}

/** @param {{ yyyymm: string, filterHash: string }} args */
function buildSeed({ yyyymm, filterHash }) {
  return fnv1aHash(`${yyyymm}|${filterHash}`);
}

// historyMonths is part of the key: isDefaultMcParams guards mcPaths and
// mcPercentiles, but nothing else guarded historyMonths — a request with
// history_months=120 happily got a cached 36-month forecast served back, and
// a non-default history cached under the same key, colliding both directions.
//
// includeTransfers (ADR-083) is part of the key for the same reason: the
// forecast repositories now apply the transfer predicate, so the setting
// changes the numbers. Without it in the hash, toggling the setting kept
// serving the pre-toggle forecast for the cache's 6h TTL — and the two answers
// differ in polarity, not just magnitude, when transfers dominate the ledger.
/**
 * @param {{ excludedCategoryIds?: number[], excludedRecipientIds?: number[],
 *   currency: string, includePlanned: boolean, historyMonths: number,
 *   includeTransfers: boolean }} input
 * @returns {string}
 */
function filterHash({ excludedCategoryIds, excludedRecipientIds, currency, includePlanned, historyMonths, includeTransfers }) {
  const cats = [...(excludedCategoryIds ?? [])].sort((a, b) => a - b).join(',');
  const recs = [...(excludedRecipientIds ?? [])].sort((a, b) => a - b).join(',');
  return `${currency}|${cats}|${recs}|${includePlanned ? 1 : 0}|h${historyMonths}|t${includeTransfers ? 1 : 0}`;
}

/**
 * @param {number} mcPaths
 * @param {number[]} mcPercentiles
 */
function isDefaultMcParams(mcPaths, mcPercentiles) {
  if (mcPaths !== DEFAULT_MC_PATHS) return false;
  if (mcPercentiles.length !== DEFAULT_MC_PERCENTILES.length) return false;
  return DEFAULT_MC_PERCENTILES.every((p, i) => p === mcPercentiles[i]);
}

/**
 * @param {number} mcPaths
 * @param {number[]} mcPercentiles
 */
function isDefaultRollingMcParams(mcPaths, mcPercentiles) {
  if (mcPaths !== DEFAULT_ROLLING_MC_PATHS) return false;
  if (mcPercentiles.length !== DEFAULT_ROLLING_MC_PERCENTILES.length) return false;
  return DEFAULT_ROLLING_MC_PERCENTILES.every((p, i) => p === mcPercentiles[i]);
}

/**
 * @param {{
 *   excludedCategoryIds?: number[],
 *   excludedRecipientIds?: number[],
 *   targetCurrency?: string,
 *   includePlanned?: boolean,
 *   historyMonths?: number,
 *   mcPaths?: number,
 *   mcPercentiles?: number[],
 *   includeBacktest?: boolean,
 *   includeBreakdown?: boolean,
 *   userId?: string,
 *   _forceCache?: boolean,
 * }} [opts]
 */
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
  // Read before the cache probe: the setting is a cache-key input (ADR-083).
  const includeTransfers = await infoRepository.getIncludeTransfers();
  const hash = filterHash({ excludedCategoryIds, excludedRecipientIds, currency: targetCurrency, includePlanned, historyMonths, includeTransfers });

  // Try cache when not forcing a refresh and using default MC params.
  if (!_forceCache && isDefaultMcParams(mcPaths, mcPercentiles)) {
    try {
      const cachedRaw = await mcCacheRepo.get({ userId, month: yyyymm, filterHash: hash });
      // mcCacheRepo types the stored column as bare `object` (repository.js is
      // out of this slice's scope); cast to the real payload shape it's always
      // written as (see basePayload below) rather than widen the repo's type.
      const cached = /** @type {{ payload: ForecastPayload, computed_at: Date } | null} */ (cachedRaw);
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
  const todayIso = effectiveTodayDay > 0 ? all[effectiveTodayDay - 1] : '';

  const { actualDaily, methods, planned: plannedArr, trainHistory } = await runForecastEngine({
    history,
    currentActual,
    plannedCurrent,
    all,
    future: effectiveFuture,
    todayIndex: effectiveTodayDay,
    todayIso,
    includePlanned,
    mcPaths,
    mcPercentiles,
    seed,
    userId,
  });

  let diagnostics = null;
  if (includeBacktest) {
    /** @type {import('./backtest.js').BacktestMethod[]} */
    const backtestMethods = [...POINT_METHODS, ...MC_METHODS].map((mod) => ({
      id: mod.id,
      label: mod.label,
      /** @param {{history: DailyNetPoint[], forecastDates: string[]}} ctx */
      forecast: (ctx) => {
        const fullCtx = { ...ctx, seed };
        const out = mod.forecast(fullCtx);
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
        per_month: b.perMonth.map(
          (/** @type {{ month: string, mae: number, rmse: number, mape: number, sampleDays: number }} */ { month, mae, rmse, mape, sampleDays }) => ({
            month,
            mae,
            rmse,
            mape,
            sample_days: sampleDays,
          }),
        ),
      })),
    };
    await Promise.all(backtest.map((b) => recordAccuracy({
      userId,
      methodId: b.id,
      asOfMonth: yyyymm,
      mae: b.aggregate.mae,
      rmse: b.aggregate.rmse,
      mape: b.aggregate.mape,
      sampleDays: b.perMonth.reduce((/** @type {number} */ s, /** @type {{ sampleDays: number }} */ r) => s + r.sampleDays, 0),
    })));
  }

  const basePayload = {
    month: yyyymm,
    currency: targetCurrency,
    days_in_month: daysInMonth,
    current_day: todayDay,
    actual: actualDaily,
    planned: plannedArr,
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
 * Rolling-window forecast: past `daysBack` days of actuals + next `daysForward`
 * days of statistical projection on a continuous date axis. Cumulative is
 * window-relative (anchored at 0 at window start). Supports MC cache and
 * optional walk-forward backtest.
 *
 * @param {{
 *   excludedCategoryIds?: number[],
 *   excludedRecipientIds?: number[],
 *   targetCurrency?: string,
 *   includePlanned?: boolean,
 *   historyMonths?: number,
 *   daysBack?: number,
 *   daysForward?: number,
 *   mcPaths?: number,
 *   mcPercentiles?: number[],
 *   includeBacktest?: boolean,
 *   userId?: string,
 * }} [opts]
 */
export async function computeCashflowForecastRolling({
  excludedCategoryIds = [],
  excludedRecipientIds = [],
  targetCurrency = 'EUR',
  includePlanned = false,
  historyMonths = DEFAULT_HISTORY_MONTHS,
  daysBack = 90,
  daysForward = 90,
  mcPaths = DEFAULT_ROLLING_MC_PATHS,
  mcPercentiles = DEFAULT_ROLLING_MC_PERCENTILES,
  includeBacktest = false,
  userId = 'anonymous',
} = {}) {
  const { all, future, todayIndex, todayIso } = rollingWindowDates(daysBack, daysForward);
  // Read before the cache probe: the setting is a cache-key input (ADR-083).
  const includeTransfers = await infoRepository.getIncludeTransfers();
  const hash = filterHash({ excludedCategoryIds, excludedRecipientIds, currency: targetCurrency, includePlanned, historyMonths, includeTransfers });

  // Cache check: skip for non-default rolling MC params or when backtest is requested.
  if (isDefaultRollingMcParams(mcPaths, mcPercentiles) && !includeBacktest) {
    const cached = await mcRollingCacheRepo.get({ userId, todayIso, daysBack, daysForward, filterHash: hash });
    if (cached && mcRollingCacheRepo.isFresh(cached.computed_at)) {
      return buildEnvelope(cached.payload, { source: 'cache' });
    }
  }

  const {
    history,
    currentActual,
    plannedCurrent,
  } = await infoRepository.getCashflowForecastDataRolling(
    historyMonths,
    daysBack,
    daysForward,
    excludedCategoryIds,
    excludedRecipientIds,
    targetCurrency,
  );

  const seed = fnv1aHash(`${userId}|${todayIso}|${daysBack}|${daysForward}|${hash}`);

  const { actualDaily, methods, planned, trainHistory } = await runForecastEngine({
    history,
    currentActual,
    plannedCurrent,
    all,
    future,
    todayIndex,
    todayIso,
    includePlanned,
    mcPaths,
    mcPercentiles,
    seed,
    userId,
  });

  let diagnostics = null;
  if (includeBacktest) {
    /** @type {import('./backtest.js').BacktestMethod[]} */
    const backtestMethods = [...POINT_METHODS, ...MC_METHODS].map((mod) => ({
      id: mod.id,
      label: mod.label,
      /** @param {{history: DailyNetPoint[], forecastDates: string[]}} ctx */
      forecast: (ctx) => {
        const fullCtx = { ...ctx, seed };
        const out = mod.forecast(fullCtx);
        return Array.isArray(out) ? out : out.series;
      },
    }));
    const backtest = walkForwardBacktestRolling({
      history: trainHistory,
      methods: backtestMethods,
      daysBack,
      daysForward,
    });
    diagnostics = {
      history_months: historyMonths,
      backtest: backtest.map((b) => ({
        method_id: b.id,
        label: b.label,
        mae: b.aggregate.mae,
        rmse: b.aggregate.rmse,
        mape: b.aggregate.mape,
        months: b.aggregate.windows,
        per_month: b.perWindow.map(
          (/** @type {{ window_end: string, mae: number, rmse: number, mape: number, sampleDays: number }} */ { window_end, mae, rmse, mape, sampleDays }) => ({
            month: window_end,
            mae,
            rmse,
            mape,
            sample_days: sampleDays,
          }),
        ),
      })),
    };
  }

  const payload = {
    window_start: all[0],
    window_end: all[all.length - 1],
    today: todayIso,
    currency: targetCurrency,
    days_back: daysBack,
    days_forward: daysForward,
    actual: actualDaily,
    methods,
    planned,
    diagnostics,
    history_months: historyMonths,
    include_planned: includePlanned,
  };

  // Write to cache when default rolling MC params and backtest not requested.
  if (isDefaultRollingMcParams(mcPaths, mcPercentiles) && !includeBacktest) {
    mcRollingCacheRepo.upsert({ userId, todayIso, daysBack, daysForward, filterHash: hash, mcPaths, payload }).catch((err) => {
      logger.warn('Rolling forecast MC cache write failed', { error: err.message });
    });
  }

  return buildEnvelope(payload, { source: 'live' });
}

/**
 * Fetch category-level data and append `category_breakdown` to an existing payload.
 * Used both for cache-hit augmentation and live-compute augmentation.
 *
 * @param {ForecastPayload} payload
 * @param {{
 *   excludedCategoryIds: number[],
 *   excludedRecipientIds: number[],
 *   targetCurrency: string,
 *   historyMonths: number,
 *   all: string[],
 *   future: string[],
 *   todayDay: number,
 * }} args
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

export default { computeCashflowForecast, computeCashflowForecastRolling };
