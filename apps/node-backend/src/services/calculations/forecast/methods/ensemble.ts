/**
 * Ensemble method: confidence-weighted inverse-MSE combination of
 * point-estimate methods.
 *
 * Weights are derived from persisted backtest accuracy (cashflow_forecast_accuracy).
 * Rather than weight purely by inverse-MSE (1/RMSE²) — which over-trusts a method
 * whose low RMSE came from a tiny backtest window — weights are chosen more wisely:
 *
 *  1. Sample-size shrinkage (empirical Bayes): each method's RMSE is shrunk
 *     toward the cross-method mean RMSE in proportion to how little data backed
 *     it — `(n·rmse + K·meanRmse) / (n + K)`. A method backtested on few days is
 *     pulled toward the average (trusted less); as `sampleDays` grows the
 *     shrinkage vanishes and we recover plain inverse-MSE.
 *  2. Blend toward uniform: the normalized inverse-MSE weights are mixed with a
 *     small equal-weight floor so a single method can't dominate on noisy
 *     backtest accuracy (and every method keeps contributing).
 *
 * Falls back to equal weights when no accuracy data is available (empty map →
 * `forecast()` equal-weights). Not included in POINT_METHODS or MC_METHODS —
 * excluded from walk-forward backtest to avoid a circular dependency on the
 * accuracy it consumes.
 */

export const id = 'ensemble_imse';
export const label = 'Ensemble';

const MIN_RMSE = 1e-6; // guard against division by zero
/** Prior strength (in "sample days") for RMSE shrinkage toward the mean. */
const SHRINKAGE_PRIOR_DAYS = 30;
/** Fraction of weight reserved for a uniform blend (anti-dominance floor). */
const UNIFORM_FLOOR = 0.05;
/** Assumed sample size when an accuracy row carries no `sampleDays`. */
const DEFAULT_SAMPLE_DAYS = SHRINKAGE_PRIOR_DAYS;

/**
 * Derive per-method weights from accuracy rows: inverse-MSE on a sample-size
 * shrunk RMSE, blended toward uniform. See module header for the rationale.
 *
 * @param methodIds - ordered list of point-method IDs to weight
 * @returns methodId → normalized weight in [0, 1]
 */
export function computeWeights(
  accuracyRows: Array<{ methodId: string; rmse: number | null; sampleDays?: number | null }>,
  methodIds: string[],
): Map<string, number> {
  // A stored NULL rmse is excluded exactly as `null > 0` excluded it before.
  const rows = accuracyRows.filter(
    (r): r is typeof r & { rmse: number } =>
      r.rmse !== null && r.rmse > 0 && methodIds.includes(r.methodId),
  );
  if (rows.length === 0) return new Map();

  // Shrinkage target: the average RMSE across the methods we're weighting.
  const meanRmse = rows.reduce((s, r) => s + r.rmse, 0) / rows.length;

  const rawWeights = rows.map((r) => {
    const n =
      typeof r.sampleDays === 'number' && Number.isFinite(r.sampleDays) && r.sampleDays > 0
        ? r.sampleDays
        : DEFAULT_SAMPLE_DAYS;
    const shrunkRmse = (n * r.rmse + SHRINKAGE_PRIOR_DAYS * meanRmse) / (n + SHRINKAGE_PRIOR_DAYS);
    const entry: [string, number] = [r.methodId, 1 / Math.max(shrunkRmse, MIN_RMSE) ** 2];
    return entry;
  });

  const total = rawWeights.reduce((s, [, w]) => s + w, 0);
  const m = rawWeights.length;

  // (1 - floor) · inverse-MSE share  +  floor · uniform share. Sums to 1.
  // eslint-disable-next-line vision-local-money/no-raw-money-arithmetic
  return new Map(rawWeights.map(([mid, w]) => [mid, (1 - UNIFORM_FLOOR) * (w / total) + UNIFORM_FLOOR / m]));
}

/**
 * Compute weighted-average forecast from point-method outputs.
 */
export function forecast({
  forecastDates,
  methodOutputs,
  weights,
}: {
  forecastDates: string[];
  methodOutputs: Array<{
    id: string;
    series: Array<{ date: string; value: number }>;
    error?: unknown;
  }>;
  weights: Map<string, number>;
}): Array<{ date: string; value: number }> {
  const eligible = methodOutputs.filter((m) => !m.error);

  if (eligible.length === 0) {
    return forecastDates.map((date) => ({ date, value: 0 }));
  }

  const effective = effectiveWeights(
    weights,
    eligible.map((m) => m.id),
  );

  return forecastDates.map((date) => {
    let value = 0;
    for (const m of eligible) {
      const point = m.series.find((p) => p.date === date);
      value += (effective.get(m.id) ?? 0) * (point?.value ?? 0);
    }
    return { date, value };
  });
}

/**
 * The weights the ensemble actually applies to the methods that produced a
 * series: equal weights when no accuracy history exists, otherwise the
 * accuracy weights renormalised over the eligible methods.
 */
export function effectiveWeights(
  weights: Map<string, number>,
  eligibleIds: string[],
): Map<string, number> {
  if (eligibleIds.length === 0) return new Map();
  if (weights.size === 0)
    return new Map(eligibleIds.map((id) => [id, 1 / eligibleIds.length]));
  const weightSum = eligibleIds.reduce((s, id) => s + (weights.get(id) ?? 0), 0);
  return new Map(
    eligibleIds.map((id) => [id, weightSum > 0 ? (weights.get(id) ?? 0) / weightSum : 0]),
  );
}
