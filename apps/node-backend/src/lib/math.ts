/**
 * Small numeric helpers shared across services.
 */

/**
 * Median of a numeric array. Returns `undefined` for empty / non-array input.
 */
export function median(values: readonly number[]): number | undefined {
  if (!Array.isArray(values) || values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
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
