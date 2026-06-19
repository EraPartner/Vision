/**
 * Cross-workspace analytics (ADR-098) — pure, descriptive. Compose Budgeting +
 * Portfolio + Research: net-worth projection cone, cash-aware rebalancing, and
 * owner-allocated unified tax. No IO; callers supply the workspace inputs.
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
 * Cash-aware rebalancing: deploy `availableCash` into underweight sleeves to move
 * toward `targetWeights`, without selling. Returns per-sleeve deploy amounts that
 * sum to the cash actually deployable (≤ availableCash), weighted by shortfall.
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
  const out = /** @type {Record<string, number>} */ ({});
  for (const [sleeve, short] of Object.entries(shortfalls)) {
    out[sleeve] = toNumber(roundToCents(deployable.times(short).dividedBy(shortfallSum)));
  }
  return out;
}

/**
 * Allocate an amount to owners for the marital quotient: me → all to me,
 * partner → all to partner, joint → 50/50.
 *
 * @param {number} amount
 * @param {'me'|'partner'|'joint'} owner
 * @returns {{ me:number, partner:number }}
 */
export function allocateByOwner(amount, owner) {
  const a = toDecimal(amount ?? 0);
  if (owner === 'partner') return { me: 0, partner: toNumber(roundToCents(a)) };
  if (owner === 'joint') {
    const half = toNumber(roundToCents(a.dividedBy(2)));
    return { me: half, partner: toNumber(roundToCents(a.minus(half))) };
  }
  return { me: toNumber(roundToCents(a)), partner: 0 };
}

/**
 * Unified tax view: sum earned income + realized gains + dividend income into a
 * total and per-owner split. `items` carry { amount, owner, kind }.
 *
 * @param {Array<{ amount:number, owner?:string, kind?:string }>} items
 * @returns {{ total:number, byOwner:{me:number,partner:number}, byKind:Record<string,number> }}
 */
export function unifiedTax(items) {
  let total = toDecimal(0);
  let me = toDecimal(0);
  let partner = toDecimal(0);
  const byKind = /** @type {Record<string, number>} */ ({});
  for (const it of items ?? []) {
    const amt = toDecimal(it.amount ?? 0);
    total = total.plus(amt);
    const split = allocateByOwner(it.amount ?? 0, /** @type {'me'|'partner'|'joint'} */ (it.owner ?? 'me'));
    me = me.plus(toDecimal(split.me));
    partner = partner.plus(toDecimal(split.partner));
    const kind = it.kind ?? 'other';
    byKind[kind] = toNumber(roundToCents(toDecimal(byKind[kind] ?? 0).plus(amt)));
  }
  return {
    total: toNumber(roundToCents(total)),
    byOwner: { me: toNumber(roundToCents(me)), partner: toNumber(roundToCents(partner)) },
    byKind,
  };
}
