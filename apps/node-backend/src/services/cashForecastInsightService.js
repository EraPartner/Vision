/**
 * Month-End Cash Forecast Insight Service.
 *
 * Distills the EXISTING Monte-Carlo cashflow forecast into a single one-line
 * "month-end cash" finding — this service performs no forecasting of its own:
 * - Calls `computeCashflowForecast` from calculations/forecast/index.js (the
 *   Monte-Carlo orchestrator the nightly job uses; it caches internally, so no
 *   caching is added here). NOT the same-named function in
 *   aggregation/cashflowForecast.js, which is a different non-MC computation.
 * - Picks a primary method: first Monte-Carlo method with bands and no error,
 *   falling back to the ensemble, then to any error-free method.
 * - Reads the P50 month-end projection off the method's `cumulative` series
 *   (actuals to-date folded with the projection for future days) and flags
 *   overdraft risk when the future portion of that path dips below zero.
 * - Folds the DAILY p10/p90 bands into cumulative month-end low/high bounds.
 *
 * The result becomes the `cashForecast` slice of the combined insights digest.
 */

import { computeCashflowForecast } from './calculations/forecast/index.js';
import { roundMoney } from '../lib/money.js';

// Method id strings as exported by src/services/calculations/forecast/methods/*.
// Monte-Carlo methods are the only ones that carry p10/p90 bands.
const MC_METHOD_IDS = new Set(['monte_carlo_parametric', 'monte_carlo_block_bootstrap']);
// Inverse-MSE-weighted ensemble of the point methods (methods/ensemble.js).
const ENSEMBLE_METHOD_ID = 'ensemble_imse';

// A month-end projection has "moved significantly" vs. the previous one when
// the absolute move is at least MOVE_PCT of the previous projection...
const MOVE_PCT = 0.15;
// ...but never for moves below this absolute floor (EUR) — a 15% swing on a
// €20 projection is noise, not a signal.
const MOVE_ABS_FLOOR = 100;

/**
 * Pick the primary forecast method from the payload's `methods` array:
 * 1. first Monte-Carlo method (non-null `bands`, no `error`),
 * 2. else the ensemble method (no `error`),
 * 3. else the first method with no `error`.
 *
 * @param {Array<{ id: string, bands: object|null, error: string|null }>} methods
 * @returns {object|null} the chosen method, or null when none is usable
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
 * Fold a DAILY percentile band into a cumulative month-end value.
 *
 * Band series cover only the FUTURE days (same order as the future portion of
 * `cumulative`), and hold daily net values — NOT cumulative ones. Starting
 * from the cumulative anchor at the last actual day, each future day's daily
 * band value is added in order; the final running sum is the month-end bound.
 * Band entries are matched to future days by array position.
 *
 * @param {Array<{ date: string, value: number }>|undefined} bandSeries Daily percentile values.
 * @param {number} futureDays How many future days the month still has.
 * @param {number} anchor Cumulative net at the last actual day (0 when the month has no actuals).
 * @returns {number} cumulative month-end value for this band
 */
function foldDailyBandToMonthEnd(bandSeries, futureDays, anchor) {
  let cum = anchor;
  for (let i = 0; i < futureDays; i++) {
    cum += bandSeries?.[i]?.value ?? 0;
  }
  return cum;
}

/**
 * Pure builder: distill a forecast payload into the month-end cash finding.
 *
 * @param {{ month: string, currency: string, current_day: number, methods: any[] }} payload
 *   The `data` payload of the computeCashflowForecast envelope.
 * @param {number|null} [previousMonthEndProjected] Month-end P50 from a prior
 *   run, used to detect a significant move; null disables the comparison.
 * @returns {object|null} the finding, or null when no usable method exists
 */
export function buildCashForecastInsight(payload, previousMonthEndProjected = null) {
  if (!payload) return null;
  const method = pickPrimaryMethod(payload.methods);
  if (!method) return null;

  const cumulative = method.cumulative;
  if (!Array.isArray(cumulative) || cumulative.length === 0) return null;

  const currentDay = payload.current_day ?? 0;

  // P50 month-end net cashflow: last point of the cumulative (actuals folded
  // with the projection; for MC methods the projection is the median path).
  const monthEndProjected = cumulative[cumulative.length - 1].value;

  // Future portion of the cumulative path (0-based index >= current_day).
  // The minimum over it flags overdraft risk: the P50 path dipping below zero
  // at ANY future point matters even when month-end itself recovers.
  const future = cumulative.slice(currentDay);
  const minProjected =
    future.length > 0 ? Math.min(...future.map((p) => p.value)) : monthEndProjected;
  const crossesZero = minProjected < 0;

  // Cumulative anchor for band folding: the value at the last actual day
  // (0 when the month has no actuals yet, i.e. current_day is 0).
  let monthEndLow = null;
  let monthEndHigh = null;
  if (method.bands) {
    const anchor = currentDay > 0 ? cumulative[currentDay - 1]?.value ?? 0 : 0;
    monthEndLow = foldDailyBandToMonthEnd(method.bands.p10, future.length, anchor);
    monthEndHigh = foldDailyBandToMonthEnd(method.bands.p90, future.length, anchor);
  }

  const movedSignificantly =
    previousMonthEndProjected != null &&
    Math.abs(monthEndProjected - previousMonthEndProjected) >=
      Math.max(MOVE_ABS_FLOOR, MOVE_PCT * Math.abs(previousMonthEndProjected));

  return {
    month: payload.month,
    currency: payload.currency,
    monthEndProjected: roundMoney(monthEndProjected),
    minProjected: roundMoney(minProjected),
    monthEndLow: monthEndLow == null ? null : roundMoney(monthEndLow),
    monthEndHigh: monthEndHigh == null ? null : roundMoney(monthEndHigh),
    crossesZero,
    movedSignificantly,
    prominence: crossesZero || movedSignificantly ? 'alert' : 'standing',
    methodId: method.id,
  };
}

/**
 * Main insight function — runs the Monte-Carlo cashflow forecast (which caches
 * internally) and distills it into the month-end cash slice of the insights
 * digest.
 *
 * The finding is a JSON-serializable plain object:
 * `{ month, currency, monthEndProjected, minProjected, monthEndLow,
 *    monthEndHigh, crossesZero, movedSignificantly, prominence, methodId }`
 * with all monetary numbers rounded to cents. `prominence` is 'alert' when the
 * P50 path dips below zero at a future point OR the month-end projection moved
 * significantly vs. `previousMonthEndProjected`; otherwise 'standing'.
 *
 * @param {{ previousMonthEndProjected?: number|null }} [options]
 * @returns {Promise<object|null>} the finding, or null when no usable forecast method exists
 */
export async function getCashForecastInsight({ previousMonthEndProjected = null } = {}) {
  const result = await computeCashflowForecast({ includeBreakdown: false });
  return buildCashForecastInsight(result?.data, previousMonthEndProjected);
}
