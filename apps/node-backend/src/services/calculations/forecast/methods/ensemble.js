/**
 * Ensemble method: inverse-MSE weighted combination of point-estimate methods.
 *
 * Weights are derived from persisted backtest accuracy (cashflow_forecast_accuracy).
 * Methods with lower RMSE receive higher weight. Falls back to equal weights
 * when no accuracy data is available (e.g. first run after migration).
 *
 * Not included in POINT_METHODS or MC_METHODS — excluded from walk-forward
 * backtest to avoid circular dependency on the accuracy it consumes.
 */

export const id = 'ensemble_imse';
export const label = 'Ensemble (inv-MSE)';

const MIN_RMSE = 1e-6; // guard against division by zero

/**
 * Derive per-method weights from accuracy rows using inverse-MSE (= 1/RMSE²).
 *
 * @param {Array<{ methodId: string, rmse: number }>} accuracyRows
 * @param {string[]} methodIds - ordered list of point-method IDs to weight
 * @returns {Map<string, number>} methodId → normalized weight in [0, 1]
 */
export function computeWeights(accuracyRows, methodIds) {
  const rmseByMethod = new Map(
    accuracyRows
      .filter((r) => r.rmse > 0 && methodIds.includes(r.methodId))
      .map((r) => [r.methodId, r.rmse]),
  );

  if (rmseByMethod.size === 0) return new Map();

  const rawWeights = new Map(
    [...rmseByMethod.entries()].map(([mid, rmse]) => [mid, 1 / Math.max(rmse, MIN_RMSE) ** 2]),
  );

  const total = [...rawWeights.values()].reduce((s, w) => s + w, 0);

  // eslint-disable-next-line vision-local-money/no-raw-money-arithmetic
  return new Map([...rawWeights.entries()].map(([mid, w]) => [mid, w / total]));
}

/**
 * Compute weighted-average forecast from point-method outputs.
 *
 * @param {{
 *   forecastDates: string[],
 *   methodOutputs: Array<{ id: string, series: Array<{ date: string, value: number }>, error?: any }>,
 *   weights: Map<string, number>
 * }} args
 * @returns {Array<{ date: string, value: number }>}
 */
export function forecast({ forecastDates, methodOutputs, weights }) {
  const eligible = methodOutputs.filter((m) => !m.error);

  if (eligible.length === 0) {
    return forecastDates.map((date) => ({ date, value: 0 }));
  }

  const useEqualWeights = weights.size === 0;
  const equalWeight = 1 / eligible.length;

  return forecastDates.map((date) => {
    let value = 0;
    let totalWeight = 0;

    for (const m of eligible) {
      const point = m.series.find((p) => p.date === date);
      const v = point?.value ?? 0;
      const w = useEqualWeights ? equalWeight : (weights.get(m.id) ?? 0);
      value += w * v;
      totalWeight += w;
    }

    return { date, value: totalWeight > 0 ? value / totalWeight : 0 };
  });
}
