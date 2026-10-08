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
 */
function backtestReturn(
  priceAtAdd: number | string,
  currentPrice: number | string,
): number | null {
  const p0 = Number(priceAtAdd);
  const p1 = Number(currentPrice);
  if (!Number.isFinite(p0) || p0 <= 0 || !Number.isFinite(p1)) return null;
  return (p1 - p0) / p0;
}

/**
 * Per-key allocation drift = actualWeight − targetWeight, over the union of keys.
 * Weights are fractions (0–1). Missing keys count as 0.
 */
function allocationDrift(
  actual: Record<string, number>,
  target: Record<string, number>,
): Record<string, number> {
  const keys = new Set([
    ...Object.keys(actual ?? {}),
    ...Object.keys(target ?? {}),
  ]);
  const out: Record<string, number> = {};
  for (const k of keys)
    out[k] = (Number(actual?.[k]) || 0) - (Number(target?.[k]) || 0);
  return out;
}

/**
 * Normalize a weights map so its values sum to 1 (no-op if it already does or is
 * empty/zero). Used before diffing actual holdings weights against a benchmark.
 */
export function normalizeWeights(
  weights: Record<string, number>,
): Record<string, number> {
  const entries = Object.entries(weights ?? {});
  const total = entries.reduce((s, [, v]) => s + (Number(v) || 0), 0);
  if (total <= 0) return { ...weights };
  return Object.fromEntries(
    entries.map(([k, v]) => [k, (Number(v) || 0) / total]),
  );
}

/** Canonical model portfolios (illustrative weights) for benchmark comparison. */
export const CLASSIC_PORTFOLIOS = Object.freeze({
  sixty_forty: Object.freeze({ stocks: 0.6, bonds: 0.4 }),
  all_weather: Object.freeze({
    stocks: 0.3,
    bonds: 0.55,
    gold: 0.075,
    commodities: 0.075,
  }),
  three_fund: Object.freeze({ stocks: 0.48, intl_stocks: 0.12, bonds: 0.4 }),
  awesome: Object.freeze({
    real_estate: 0.2,
    stocks: 0.2,
    gold: 0.2,
    bonds: 0.2,
    savings: 0.2,
  }),
});

/**
 * Map target-sleeve names that no real asset_class rolls up to (see
 * crossWorkspaceDataService.SLEEVE_ROLLUP) onto the nearest representable sleeve,
 * so a preset's cash deploys into a bucket the user can actually hold instead of
 * a phantom sleeve that absorbs cash forever. `commodities` folds into `gold`
 * (the precious-metals sleeve) and `intl_stocks` into `stocks`. Left here next to
 * CLASSIC_PORTFOLIOS so the canonical models stay intact for drift comparison.
 */
const REBALANCE_TARGET_ALIASES: Readonly<Record<string, string>> =
  Object.freeze({
    commodities: "gold",
    intl_stocks: "stocks",
  });

/**
 * Collapse a target-weight map into the representable sleeve vocabulary, summing
 * weights that alias to the same sleeve. Used only by the rebalance path.
 */
export function foldTargetSleeves(
  weights: Readonly<Record<string, number>>,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(weights ?? {})) {
    const key = REBALANCE_TARGET_ALIASES[k] ?? k;
    out[key] = (Number(out[key]) || 0) + (Number(v) || 0);
  }
  return out;
}

export {
  backtestReturn as __backtestReturn,
  allocationDrift as __allocationDrift,
};
