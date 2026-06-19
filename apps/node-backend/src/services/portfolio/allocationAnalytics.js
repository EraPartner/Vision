/**
 * Portfolio × Research analytics (ADR-097) — pure, descriptive.
 *
 * Watchlist what-if backtest and allocation drift vs a target or a canonical
 * model portfolio. No IO; the data layer supplies prices and weights.
 */

/**
 * "Had I bought when I added it to the watchlist…" — fractional return from the
 * add-date price to the current price. Null when the add-date price is missing
 * or non-positive (the UI shows "no data" rather than a wrong number).
 *
 * @param {number|string} priceAtAdd
 * @param {number|string} currentPrice
 * @returns {number|null}
 */
export function backtestReturn(priceAtAdd, currentPrice) {
  const p0 = Number(priceAtAdd);
  const p1 = Number(currentPrice);
  if (!Number.isFinite(p0) || p0 <= 0 || !Number.isFinite(p1)) return null;
  return (p1 - p0) / p0;
}

/**
 * Per-key allocation drift = actualWeight − targetWeight, over the union of keys.
 * Weights are fractions (0–1). Missing keys count as 0.
 *
 * @param {Record<string, number>} actual
 * @param {Record<string, number>} target
 * @returns {Record<string, number>}
 */
export function allocationDrift(actual, target) {
  const keys = new Set([...Object.keys(actual ?? {}), ...Object.keys(target ?? {})]);
  const out = /** @type {Record<string, number>} */ ({});
  for (const k of keys) out[k] = (Number(actual?.[k]) || 0) - (Number(target?.[k]) || 0);
  return out;
}

/**
 * Normalize a weights map so its values sum to 1 (no-op if it already does or is
 * empty/zero). Used before diffing actual holdings weights against a benchmark.
 *
 * @param {Record<string, number>} weights
 * @returns {Record<string, number>}
 */
export function normalizeWeights(weights) {
  const entries = Object.entries(weights ?? {});
  const total = entries.reduce((s, [, v]) => s + (Number(v) || 0), 0);
  if (total <= 0) return { ...weights };
  return Object.fromEntries(entries.map(([k, v]) => [k, (Number(v) || 0) / total]));
}

/** Canonical model portfolios (illustrative weights) for benchmark comparison. */
export const CLASSIC_PORTFOLIOS = Object.freeze({
  sixty_forty: Object.freeze({ stocks: 0.6, bonds: 0.4 }),
  all_weather: Object.freeze({ stocks: 0.30, bonds: 0.55, gold: 0.075, commodities: 0.075 }),
  three_fund: Object.freeze({ stocks: 0.48, intl_stocks: 0.12, bonds: 0.40 }),
});
