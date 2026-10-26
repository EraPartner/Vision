/**
 * Small numeric helpers shared across services.
 */

/**
 * Median of a numeric array. Returns `undefined` for empty / non-array input.
 */
export function median(
  values: readonly number[] | null | undefined,
): number | undefined {
  if (!values || values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const upper = sorted[mid];
  if (upper === undefined) return undefined;
  if (sorted.length % 2 === 1) return upper;
  const lower = sorted[mid - 1];
  return lower === undefined ? undefined : (lower + upper) / 2;
}

export interface MadReturnStats {
  medianReturn: number;
  robustSigma: number;
  spikeThreshold: number;
  bridgeThreshold: number;
  minSpikeMove: number;
}

/**
 * Robust (MAD-based) statistics over a series of log-returns, plus the fixed
 * needle-detection thresholds derived from them. Shared by the price
 * sanitizers so the "median → MAD → robustSigma" math lives in one place
 * (SIMP-31). `robustSigma` is floored at 0.0015 so a flat series still admits
 * a sensible spike threshold.
 */
export function madReturnStats(logReturns: readonly number[]): MadReturnStats {
  const medianReturn = median(logReturns) ?? 0;
  const absDeviations = logReturns.map((r) => Math.abs(r - medianReturn));
  const mad = median(absDeviations) ?? 0;
  const robustSigma = Math.max(1.4826 * mad, 0.0015);
  return {
    medianReturn,
    robustSigma,
    spikeThreshold: 6 * robustSigma,
    bridgeThreshold: 4 * robustSigma,
    minSpikeMove: Math.log(1.18),
  };
}

/**
 * True when the middle price is an isolated "needle": a large jump away and a
 * large opposite revert back, while the prev→next bridge looks normal. `stats`
 * comes from {@link madReturnStats}. Prices must be positive numbers.
 */
export function isRobustNeedle(
  prev: number,
  current: number,
  next: number,
  stats: MadReturnStats,
): boolean {
  const { medianReturn, spikeThreshold, bridgeThreshold, minSpikeMove } = stats;
  const jump = Math.log(current / prev);
  const revert = Math.log(next / current);
  const bridge = Math.log(next / prev);
  const hasLargeJump = Math.abs(jump - medianReturn) > spikeThreshold && Math.abs(jump) > minSpikeMove;
  const hasLargeRevert = Math.abs(revert - medianReturn) > spikeThreshold && Math.abs(revert) > minSpikeMove;
  const oppositeDirections = (jump > 0 && revert < 0) || (jump < 0 && revert > 0);
  const bridgeLooksNormal = Math.abs(bridge - medianReturn) <= bridgeThreshold;
  return hasLargeJump && hasLargeRevert && oppositeDirections && bridgeLooksNormal;
}

/**
 * `value`, with NaN (unparseable input) read as 0. The explicit form of the
 * `Number(x) || 0` idiom for values where 0 itself is legitimate. A missing
 * value that slipped past its declared type also reads as 0, as `|| 0` did.
 */
export function nanToZero(value: number | null | undefined): number {
  return typeof value === "number" && !Number.isNaN(value) ? value : 0;
}

/**
 * `value`, or `fallback` when it is 0 or NaN. The explicit form of the
 * `Number(x) || fallback` idiom for settings where 0 means "use the default"
 * (row limits, page sizes, counts that must be at least one).
 */
export function nonZeroOr(
  value: number | null | undefined,
  fallback: number,
): number {
  return typeof value !== "number" || value === 0 || Number.isNaN(value)
    ? fallback
    : value;
}

/**
 * The first non-zero comparison result, or 0. Chains sort tie-breakers
 * (`byDate || byId`) without treating a number as a boolean.
 */
export function firstNonZero(...comparisons: number[]): number {
  for (const comparison of comparisons) {
    if (comparison !== 0 && !Number.isNaN(comparison)) return comparison;
  }
  return 0;
}
