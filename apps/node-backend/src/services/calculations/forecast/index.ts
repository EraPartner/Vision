/**
 * Cash flow forecast orchestrator.
 * Assembles actual + per-method forecasts + optional planned overlay +
 * diagnostics for the current month. Methods plug in via registry.
 * Backtest runs on demand; accuracy persisted for future ensemble.
 */

import { infoRepository } from "../../../repositories/infoRepository.ts";
import { buildEnvelope } from "../aggregation/_envelope.ts";
import { fnv1aHash } from "./prng.ts";
import { densifyDailyHistory } from "./_densify.ts";

import * as simpleAverage from "./methods/simpleAverage.ts";
import * as weightedAverage from "./methods/weightedAverage.ts";
import * as ewma from "./methods/ewma.ts";
import * as holtWinters from "./methods/holtWinters.ts";
import * as prophetLite from "./methods/prophetLite.ts";
import * as monteCarloParametric from "./methods/monteCarloParametric.ts";
import * as monteCarloBlockBootstrap from "./methods/monteCarloBlockBootstrap.ts";
import * as ensemble from "./methods/ensemble.ts";

import { buildCategoryBreakdown } from "./categoryBreakdown.ts";
import type { ActualPoint } from "./categoryBreakdown.ts";
import { walkForwardBacktest, walkForwardBacktestRolling } from "./backtest.ts";
import type {
  BacktestMethod,
  DailyNetPoint,
  ForecastPoint,
} from "./backtest.ts";
import { recordAccuracy, getLatestAccuracyByMethod } from "./accuracyStore.ts";
import { RowContractError } from "../../../database/rowContracts.ts";
import type { AccuracyRecord } from "./accuracyStore.ts";
import mcCacheRepo from "../../../repositories/cashflowForecastMcRepository.ts";
import mcRollingCacheRepo from "../../../repositories/cashflowForecastMcRollingRepository.ts";
import { logger } from "../../../config/logger.ts";
import { todayAppDateString } from "../../../lib/timezone.ts";
import { epochMsToUtcYmd } from "../../../lib/dateFormat.ts";

const DEFAULT_HISTORY_MONTHS = 36;
const DEFAULT_MC_PATHS = 1000;
const DEFAULT_MC_PERCENTILES = [10, 50, 90];
const DEFAULT_ROLLING_MC_PATHS = 500;
const DEFAULT_ROLLING_MC_PERCENTILES = [25, 75];

export type { DailyNetPoint, ForecastPoint };
export type { ActualPoint };
export type CumulativePoint = ForecastPoint;

/**
 * A point-estimate method module (methods/simpleAverage.ts etc.) — forecast()
 * always returns the series array directly.
 */
export interface PointMethodModule {
  id: string;
  label: string;
  forecast: (ctx: {
    history: DailyNetPoint[];
    forecastDates: string[];
  }) => ForecastPoint[];
}

/**
 * A Monte Carlo method module (methods/monteCarlo*.ts) — forecast() always
 * returns { series, bands }.
 */
export interface McMethodModule {
  id: string;
  label: string;
  forecast: (ctx: {
    history: DailyNetPoint[];
    forecastDates: string[];
    paths?: number;
    percentiles?: number[];
    seed?: number | string;
  }) => {
    series: ForecastPoint[];
    bands: Record<string, ForecastPoint[]>;
    cumulative_bands: Record<string, ForecastPoint[]>;
  };
}

/** One method's output as assembled by `runForecastEngine`, pre-cumulative-fold. */
export interface MethodOutput {
  id: string;
  label: string;
  series: ForecastPoint[];
  bands?: Record<string, ForecastPoint[]>;
  cumulative_bands?: Record<string, ForecastPoint[]>;
  error?: string;
}

/**
 * One method's output as it appears in the final response payload
 * (post-cumulative-fold, `runForecastEngine`'s `methods` return field).
 */
export interface MethodResult {
  id: string;
  label: string;
  daily: ForecastPoint[];
  cumulative: CumulativePoint[];
  bands: Record<string, ForecastPoint[]> | null;
  cumulative_bands: Record<string, ForecastPoint[]> | null;
  error: string | null;
}

export interface DiagnosticsPayload {
  history_months: number;
  backtest: Array<{
    method_id: string;
    label: string;
    mae: number;
    rmse: number;
    mape: number | null;
    months: number;
    per_month: Array<{
      month: string;
      mae: number;
      rmse: number;
      mape: number | null;
      sample_days: number;
    }>;
  }>;
}

/**
 * Response payload shape for `computeCashflowForecast`, matching both a
 * freshly-built `basePayload` and a cache-read `cached.payload` (the cache
 * repo types the column as bare `object` — this is what's actually
 * stored/read).
 */
export interface ForecastPayload {
  month: string;
  currency: string;
  days_in_month: number;
  current_day: number;
  actual: ActualPoint[];
  scheduled_actual: DailyNetPoint[];
  planned: DailyNetPoint[];
  methods: MethodResult[];
  diagnostics: DiagnosticsPayload | null;
  history_months: number;
  include_planned: boolean;
  category_breakdown?: unknown;
}

const POINT_METHODS: PointMethodModule[] = [
  simpleAverage,
  weightedAverage,
  ewma,
  holtWinters,
  prophetLite,
];
const MC_METHODS: McMethodModule[] = [
  monteCarloParametric,
  monteCarloBlockBootstrap,
];

/** Date at a window position the caller guarantees is inside the window. */
function dateAt(dates: readonly string[], index: number): string {
  const date = dates[index];
  if (date === undefined) {
    throw new RangeError(`forecast: date index ${index} outside window`);
  }
  return date;
}

function currentMonthDates() {
  // App-timezone today (ADR-009) — the UTC calendar day put the actuals /
  // forecast split on yesterday between local midnight and 01:00/02:00.
  const todayYmd = todayAppDateString();
  const y = Number(todayYmd.slice(0, 4));
  const m = Number(todayYmd.slice(5, 7)) - 1;
  const daysInMonth = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  const todayDay = Number(todayYmd.slice(8, 10));
  const all: string[] = [];
  const future: string[] = [];
  for (let d = 1; d <= daysInMonth; d++) {
    const iso = `${y}-${String(m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    all.push(iso);
    if (d > todayDay) future.push(iso);
  }
  return {
    all,
    future,
    todayDay,
    daysInMonth,
    yyyymm: `${y}-${String(m + 1).padStart(2, "0")}`,
  };
}

function actualCumulativeDaily(
  currentActual: DailyNetPoint[],
  allDates: string[],
  todayIndex: number,
): ActualPoint[] {
  // todayIndex is 1-based count of past+today entries in allDates.
  // Indices < todayIndex carry actuals; indices >= todayIndex are future (null).
  const byDate = new Map(currentActual.map((r) => [r.date, r.net]));
  const out: ActualPoint[] = [];
  let cum = 0;
  for (const [i, date] of allDates.entries()) {
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

function rollingWindowDates(daysBack: number, daysForward: number) {
  // Builds a date list spanning [today - daysBack ... today + daysForward].
  // Anchored on the app-timezone today (ADR-009); pure calendar math after.
  const todayYmd = todayAppDateString();
  const [ty = NaN, tm = NaN, td = NaN] = todayYmd.split("-").map(Number);
  const todayMs = Date.UTC(ty, tm - 1, td);
  const all: string[] = [];
  for (let offset = -daysBack; offset <= daysForward; offset++) {
    const ms = todayMs + offset * 86_400_000;
    all.push(epochMsToUtcYmd(ms));
  }
  const todayIndex = daysBack + 1;
  const future = all.slice(todayIndex);
  const todayIso = dateAt(all, todayIndex - 1);
  return { all, future, todayIndex, todayIso };
}

/**
 * Runs the 8-method forecast pipeline against an arbitrary anchor + forecast window.
 * Pure orchestration: assumes data is already fetched. Returns method outputs
 * with cumulative folded against actuals + planned overlay.
 */
async function runForecastEngine({
  history,
  currentActual,
  scheduledActual = [],
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
}: {
  history: DailyNetPoint[];
  currentActual: DailyNetPoint[];
  scheduledActual?: DailyNetPoint[];
  plannedCurrent: DailyNetPoint[];
  all: string[];
  future: string[];
  todayIndex: number;
  todayIso: string;
  includePlanned: boolean;
  mcPaths: number;
  mcPercentiles: number[];
  seed: number | string;
  userId: string;
}): Promise<{
  actualDaily: ActualPoint[];
  methods: MethodResult[];
  planned: DailyNetPoint[];
  scheduled: DailyNetPoint[];
  trainHistory: DailyNetPoint[];
}> {
  const actualDaily = actualCumulativeDaily(currentActual, all, todayIndex);
  const plannedMap = plannedDailyMap(plannedCurrent);
  const scheduledMap = plannedDailyMap(scheduledActual);

  // Methods see all confirmed actuals (history + currentActual on/before today),
  // zero-filled to a dense daily grid through today so per-DOM means divide by
  // month count, not by the count of days that happened to have a transaction.
  const trainHistory = densifyDailyHistory(
    history.concat(currentActual.filter((r) => r.date <= todayIso)),
    todayIso,
  );

  const methodOutputs: MethodOutput[] = [];
  for (const mod of POINT_METHODS) {
    try {
      const series = mod.forecast({
        history: trainHistory,
        forecastDates: future,
      });
      methodOutputs.push({
        id: mod.id,
        label: mod.label,
        series: series.map((p) => ({
          ...p,
          value: Number.isFinite(p.value) ? p.value : 0,
        })),
      });
    } catch {
      methodOutputs.push({
        id: mod.id,
        label: mod.label,
        series: future.map((date) => ({ date, value: 0 })),
        error: "forecast_failed",
      });
    }
  }

  // Ensemble: inverse-MSE weighted combination of point methods.
  let accuracyRows: AccuracyRecord[] = [];
  try {
    accuracyRows = await getLatestAccuracyByMethod({ userId });
  } catch (err) {
    // A contract violation is a data fault, not an unavailable DB: surface it.
    if (err instanceof RowContractError) throw err;
    // DB unavailable — equal-weight fallback
  }
  try {
    const weights = ensemble.computeWeights(
      accuracyRows,
      POINT_METHODS.map((m) => m.id),
    );
    const ensembleSeries = ensemble.forecast({
      forecastDates: future,
      methodOutputs: methodOutputs.filter((m) => !m.error),
      weights,
    });
    methodOutputs.push({
      id: ensemble.id,
      label: ensemble.label,
      series: ensembleSeries,
    });
  } catch {
    methodOutputs.push({
      id: ensemble.id,
      label: ensemble.label,
      series: future.map((date) => ({ date, value: 0 })),
      error: "forecast_failed",
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
        cumulative_bands: out.cumulative_bands,
      });
    } catch {
      methodOutputs.push({
        id: mod.id,
        label: mod.label,
        series: future.map((date) => ({ date, value: 0 })),
        error: "forecast_failed",
      });
    }
  }

  // Fold actual-to-date into each method's cumulative series.
  const actualCumByDate = new Map<string, number>();
  for (const r of actualDaily) {
    if (r.cumulative !== null) actualCumByDate.set(r.date, r.cumulative);
  }
  const lastActualDate = todayIndex > 0 ? all[todayIndex - 1] : undefined;
  const lastActualCum =
    lastActualDate === undefined
      ? 0
      : (actualCumByDate.get(lastActualDate) ?? 0);

  const cumulativeFor = (dailySeries: ForecastPoint[]): CumulativePoint[] => {
    const out: CumulativePoint[] = [];
    let cum = lastActualCum;
    const byDate = new Map(dailySeries.map((p) => [p.date, p.value]));
    for (const [i, date] of all.entries()) {
      if (i + 1 <= todayIndex) {
        out.push({ date, value: actualCumByDate.get(date) ?? 0 });
        continue;
      }
      const daily = byDate.get(date) ?? 0;
      const plannedAdd = includePlanned ? (plannedMap.get(date) ?? 0) : 0;
      const scheduledAdd = scheduledMap.get(date) ?? 0;
      cum += daily + plannedAdd + scheduledAdd;
      out.push({ date, value: cum });
    }
    return out;
  };

  /**
   * Add the actual anchor and deterministic overlays to cumulative simulated
   * path quantiles. The path values already include every stochastic day up to
   * each point, so only scheduled/planned cash is accumulated here.
   */
  const cumulativeBandsWithOverlays = (
    cumulativeBands: Record<string, ForecastPoint[]> | undefined,
  ): Record<string, ForecastPoint[]> | null => {
    if (!cumulativeBands) return null;
    return Object.fromEntries(
      Object.entries(cumulativeBands).map(([key, band]) => {
        let overlay = 0;
        return [
          key,
          band.map((point) => {
            overlay += scheduledMap.get(point.date) ?? 0;
            if (includePlanned) overlay += plannedMap.get(point.date) ?? 0;
            return {
              date: point.date,
              value: lastActualCum + point.value + overlay,
            };
          }),
        ];
      }),
    );
  };

  const methods = methodOutputs.map((m): MethodResult => ({
    id: m.id,
    label: m.label,
    daily: m.series,
    cumulative: cumulativeFor(m.series),
    bands: m.bands ?? null,
    cumulative_bands: cumulativeBandsWithOverlays(m.cumulative_bands),
    error: m.error ?? null,
  }));

  const planned = Array.from(plannedMap, ([date, net]) => ({ date, net })).sort(
    (a, b) => a.date.localeCompare(b.date),
  );

  const scheduled = Array.from(scheduledMap, ([date, net]) => ({
    date,
    net,
  })).sort((a, b) => a.date.localeCompare(b.date));

  return { actualDaily, methods, planned, scheduled, trainHistory };
}

function plannedDailyMap(plannedCurrent: DailyNetPoint[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const r of plannedCurrent)
    map.set(r.date, (map.get(r.date) ?? 0) + r.net);
  return map;
}

function buildSeed({
  yyyymm,
  filterHash,
}: {
  yyyymm: string;
  filterHash: string;
}) {
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
function filterHash({
  excludedCategoryIds,
  excludedRecipientIds,
  currency,
  includePlanned,
  historyMonths,
  includeTransfers,
  effectiveDate,
}: {
  excludedCategoryIds?: number[];
  excludedRecipientIds?: number[];
  currency: string;
  includePlanned: boolean;
  historyMonths: number;
  includeTransfers: boolean;
  effectiveDate: string;
}): string {
  const cats = [...(excludedCategoryIds ?? [])].sort((a, b) => a - b).join(",");
  const recs = [...(excludedRecipientIds ?? [])]
    .sort((a, b) => a - b)
    .join(",");
  return `cumulative-bands-v2|${currency}|${cats}|${recs}|${includePlanned ? 1 : 0}|h${historyMonths}|d${effectiveDate}|t${includeTransfers ? 1 : 0}`;
}

function isDefaultMcParams(mcPaths: number, mcPercentiles: number[]) {
  if (mcPaths !== DEFAULT_MC_PATHS) return false;
  if (mcPercentiles.length !== DEFAULT_MC_PERCENTILES.length) return false;
  return DEFAULT_MC_PERCENTILES.every((p, i) => p === mcPercentiles[i]);
}

function isDefaultRollingMcParams(mcPaths: number, mcPercentiles: number[]) {
  if (mcPaths !== DEFAULT_ROLLING_MC_PATHS) return false;
  if (mcPercentiles.length !== DEFAULT_ROLLING_MC_PERCENTILES.length)
    return false;
  return DEFAULT_ROLLING_MC_PERCENTILES.every((p, i) => p === mcPercentiles[i]);
}

export interface CashflowForecastOptions {
  excludedCategoryIds?: number[];
  excludedRecipientIds?: number[];
  targetCurrency?: string;
  includePlanned?: boolean;
  historyMonths?: number;
  mcPaths?: number;
  mcPercentiles?: number[];
  includeBacktest?: boolean;
  includeBreakdown?: boolean;
  userId?: string;
  _forceCache?: boolean;
}

export async function computeCashflowForecast({
  excludedCategoryIds = [],
  excludedRecipientIds = [],
  targetCurrency = "EUR",
  includePlanned = false,
  historyMonths = DEFAULT_HISTORY_MONTHS,
  mcPaths = DEFAULT_MC_PATHS,
  mcPercentiles = DEFAULT_MC_PERCENTILES,
  includeBacktest = true,
  includeBreakdown = false,
  userId = "anonymous",
  // Internal flag used by nightly job to bypass cache read and force a cache write.
  _forceCache = false,
}: CashflowForecastOptions = {}) {
  const { all, future, todayDay, daysInMonth, yyyymm } = currentMonthDates();
  // Read before the cache probe: the setting is a cache-key input (ADR-083).
  const includeTransfers = await infoRepository.getIncludeTransfers();
  const hash = filterHash({
    excludedCategoryIds,
    excludedRecipientIds,
    currency: targetCurrency,
    includePlanned,
    historyMonths,
    includeTransfers,
    effectiveDate: dateAt(all, todayDay - 1),
  });

  // Try cache when not forcing a refresh and using default MC params.
  if (!_forceCache && isDefaultMcParams(mcPaths, mcPercentiles)) {
    try {
      const cachedRaw = await mcCacheRepo.get({
        userId,
        month: yyyymm,
        filterHash: hash,
      });
      // mcCacheRepo types the stored column as bare `object` (repository.js is
      // out of this slice's scope); cast to the real payload shape it's always
      // written as (see basePayload below) rather than widen the repo's type.
      const cached = cachedRaw as {
        payload: ForecastPayload;
        computed_at: Date;
      } | null;
      // Don't serve a diagnostics-free cache entry when backtest is needed.
      const diagnosticsOk =
        !includeBacktest || cached?.payload?.diagnostics != null;
      if (cached && mcCacheRepo.isFresh(cached.computed_at) && diagnosticsOk) {
        if (includeBreakdown) {
          // Reconstruct effective values from the cached payload's actual array.
          const cachedActualCount = cached.payload.actual.filter(
            (r) => r.cumulative !== null,
          ).length;
          const cachedEffectiveTodayDay = cachedActualCount > 0 ? todayDay : 0;
          const cachedEffectiveFuture =
            cachedEffectiveTodayDay === 0 ? all : future;
          const payload = await augmentPayloadWithBreakdown(cached.payload, {
            excludedCategoryIds,
            excludedRecipientIds,
            targetCurrency,
            historyMonths,
            all,
            future: cachedEffectiveFuture,
            todayDay: cachedEffectiveTodayDay,
          });
          return buildEnvelope(payload, {
            source: "cache",
            computedAt: cached.computed_at,
          });
        }
        return buildEnvelope(cached.payload, {
          source: "cache",
          computedAt: cached.computed_at,
        });
      }
    } catch (err) {
      logger.warn("Cashflow forecast MC cache read failed, computing live", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const {
    history,
    currentActual,
    scheduledActual = [],
    plannedCurrent,
  } = await infoRepository.getCashflowForecastData(
    historyMonths,
    excludedCategoryIds,
    excludedRecipientIds,
    targetCurrency,
  );

  const seed = buildSeed({ yyyymm, filterHash: hash });

  // When no current-month data imported, forecast the full month instead of only remaining days.
  const effectiveTodayDay = currentActual.length > 0 ? todayDay : 0;
  const effectiveFuture = effectiveTodayDay === 0 ? all : future;
  const todayIso =
    effectiveTodayDay > 0 ? dateAt(all, effectiveTodayDay - 1) : "";

  const {
    actualDaily,
    methods,
    planned: plannedArr,
    scheduled,
    trainHistory,
  } = await runForecastEngine({
    history,
    currentActual,
    scheduledActual,
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

  let diagnostics: DiagnosticsPayload | null = null;
  if (includeBacktest) {
    const backtestMethods: BacktestMethod[] = [
      ...POINT_METHODS,
      ...MC_METHODS,
    ].map((mod) => ({
      id: mod.id,
      label: mod.label,
      forecast: (ctx: { history: DailyNetPoint[]; forecastDates: string[] }) => {
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
          ({ month, mae, rmse, mape, sampleDays }) => ({
            month,
            mae,
            rmse,
            mape,
            sample_days: sampleDays,
          }),
        ),
      })),
    };
    await Promise.all(
      backtest.map((b) =>
        recordAccuracy({
          userId,
          methodId: b.id,
          asOfMonth: yyyymm,
          mae: b.aggregate.mae,
          rmse: b.aggregate.rmse,
          mape: b.aggregate.mape,
          sampleDays: b.perMonth.reduce((s, r) => s + r.sampleDays, 0),
        }),
      ),
    );
  }

  const basePayload: ForecastPayload = {
    month: yyyymm,
    currency: targetCurrency,
    days_in_month: daysInMonth,
    current_day: todayDay,
    actual: actualDaily,
    scheduled_actual: scheduled,
    planned: plannedArr,
    methods,
    diagnostics,
    history_months: historyMonths,
    include_planned: includePlanned,
  };

  // Write to cache whenever default MC params used (nightly job + any live compute).
  // Cache stores the base payload without breakdown (breakdown is always computed on demand).
  if (isDefaultMcParams(mcPaths, mcPercentiles)) {
    const write = mcCacheRepo.upsert({
      userId,
      month: yyyymm,
      filterHash: hash,
      mcPaths,
      payload: basePayload,
    });
    if (_forceCache) await write;
    else
      write.catch((err: unknown) => {
        logger.warn("Cashflow forecast MC cache write failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      });
  }

  let payload = basePayload;
  if (includeBreakdown) {
    payload = await augmentPayloadWithBreakdown(basePayload, {
      excludedCategoryIds,
      excludedRecipientIds,
      targetCurrency,
      historyMonths,
      all,
      future: effectiveFuture,
      todayDay: effectiveTodayDay,
    });
  }

  return buildEnvelope(payload, { source: "live" });
}

/**
 * Rolling-window forecast: past `daysBack` days of actuals + next `daysForward`
 * days of statistical projection on a continuous date axis. Cumulative is
 * window-relative (anchored at 0 at window start). Supports MC cache and
 * optional walk-forward backtest.
 */
export async function computeCashflowForecastRolling({
  excludedCategoryIds = [],
  excludedRecipientIds = [],
  targetCurrency = "EUR",
  includePlanned = false,
  historyMonths = DEFAULT_HISTORY_MONTHS,
  daysBack = 90,
  daysForward = 90,
  mcPaths = DEFAULT_ROLLING_MC_PATHS,
  mcPercentiles = DEFAULT_ROLLING_MC_PERCENTILES,
  includeBacktest = false,
  userId = "anonymous",
}: {
  excludedCategoryIds?: number[];
  excludedRecipientIds?: number[];
  targetCurrency?: string;
  includePlanned?: boolean;
  historyMonths?: number;
  daysBack?: number;
  daysForward?: number;
  mcPaths?: number;
  mcPercentiles?: number[];
  includeBacktest?: boolean;
  userId?: string;
} = {}) {
  const { all, future, todayIndex, todayIso } = rollingWindowDates(
    daysBack,
    daysForward,
  );
  // Read before the cache probe: the setting is a cache-key input (ADR-083).
  const includeTransfers = await infoRepository.getIncludeTransfers();
  const hash = filterHash({
    excludedCategoryIds,
    excludedRecipientIds,
    currency: targetCurrency,
    includePlanned,
    historyMonths,
    includeTransfers,
    effectiveDate: todayIso,
  });

  // Cache check: skip for non-default rolling MC params or when backtest is requested.
  if (isDefaultRollingMcParams(mcPaths, mcPercentiles) && !includeBacktest) {
    const cached = await mcRollingCacheRepo.get({
      userId,
      todayIso,
      daysBack,
      daysForward,
      filterHash: hash,
    });
    if (cached && mcRollingCacheRepo.isFresh(cached.computed_at)) {
      return buildEnvelope(cached.payload, { source: "cache" });
    }
  }

  const {
    history,
    currentActual,
    scheduledActual = [],
    plannedCurrent,
  } = await infoRepository.getCashflowForecastDataRolling(
    historyMonths,
    daysBack,
    daysForward,
    excludedCategoryIds,
    excludedRecipientIds,
    targetCurrency,
  );

  const seed = fnv1aHash(
    `${userId}|${todayIso}|${daysBack}|${daysForward}|${hash}`,
  );

  const { actualDaily, methods, planned, scheduled, trainHistory } =
    await runForecastEngine({
      history,
      currentActual,
      scheduledActual,
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

  let diagnostics: DiagnosticsPayload | null = null;
  if (includeBacktest) {
    const backtestMethods: BacktestMethod[] = [
      ...POINT_METHODS,
      ...MC_METHODS,
    ].map((mod) => ({
      id: mod.id,
      label: mod.label,
      forecast: (ctx: { history: DailyNetPoint[]; forecastDates: string[] }) => {
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
          ({ window_end, mae, rmse, mape, sampleDays }) => ({
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
    scheduled_actual: scheduled,
    methods,
    planned,
    diagnostics,
    history_months: historyMonths,
    include_planned: includePlanned,
  };

  // Write to cache when default rolling MC params and backtest not requested.
  if (isDefaultRollingMcParams(mcPaths, mcPercentiles) && !includeBacktest) {
    mcRollingCacheRepo
      .upsert({
        userId,
        todayIso,
        daysBack,
        daysForward,
        filterHash: hash,
        mcPaths,
        payload,
      })
      .catch((err: unknown) => {
        logger.warn("Rolling forecast MC cache write failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      });
  }

  return buildEnvelope(payload, { source: "live" });
}

/**
 * Fetch category-level data and append `category_breakdown` to an existing payload.
 * Used both for cache-hit augmentation and live-compute augmentation.
 */
async function augmentPayloadWithBreakdown(
  payload: ForecastPayload,
  {
    excludedCategoryIds,
    excludedRecipientIds,
    targetCurrency,
    historyMonths,
    all,
    future,
    todayDay,
  }: {
    excludedCategoryIds: number[];
    excludedRecipientIds: number[];
    targetCurrency: string;
    historyMonths: number;
    all: string[];
    future: string[];
    todayDay: number;
  },
): Promise<ForecastPayload> {
  const referenceMethod = payload.methods.find(
    (m) => m.id === simpleAverage.id,
  );
  const referenceDaily =
    referenceMethod?.daily ?? future.map((date) => ({ date, value: 0 }));

  const {
    historyByCategory,
    currentActualByCategory,
    scheduledActualByCategory = [],
  } = await infoRepository.getCashflowForecastDataByCategory(
    historyMonths,
    excludedCategoryIds,
    excludedRecipientIds,
    targetCurrency,
  );

  const categoryBreakdown = buildCategoryBreakdown({
    historyByCategory,
    currentActualByCategory,
    scheduledActualByCategory,
    future,
    all,
    todayDay,
    referenceDaily,
  });

  return { ...payload, category_breakdown: categoryBreakdown };
}

export default { computeCashflowForecast, computeCashflowForecastRolling };

export { filterHash as __filterHash };
