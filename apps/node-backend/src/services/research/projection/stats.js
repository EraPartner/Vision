/**
 * Small statistical helpers for the portfolio projection engine.
 * Pure, dependency-free, unit-tested. Kept local to the projection module so the
 * working cash-flow forecast path (services/calculations/forecast) is untouched.
 */

export function mean(arr) {
  if (!arr.length) return 0;
  let s = 0;
  for (const v of arr) s += v;
  return s / arr.length;
}

/** Sample standard deviation (n-1). Returns 0 for fewer than two points. */
export function stdev(arr) {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  let s = 0;
  for (const v of arr) s += (v - m) ** 2;
  return Math.sqrt(s / (arr.length - 1));
}

/** Linear-interpolated percentile of an ascending-sorted array. p in [0,100]. */
export function quantile(sortedAsc, p) {
  if (!sortedAsc.length) return 0;
  const idx = (p / 100) * (sortedAsc.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sortedAsc[lo];
  const frac = idx - lo;
  return sortedAsc[lo] * (1 - frac) + sortedAsc[hi] * frac;
}

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/**
 * Flow-adjusted daily log returns (Modified Dietz, flow assumed at period end).
 *
 * A portfolio's raw `value` series rises for TWO reasons: market moves and
 * external cash flows (a deposit/buy raises cost basis; a withdrawal/sell lowers
 * it). Estimating drift from raw value growth would read every contribution as
 * if the market had returned it — systematically inflating the projected return
 * for anyone who keeps paying in. We strip the flow using the change in cost
 * basis (`invested`) as the period's net external flow:
 *
 *     r_t = (V_t − V_{t−1} − ΔInvested_t) / V_{t−1}
 *
 * which is exactly the day's market P&L (ΔgainLoss) over start-of-day capital.
 *
 * Days whose magnitude exceeds `maxDailyMove` are treated as residual flow
 * artifacts the cost-basis proxy can't fully strip (e.g. a sell whose proceeds
 * leave the tracked portfolio) and dropped rather than poisoning drift/vol.
 * When `invested` is absent the flow term is 0, degrading to a raw value return.
 *
 * @returns {{ returns: number[], droppedDays: number }}
 */
export function flowAdjustedLogReturns(values, invested = [], maxDailyMove = 0.5) {
  const out = [];
  let droppedDays = 0;
  for (let i = 1; i < values.length; i++) {
    const v0 = Number(values[i - 1]);
    const v1 = Number(values[i]);
    if (!(v0 > 0) || !Number.isFinite(v1)) continue;
    const inv0 = Number(invested[i - 1]);
    const inv1 = Number(invested[i]);
    const flow = Number.isFinite(inv0) && Number.isFinite(inv1) ? inv1 - inv0 : 0;
    const r = (v1 - v0 - flow) / v0;
    if (!Number.isFinite(r) || 1 + r <= 0 || Math.abs(r) > maxDailyMove) {
      droppedDays++;
      continue;
    }
    out.push(Math.log(1 + r));
  }
  return { returns: out, droppedDays };
}
