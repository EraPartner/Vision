import { addAll, roundToCents, toDecimal, toNumber } from '../money.js';

/**
 * Smooth isolated one-day value needles on an array of rows. Detection runs on
 * `field`; optional extra fields are smoothed in parallel, exact decompositions
 * can be reconciled, and parallel totals retain their neighbor ratio.
 *
 * @template {Record<string, unknown>} T
 * @param {T[]} rows
 * @param {string} [field]
 * @param {{ extraFields?: string[], sumFields?: string[], parallelTotals?: Array<{field: string, sharedFields?: string[]}> }} [options]
 * @returns {T[]}
 */
export function sanitizeIsolatedValueSpikes(rows, field = 'value', { extraFields = [], sumFields = [], parallelTotals = [] } = {}) {
  if (!Array.isArray(rows) || rows.length < 3) return Array.isArray(rows) ? rows : [];
  /** @type {Array<Record<string, unknown>>} */
  const out = rows.map((row) => ({ ...row }));
  const minJump = Math.log(1.18);
  const neighborTolerance = Math.log(1.12);
  const localNeedleRatio = 1.8;
  // Each leg and the total are rounded to cents independently upstream, so an
  // exact decomposition can still show a few cents of drift.
  const decompositionTolerance = 0.05;

  /**
   * @param {unknown} a
   * @param {unknown} b
   */
  const smoothedMean = (a, b) => {
    const va = Number(a) || 0;
    const vb = Number(b) || 0;
    const mean = va > 0 && vb > 0 ? Math.sqrt(va * vb) : (va + vb) / 2;
    return toNumber(roundToCents(mean));
  };

  /**
   * @param {Record<string, unknown>} row
   * @param {string[]} fields
   */
  const sumOf = (row, fields) => {
    const legs = [];
    for (const part of fields) {
      const leg = Number(row?.[part]);
      if (!Number.isFinite(leg)) return undefined;
      legs.push(leg);
    }
    return addAll(legs);
  };

  /** @param {Record<string, unknown>} row */
  const partsSum = (row) => sumOf(row, sumFields);

  /** @param {Record<string, unknown>} row */
  const decomposes = (row) => {
    const total = Number(row?.[field]);
    const parts = partsSum(row);
    if (parts === undefined || !Number.isFinite(total)) return false;
    return parts.minus(toDecimal(total)).abs().lte(decompositionTolerance);
  };

  for (let i = 1; i < out.length - 1; i += 1) {
    const prev = Number(out[i - 1]?.[field]);
    const current = Number(out[i]?.[field]);
    const next = Number(out[i + 1]?.[field]);
    if (!Number.isFinite(prev) || !Number.isFinite(current) || !Number.isFinite(next)) continue;
    if (prev <= 0 || current <= 0 || next <= 0) continue;
    const jump = Math.log(current / prev);
    const revert = Math.log(next / current);
    const bridge = Math.log(next / prev);
    const oppositeDirections = (jump > 0 && revert < 0) || (jump < 0 && revert > 0);
    const largeMove = Math.abs(jump) >= minJump && Math.abs(revert) >= minJump;
    const bridgeLooksNormal = Math.abs(bridge) <= neighborTolerance;
    const maxNeighbor = Math.max(prev, next);
    const minNeighbor = Math.min(prev, next);
    const localNeedlePeak = current >= maxNeighbor * localNeedleRatio && bridgeLooksNormal;
    const localNeedleTrough = current * localNeedleRatio <= minNeighbor && bridgeLooksNormal;
    if ((oppositeDirections && largeMove && bridgeLooksNormal) || localNeedlePeak || localNeedleTrough) {
      const reconcilable = sumFields.length > 0
        && decomposes(out[i - 1]) && decomposes(out[i]) && decomposes(out[i + 1]);
      for (const extra of extraFields) {
        out[i][extra] = smoothedMean(out[i - 1]?.[extra], out[i + 1]?.[extra]);
      }
      const reconciled = reconcilable ? partsSum(out[i]) : undefined;
      out[i][field] = toNumber(roundToCents(reconciled ?? Math.sqrt(prev * next)));

      if (reconciled === undefined) continue;
      for (const { field: parallelField, sharedFields = [] } of parallelTotals) {
        const shared = sumOf(out[i], sharedFields);
        const prevShared = sumOf(out[i - 1], sharedFields);
        const nextShared = sumOf(out[i + 1], sharedFields);
        if (shared === undefined || prevShared === undefined || nextShared === undefined) continue;
        const prevParallel = Number(out[i - 1]?.[parallelField]);
        const nextParallel = Number(out[i + 1]?.[parallelField]);
        if (!Number.isFinite(prevParallel) || !Number.isFinite(nextParallel)) continue;
        const ratios = [];
        for (const [parallelTotal, mainTotal, rowShared] of /** @type {const} */ ([
          [prevParallel, prev, prevShared],
          [nextParallel, next, nextShared],
        ])) {
          const exclusive = toDecimal(mainTotal).minus(rowShared);
          if (!exclusive.gt(0)) continue;
          const rowRatio = toDecimal(parallelTotal).minus(rowShared).div(exclusive).toNumber();
          if (Number.isFinite(rowRatio) && rowRatio > 0) ratios.push(rowRatio);
        }
        // A neighbor holding nothing outside the shared legs carries no ratio.
        // With neither neighbor usable the exclusive part is degenerate — it
        // reconciles to zero — so the factor it is multiplied by is moot, and 1
        // keeps a shared-only total (an all-cash portfolio) exactly on `field`.
        const ratio = ratios.length === 2 ? Math.sqrt(ratios[0] * ratios[1]) : (ratios[0] ?? 1);
        out[i][parallelField] = toNumber(roundToCents(reconciled.minus(shared).times(ratio).plus(shared)));
      }
    }
  }
  return /** @type {T[]} */ (out);
}
