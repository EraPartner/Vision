/**
 * Month-End Cash Forecast Insight Service.
 *
 * Distills the EXISTING Monte-Carlo cashflow forecast into a single one-line
 * month-end net-cashflow finding — this service performs no forecasting of its own:
 * - Calls `computeCashflowForecast` from calculations/forecast/index.js (the
 *   Monte-Carlo orchestrator the nightly job uses; it caches internally, so no
 *   caching is added here). NOT the same-named function in
 *   aggregation/cashflowForecast.js, which is a different non-MC computation.
 * - Picks a primary method: first Monte-Carlo method with bands and no error,
 *   falling back to the ensemble, then to any error-free method.
 * - Reads P50 month-end net cash flow from the method's zero-based `cumulative`
 *   series (actuals to-date folded with the projection for future days).
 * - Reads P10/P90 month-end bounds from the cumulative simulated-path bands.
 *
 * The result becomes the `cashForecast` slice of the combined insights digest.
 */

import { computeCashflowForecast } from "./calculations/forecast/index.js";
import { roundMoney } from "../lib/money.js";
import insightCashProjectionRepository from "../repositories/insightCashProjectionRepository.js";

// Method id strings as exported by src/services/calculations/forecast/methods/*.
// Monte-Carlo methods are the only ones that carry p10/p90 bands.
const MC_METHOD_IDS = new Set([
  "monte_carlo_parametric",
  "monte_carlo_block_bootstrap",
]);
// Inverse-MSE-weighted ensemble of the point methods (methods/ensemble.js).
const ENSEMBLE_METHOD_ID = "ensemble_imse";

// A month-end projection has "moved significantly" vs. the previous one when
// the absolute move is at least MOVE_PCT of the previous projection...
const MOVE_PCT = 0.15;
// ...but never for moves below this absolute floor (EUR) — a 15% swing on a
// €20 projection is noise, not a signal.
const MOVE_ABS_FLOOR = 100;

/**
 * The subset of a computeCashflowForecast method result this module reads.
 * The envelope's `methods` field is `any[]` (calculations/forecast/ is
 * outside this ratchet slice) — narrowed locally to what this file touches.
 * @typedef {object} ForecastMethod
 * @property {string} id
 * @property {string|null} [error]
 * @property {Array<{ date: string, value: number }>} [cumulative] actuals-to-date folded with the projection.
 * @property {{ p10?: Array<{ date: string, value: number }>, p90?: Array<{ date: string, value: number }> }|null} [bands] daily (non-cumulative) percentile series, MC methods only.
 * @property {{ p10?: Array<{ date: string, value: number }>, p90?: Array<{ date: string, value: number }> }|null} [cumulative_bands] cumulative simulated-path percentile series with actual and deterministic overlays, MC methods only.
 */

/**
 * Pick the primary forecast method from the payload's `methods` array:
 * 1. first Monte-Carlo method (non-null `bands`, no `error`),
 * 2. else the ensemble method (no `error`),
 * 3. else the first method with no `error`.
 *
 * @param {ForecastMethod[]} methods
 * @returns {ForecastMethod|null} the chosen method, or null when none is usable
 */
function pickPrimaryMethod(methods) {
  if (!Array.isArray(methods)) return null;
  const usable = methods.filter((m) => m && m.error == null);
  return (
    usable.find((m) => MC_METHOD_IDS.has(m.id) && m.bands != null) ??
    usable.find((m) => m.id === ENSEMBLE_METHOD_ID) ??
    usable[0] ??
    null
  );
}

/**
 * Pure builder: distill a forecast payload into the month-end cash finding.
 *
 * @param {{ month: string, currency: string, current_day: number, methods: ForecastMethod[] }} payload
 *   The `data` payload of the computeCashflowForecast envelope.
 * The cumulative series starts at zero and measures income minus outflows. It
 * is not an account balance, available cash, or an overdraft prediction.
 *
 * @param {number|null} [previousMonthEndNetCashflow] Month-end P50 from a prior
 *   run, used to detect a significant move; null disables the comparison.
 * @returns {object|null} the finding, or null when no usable method exists
 */
export function buildCashForecastInsight(
  payload,
  previousMonthEndNetCashflow = null,
) {
  if (!payload) return null;
  const method = pickPrimaryMethod(payload.methods);
  if (!method) return null;

  const cumulative = method.cumulative;
  if (!Array.isArray(cumulative) || cumulative.length === 0) return null;

  // P50 month-end net cash flow: last point of the cumulative (actuals folded
  // with the projection; for MC methods the projection is the median path).
  const monthEndNetCashflow = cumulative[cumulative.length - 1].value;
  const hasFuture = cumulative.slice(payload.current_day ?? 0).length > 0;

  let monthEndNetCashflowLow = null;
  let monthEndNetCashflowHigh = null;
  if (method.cumulative_bands && !hasFuture) {
    monthEndNetCashflowLow = monthEndNetCashflow;
    monthEndNetCashflowHigh = monthEndNetCashflow;
  } else if (method.cumulative_bands) {
    monthEndNetCashflowLow = method.cumulative_bands.p10?.at(-1)?.value ?? null;
    monthEndNetCashflowHigh =
      method.cumulative_bands.p90?.at(-1)?.value ?? null;
  }

  const movedSignificantly =
    previousMonthEndNetCashflow != null &&
    Math.abs(monthEndNetCashflow - previousMonthEndNetCashflow) >=
      Math.max(
        MOVE_ABS_FLOOR,
        MOVE_PCT * Math.abs(previousMonthEndNetCashflow),
      );

  return {
    month: payload.month,
    currency: payload.currency,
    monthEndNetCashflow: roundMoney(monthEndNetCashflow),
    monthEndNetCashflowLow:
      monthEndNetCashflowLow == null
        ? null
        : roundMoney(monthEndNetCashflowLow),
    monthEndNetCashflowHigh:
      monthEndNetCashflowHigh == null
        ? null
        : roundMoney(monthEndNetCashflowHigh),
    movedSignificantly,
    prominence: movedSignificantly ? "alert" : "standing",
    methodId: method.id,
  };
}

/**
 * Main insight function — runs the Monte-Carlo cashflow forecast (which caches
 * internally) and distills it into the month-end cash slice of the insights
 * digest.
 *
 * The finding is a JSON-serializable plain object:
 * `{ month, currency, monthEndNetCashflow, monthEndNetCashflowLow,
 *    monthEndNetCashflowHigh, movedSignificantly, prominence, methodId }`
 * with all monetary numbers rounded to cents. `prominence` is 'alert' only
 * when expected month-end net cash flow moved significantly versus the prior
 * projection; a negative value alone is not an overdraft signal.
 *
 * @param {{ previousMonthEndNetCashflow?: number|null }} [options]
 * @returns {Promise<object|null>} the finding, or null when no usable forecast method exists
 */
export async function getCashForecastInsight(options = {}) {
  const result = await computeCashflowForecast({ includeBreakdown: false });
  const initial = buildCashForecastInsight(result?.data);
  if (!initial) return null;

  const hasInjectedPrevious = Object.hasOwn(
    options,
    "previousMonthEndNetCashflow",
  );
  const previousMonthEndNetCashflow = hasInjectedPrevious
    ? options.previousMonthEndNetCashflow
    : await insightCashProjectionRepository.getProjection(
        initial.month,
        initial.currency,
        initial.methodId,
      );
  const finding = buildCashForecastInsight(
    result?.data,
    previousMonthEndNetCashflow ?? null,
  );
  if (!hasInjectedPrevious) {
    await insightCashProjectionRepository.saveProjection(
      finding.month,
      finding.currency,
      finding.methodId,
      finding.monthEndNetCashflow,
    );
  }
  return finding;
}
