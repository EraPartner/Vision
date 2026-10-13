import type { ResearchPoint } from "./types.ts";
export interface SymbolStats {
  symbol: string;
  totalReturn: number | null;
  volatility: number | null;
  maxDrawdown: number | null;
}
/** Daily log returns keyed by the point's timestamp (paired close → return at the later time). */
export function dailyReturnsByTime(
  points: ResearchPoint[],
): Map<number, number> {
  const valid = points
    .filter(
      (p): p is ResearchPoint & { close: number } =>
        Number.isFinite(p.close) &&
        (p.close as number) > 0 &&
        Number.isFinite(p.time),
    )
    .sort((a, b) => a.time - b.time);
  const out = new Map<number, number>();
  let previous: (ResearchPoint & { close: number }) | undefined;
  for (const point of valid) {
    if (previous) out.set(point.time, Math.log(point.close / previous.close));
    previous = point;
  }
  return out;
}

/** Annualized stdev of daily log returns (approximate, 252 trading days). */
export function computeStats(
  symbol: string,
  points: ResearchPoint[],
): SymbolStats {
  const closes = points
    .map((p) => p.close)
    .filter((c): c is number => Number.isFinite(c) && (c as number) > 0);
  const first = closes[0];
  const last = closes.at(-1);
  if (closes.length < 2 || first === undefined || last === undefined)
    return {
      symbol,
      totalReturn: null,
      volatility: null,
      maxDrawdown: null,
    };

  const totalReturn = (last - first) / first;

  const rets: number[] = [];
  let previous = first;
  for (const close of closes.slice(1)) {
    rets.push(Math.log(close / previous));
    previous = close;
  }
  const mean = rets.reduce((s, r) => s + r, 0) / rets.length;
  const variance = rets.reduce((s, r) => s + (r - mean) ** 2, 0) / rets.length;
  const volatility = Math.sqrt(variance) * Math.sqrt(252);

  let peak = first;
  let maxDrawdown = 0;
  for (const c of closes) {
    if (c > peak) peak = c;
    const dd = (c - peak) / peak;
    if (dd < maxDrawdown) maxDrawdown = dd;
  }

  return { symbol, totalReturn, volatility, maxDrawdown };
}

/**
 * Pearson correlation of two return series, aligned on shared timestamps.
 *
 * Returns are keyed by their closing timestamp, so two symbols are paired only on
 * dates where both traded (intersection of the maps). This is more correct than
 * index-alignment: a holiday/half-day that one exchange observes but the other
 * does not would otherwise shift every later return by one and corrupt the result.
 * Needs ≥ 2 overlapping points and non-zero variance on both sides, else null.
 */
export function pearsonOnTime(
  a: Map<number, number>,
  b: Map<number, number>,
): number | null {
  const pairs: Array<[x: number, y: number]> = [];
  for (const [time, av] of a) {
    const bv = b.get(time);
    if (bv !== undefined) pairs.push([av, bv]);
  }
  const n = pairs.length;
  if (n < 2) return null;

  const meanX = pairs.reduce((s, [x]) => s + x, 0) / n;
  const meanY = pairs.reduce((s, [, y]) => s + y, 0) / n;
  let cov = 0;
  let varX = 0;
  let varY = 0;
  for (const [x, y] of pairs) {
    const dx = x - meanX;
    const dy = y - meanY;
    cov += dx * dy;
    varX += dx * dx;
    varY += dy * dy;
  }
  if (varX === 0 || varY === 0) return null;
  return cov / Math.sqrt(varX * varY);
}

/** Rebase each series' closes to start at 100 so different price levels overlay. */
export function rebaseTo100(
  points: ResearchPoint[],
): { time: number; value: number }[] {
  const valid = points.filter(
    (p): p is ResearchPoint & { close: number } =>
      Number.isFinite(p.close) && (p.close as number) > 0,
  );
  const base = valid[0]?.close;
  if (base === undefined) return [];
  return valid.map((p) => ({ time: p.time, value: (p.close / base) * 100 }));
}
