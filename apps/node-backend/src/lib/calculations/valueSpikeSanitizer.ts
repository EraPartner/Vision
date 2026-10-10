import { addAll, roundToCents, toDecimal, toNumber } from '../money.ts';

/**
 * Smooth isolated one-day value needles on an array of rows. Detection runs on
 * `field`; optional extra fields are smoothed in parallel, exact decompositions
 * can be reconciled, and parallel totals retain their neighbor ratio.
 */
export interface ValueSpikeSanitizerOptions {
  extraFields?: string[];
  sumFields?: string[];
  parallelTotals?: Array<{ field: string; sharedFields?: string[] }>;
}

export function sanitizeIsolatedValueSpikes<T extends Record<string, unknown>>(
  rows: T[],
  field = 'value',
  { extraFields = [], sumFields = [], parallelTotals = [] }: ValueSpikeSanitizerOptions = {},
): T[] {
  if (!Array.isArray(rows) || rows.length < 3) return Array.isArray(rows) ? rows : [];
  const out: T[] = rows.map((row) => ({ ...row }));
  const minJump = Math.log(1.18);
  const neighborTolerance = Math.log(1.12);
  const localNeedleRatio = 1.8;
  // Each leg and the total are rounded to cents independently upstream, so an
  // exact decomposition can still show a few cents of drift.
  const decompositionTolerance = 0.05;

  const smoothedMean = (a: unknown, b: unknown) => {
    const va = Number(a) || 0;
    const vb = Number(b) || 0;
    const mean = va > 0 && vb > 0 ? Math.sqrt(va * vb) : (va + vb) / 2;
    return toNumber(roundToCents(mean));
  };

  const sumOf = (row: Record<string, unknown>, fields: string[]) => {
    const legs = [];
    for (const part of fields) {
      const leg = Number(row?.[part]);
      if (!Number.isFinite(leg)) return undefined;
      legs.push(leg);
    }
    return addAll(legs);
  };

  const partsSum = (row: Record<string, unknown>) => sumOf(row, sumFields);

  const decomposes = (row: Record<string, unknown>) => {
    const total = Number(row?.[field]);
    const parts = partsSum(row);
    if (parts === undefined || !Number.isFinite(total)) return false;
    return parts.minus(toDecimal(total)).abs().lte(decompositionTolerance);
  };

  for (let i = 1; i < out.length - 1; i += 1) {
    const prevRow = out[i - 1];
    const row = out[i];
    const nextRow = out[i + 1];
    // In range by the loop bounds; a missing row would read as NaN below.
    if (!prevRow || !row || !nextRow) continue;
    const prev = Number(prevRow[field]);
    const current = Number(row[field]);
    const next = Number(nextRow[field]);
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
      // Widened view of the copied row so smoothed fields can be written back.
      const target: Record<string, unknown> = row;
      const reconcilable = sumFields.length > 0
        && decomposes(prevRow) && decomposes(row) && decomposes(nextRow);
      for (const extra of extraFields) {
        target[extra] = smoothedMean(prevRow[extra], nextRow[extra]);
      }
      const reconciled = reconcilable ? partsSum(row) : undefined;
      target[field] = toNumber(roundToCents(reconciled ?? Math.sqrt(prev * next)));

      if (reconciled === undefined) continue;
      for (const { field: parallelField, sharedFields = [] } of parallelTotals) {
        const shared = sumOf(row, sharedFields);
        const prevShared = sumOf(prevRow, sharedFields);
        const nextShared = sumOf(nextRow, sharedFields);
        if (shared === undefined || prevShared === undefined || nextShared === undefined) continue;
        const prevParallel = Number(prevRow[parallelField]);
        const nextParallel = Number(nextRow[parallelField]);
        if (!Number.isFinite(prevParallel) || !Number.isFinite(nextParallel)) continue;
        const ratios = [];
        for (const [parallelTotal, mainTotal, rowShared] of [
          [prevParallel, prev, prevShared],
          [nextParallel, next, nextShared],
        ] as const) {
          const exclusive = toDecimal(mainTotal).minus(rowShared);
          if (!exclusive.gt(0)) continue;
          const rowRatio = toDecimal(parallelTotal).minus(rowShared).div(exclusive).toNumber();
          if (Number.isFinite(rowRatio) && rowRatio > 0) ratios.push(rowRatio);
        }
        // A neighbor holding nothing outside the shared legs carries no ratio.
        // With neither neighbor usable the exclusive part is degenerate — it
        // reconciles to zero — so the factor it is multiplied by is moot, and 1
        // keeps a shared-only total (an all-cash portfolio) exactly on `field`.
        const [firstRatio, secondRatio] = ratios;
        const ratio = firstRatio !== undefined && secondRatio !== undefined
          ? Math.sqrt(firstRatio * secondRatio)
          : (firstRatio ?? 1);
        target[parallelField] = toNumber(roundToCents(reconciled.minus(shared).times(ratio).plus(shared)));
      }
    }
  }
  return out;
}
