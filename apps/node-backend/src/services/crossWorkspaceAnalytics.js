/**
 * Cross-workspace analytics (ADR-098) — pure, descriptive. Compose Budgeting +
 * Portfolio + Research: net-worth projection cone and cash-aware rebalancing.
 * (The unified-tax surface was removed in ADR-102.) No IO; callers supply the
 * workspace inputs.
 */

import { toDecimal, toNumber, roundToCents } from '../lib/money.js';

/**
 * Net-worth / FI projection cone. Median path = exact monthly compounding
 * (balance·(1+r/12) + contribution); P10/P90 widen parametrically with
 * volatility·√(t years), z≈1.2816 for the 10th/90th percentiles.
 *
 * @param {{ current:number, monthlyContribution:number, annualReturn:number, annualVolatility?:number, months:number }} p
 * @returns {Array<{ month:number, median:number, p10:number, p90:number }>}
 */
export function projectNetWorth({ current, monthlyContribution, annualReturn, annualVolatility = 0, months }) {
  const Z = 1.2816;
  const r = Number(annualReturn) || 0;
  const vol = Number(annualVolatility) || 0;
  const contrib = Number(monthlyContribution) || 0;
  const monthly = r / 12;
  const out = [];
  let bal = Number(current) || 0;
  for (let m = 1; m <= months; m++) {
    bal = bal * (1 + monthly) + contrib;
    const tYears = m / 12;
    const spread = bal * Z * vol * Math.sqrt(tYears);
    out.push({
      month: m,
      median: toNumber(roundToCents(toDecimal(bal))),
      p10: toNumber(roundToCents(toDecimal(bal - spread))),
      p90: toNumber(roundToCents(toDecimal(bal + spread))),
    });
  }
  return out;
}

/**
 * Resolve the cash a rebalance may actually deploy. Negative available cash is
 * floored at 0; an optional user `cap` (e.g. "only deploy €X of my idle cash")
 * is clamped to [0, availableCash] so a stale or hostile cap can never instruct
 * the planner to deploy money that does not exist. `cap` null/non-finite means
 * "no cap" (use the full available cash).
 *
 * @param {{ availableCash:number, cap?:number|null }} p
 * @returns {number}
 */
export function resolveDeployableCash({ availableCash, cap }) {
  const avail = toDecimal(availableCash ?? 0);
  const base = avail.lt(0) ? toDecimal(0) : avail;
  if (cap == null || !Number.isFinite(Number(cap))) return toNumber(roundToCents(base));
  let c = toDecimal(Number(cap));
  if (c.lt(0)) c = toDecimal(0);
  if (c.gt(base)) c = base;
  return toNumber(roundToCents(c));
}

/**
 * Cash-aware rebalancing: deploy `availableCash` into underweight sleeves to move
 * toward `targetWeights`, without selling. Returns per-sleeve deploy amounts that
 * sum EXACTLY to the cash actually deployable (≤ availableCash), weighted by
 * shortfall.
 *
 * @param {{ actualValues:Record<string,number>, targetWeights:Record<string,number>, availableCash:number }} p
 * @returns {Record<string, number>}
 */
export function rebalanceDeployment({ actualValues, targetWeights, availableCash }) {
  const cash = toDecimal(availableCash ?? 0);
  if (cash.lte(0)) return {};
  const actualTotal = Object.values(actualValues ?? {}).reduce((s, v) => s.plus(toDecimal(v ?? 0)), toDecimal(0));
  const totalAfter = actualTotal.plus(cash);

  // Shortfall per sleeve = max(0, desired − actual) where desired = totalAfter·target.
  const shortfalls = {};
  let shortfallSum = toDecimal(0);
  for (const [sleeve, weight] of Object.entries(targetWeights ?? {})) {
    const desired = totalAfter.times(toDecimal(weight ?? 0));
    const actual = toDecimal(actualValues?.[sleeve] ?? 0);
    const short = desired.minus(actual);
    if (short.gt(0)) {
      shortfalls[sleeve] = short;
      shortfallSum = shortfallSum.plus(short);
    }
  }
  if (shortfallSum.lte(0)) return {};

  // Deploy all the cash, split across underweight sleeves in proportion to
  // shortfall (capped at total shortfall when cash exceeds it).
  const deployable = cash.gt(shortfallSum) ? shortfallSum : cash;

  // Independently rounding each sleeve to cents leaves the parts a cent or two
  // off `deployable` (e.g. 33.33×3 = 99.99 of 100.00), and the UI sums them as
  // "total deployed". Largest-remainder reconciliation: round each sleeve, then
  // push the residual cents onto the largest-shortfall sleeve so the parts sum
  // to `deployable` exactly.
  const out = /** @type {Record<string, number>} */ ({});
  let allocated = toDecimal(0);
  let topSleeve = null;
  let topShort = toDecimal(-1);
  for (const [sleeve, short] of Object.entries(shortfalls)) {
    const amount = roundToCents(deployable.times(short).dividedBy(shortfallSum));
    out[sleeve] = toNumber(amount);
    allocated = allocated.plus(amount);
    if (short.gt(topShort)) { topShort = short; topSleeve = sleeve; }
  }
  if (topSleeve != null) {
    const residual = roundToCents(deployable.minus(allocated));
    if (!residual.eq(0)) out[topSleeve] = toNumber(roundToCents(toDecimal(out[topSleeve]).plus(residual)));
  }
  return out;
}
