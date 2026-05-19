/**
 * Portfolio Math Utilities
 *
 * Pure functions for portfolio calculations. No I/O, no side effects.
 * Used by both backend services and imported as equivalent TypeScript
 * implementations in frontend hooks.
 */

import { toDecimal, toNumber, roundToCents } from '../lib/money.js';
import { appDateStringToUtc, toAppDateString } from '../lib/timezone.js';
import Decimal from 'decimal.js';

const MS_PER_DAY = 1000 * 60 * 60 * 24;

/**
 * Normalise a date-ish value to a `YYYY-MM-DD` string. Accepts a plain
 * date string (snapshot/txn rows) or a JS `Date` — the `pg` driver returns
 * `DATE` columns as a Date at local midnight, so the local getters recover
 * the exact calendar day.
 *
 * @param {string|Date} value
 * @returns {string}
 */
function toYmd(value) {
  if (value instanceof Date) {
    const y = value.getFullYear();
    const m = String(value.getMonth() + 1).padStart(2, '0');
    const d = String(value.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  return String(value).slice(0, 10);
}

/**
 * Whole-day count between two calendar dates, evaluated in APP_TIMEZONE
 * (ADR-009). Both endpoints are normalised to start-of-day in the app zone
 * so the result is an exact integer, never a TZ-skewed fraction.
 *
 * @param {string|Date} from
 * @param {string|Date} to
 * @returns {number}
 */
export function calendarDaysBetween(from, to) {
  const fromUtc = appDateStringToUtc(toYmd(from));
  const toUtc = appDateStringToUtc(toYmd(to));
  return Math.round((toUtc.getTime() - fromUtc.getTime()) / MS_PER_DAY);
}

/** @typedef {'weighted_avg'|'fifo'|'lifo'} CostBasisMethod */

/**
 * Shared result shape returned by all cost-basis calculators.
 * @typedef {{ totalUnits: number, totalCost: number, avgCostBasis: number, realizedGain: number, totalBuyCost: number, totalSellProceeds: number }} CostBasisResult
 */

/**
 * Apply corporate-action events (split, merger, spinoff, return_of_capital) to
 * a lot array.  Called by both FIFO and LIFO helpers.
 *
 * @param {{ units: Decimal, costBasis: Decimal }[]} lots
 * @param {string} type
 * @param {Decimal} units - new total units after split, or units received from spinoff
 * @param {Decimal} amount - proceeds for return_of_capital
 * @param {Decimal} totalUnits - current total units held
 * @returns {{ totalUnits: Decimal, lots: { units: Decimal, costBasis: Decimal }[] }}
 */
function applyEventToLots(lots, type, units, amount, totalUnits) {
  const ZERO = toDecimal(0);

  if (type === 'split' && totalUnits.gt(0) && units.gt(0)) {
    const ratio = units.dividedBy(totalUnits);
    return {
      totalUnits: units,
      lots: lots.map((lot) => ({ ...lot, units: lot.units.times(ratio) })),
    };
  }

  if (type === 'return_of_capital' && totalUnits.gt(0)) {
    const reductionPerUnit = amount.dividedBy(totalUnits);
    return {
      totalUnits,
      lots: lots.map((lot) => ({
        ...lot,
        costBasis: Decimal.max(ZERO, lot.costBasis.minus(reductionPerUnit.times(lot.units))),
      })),
    };
  }

  // merger / spinoff — treated as cost-basis-neutral events for now
  return { totalUnits, lots };
}

/**
 * Calculate weighted average cost basis using the moving-average method.
 * Buys and gifts increase the position; sells reduce it at the current avg cost.
 * Corporate actions (split, return_of_capital) adjust units / cost basis.
 *
 * @param {Array<{type: string, units: number|string, amount: number|string, fees: number|string, taxes: number|string, date: string}>} txns
 * @returns {CostBasisResult}
 */
export function calculateCostBasis(txns) {
  const sorted = [...txns].sort((a, b) => a.date.localeCompare(b.date));

  const ZERO = toDecimal(0);
  let totalUnits = ZERO;
  let totalCost = ZERO;
  let realizedGain = ZERO;
  let totalBuyCost = ZERO;
  let totalSellProceeds = ZERO;

  for (const txn of sorted) {
    const units = toDecimal(txn.units || 0);
    const amount = toDecimal(txn.amount || 0);
    const fees = toDecimal(txn.fees || 0);
    const taxes = toDecimal(txn.taxes || 0);

    if (txn.type === 'buy' || txn.type === 'gift') {
      const buyCost = amount.plus(fees).plus(taxes);
      totalUnits = totalUnits.plus(units);
      totalCost = totalCost.plus(buyCost);
      totalBuyCost = totalBuyCost.plus(buyCost);
    } else if (txn.type === 'sell') {
      if (totalUnits.gt(0) && units.gt(0)) {
        const sellUnits = Decimal.min(units, totalUnits);
        const sellRatio = units.gt(0) ? sellUnits.dividedBy(units) : ZERO;
        const avgCost = totalCost.dividedBy(totalUnits);
        const costOfSoldUnits = avgCost.times(sellUnits);
        const netProceeds = amount.minus(fees).minus(taxes).times(sellRatio);
        realizedGain = realizedGain.plus(netProceeds.minus(costOfSoldUnits));
        totalUnits = totalUnits.minus(sellUnits);
        totalCost = totalCost.minus(costOfSoldUnits);
        totalSellProceeds = totalSellProceeds.plus(amount.times(sellRatio));
      }
    } else if (txn.type === 'split' && totalUnits.gt(0) && units.gt(0)) {
      // units = new total post-split; cost basis is unchanged
      totalUnits = units;
    } else if (txn.type === 'return_of_capital' && totalUnits.gt(0)) {
      totalCost = Decimal.max(ZERO, totalCost.minus(amount));
    }
  }

  const finalUnits = Decimal.max(ZERO, totalUnits);
  const finalCost = Decimal.max(ZERO, totalCost);
  const avgCostBasis = finalUnits.gt(0) ? finalCost.dividedBy(finalUnits) : ZERO;

  return {
    totalUnits: toNumber(finalUnits),
    totalCost: toNumber(roundToCents(finalCost)),
    avgCostBasis: toNumber(avgCostBasis),
    realizedGain: toNumber(roundToCents(realizedGain)),
    totalBuyCost: toNumber(roundToCents(totalBuyCost)),
    totalSellProceeds: toNumber(roundToCents(totalSellProceeds)),
  };
}

/**
 * Calculate FIFO (first-in, first-out) cost basis.
 * Sells exhaust the oldest lots first.
 *
 * @param {Array<{type: string, units: number|string, amount: number|string, fees: number|string, taxes: number|string, date: string}>} txns
 * @returns {CostBasisResult}
 */
export function calculateCostBasisFIFO(txns) {
  const sorted = [...txns].sort((a, b) => a.date.localeCompare(b.date));

  const ZERO = toDecimal(0);
  /** @type {{ units: Decimal, costBasis: Decimal }[]} */
  let lots = [];
  let totalUnits = ZERO;
  let realizedGain = ZERO;
  let totalBuyCost = ZERO;
  let totalSellProceeds = ZERO;

  for (const txn of sorted) {
    const units = toDecimal(txn.units || 0);
    const amount = toDecimal(txn.amount || 0);
    const fees = toDecimal(txn.fees || 0);
    const taxes = toDecimal(txn.taxes || 0);

    if (txn.type === 'buy' || txn.type === 'gift') {
      const buyCost = amount.plus(fees).plus(taxes);
      lots = [...lots, { units, costBasis: buyCost }];
      totalUnits = totalUnits.plus(units);
      totalBuyCost = totalBuyCost.plus(buyCost);
    } else if (txn.type === 'sell' && units.gt(0)) {
      const sellUnits = Decimal.min(units, totalUnits);
      const sellRatio = units.gt(0) ? sellUnits.dividedBy(units) : ZERO;
      const netProceeds = amount.minus(fees).minus(taxes).times(sellRatio);
      let unitsToSell = sellUnits;
      let costOfSold = ZERO;

      while (unitsToSell.gt(0) && lots.length > 0) {
        const lot = lots[0];
        if (lot.units.lte(unitsToSell)) {
          costOfSold = costOfSold.plus(lot.costBasis);
          unitsToSell = unitsToSell.minus(lot.units);
          lots = lots.slice(1);
        } else {
          const fraction = unitsToSell.dividedBy(lot.units);
          const lotCostUsed = lot.costBasis.times(fraction);
          costOfSold = costOfSold.plus(lotCostUsed);
          lots = [
            { units: lot.units.minus(unitsToSell), costBasis: lot.costBasis.minus(lotCostUsed) },
            ...lots.slice(1),
          ];
          unitsToSell = ZERO;
        }
      }

      totalUnits = totalUnits.minus(sellUnits);
      realizedGain = realizedGain.plus(netProceeds.minus(costOfSold));
      totalSellProceeds = totalSellProceeds.plus(amount.times(sellRatio));
    } else if (txn.type === 'split' || txn.type === 'merger' || txn.type === 'spinoff' || txn.type === 'return_of_capital') {
      const result = applyEventToLots(lots, txn.type, units, amount, totalUnits);
      totalUnits = result.totalUnits;
      lots = result.lots;
    }
  }

  const totalCost = lots.reduce((sum, lot) => sum.plus(lot.costBasis), ZERO);
  const finalUnits = Decimal.max(ZERO, totalUnits);
  const finalCost = Decimal.max(ZERO, totalCost);

  return {
    totalUnits: toNumber(finalUnits),
    totalCost: toNumber(roundToCents(finalCost)),
    avgCostBasis: toNumber(finalUnits.gt(0) ? finalCost.dividedBy(finalUnits) : ZERO),
    realizedGain: toNumber(roundToCents(realizedGain)),
    totalBuyCost: toNumber(roundToCents(totalBuyCost)),
    totalSellProceeds: toNumber(roundToCents(totalSellProceeds)),
  };
}

/**
 * Calculate LIFO (last-in, first-out) cost basis.
 * Sells exhaust the most-recently-acquired lots first.
 *
 * @param {Array<{type: string, units: number|string, amount: number|string, fees: number|string, taxes: number|string, date: string}>} txns
 * @returns {CostBasisResult}
 */
export function calculateCostBasisLIFO(txns) {
  const sorted = [...txns].sort((a, b) => a.date.localeCompare(b.date));

  const ZERO = toDecimal(0);
  /** @type {{ units: Decimal, costBasis: Decimal }[]} */
  let lots = [];
  let totalUnits = ZERO;
  let realizedGain = ZERO;
  let totalBuyCost = ZERO;
  let totalSellProceeds = ZERO;

  for (const txn of sorted) {
    const units = toDecimal(txn.units || 0);
    const amount = toDecimal(txn.amount || 0);
    const fees = toDecimal(txn.fees || 0);
    const taxes = toDecimal(txn.taxes || 0);

    if (txn.type === 'buy' || txn.type === 'gift') {
      const buyCost = amount.plus(fees).plus(taxes);
      lots = [...lots, { units, costBasis: buyCost }];
      totalUnits = totalUnits.plus(units);
      totalBuyCost = totalBuyCost.plus(buyCost);
    } else if (txn.type === 'sell' && units.gt(0)) {
      const sellUnits = Decimal.min(units, totalUnits);
      const sellRatio = units.gt(0) ? sellUnits.dividedBy(units) : ZERO;
      const netProceeds = amount.minus(fees).minus(taxes).times(sellRatio);
      let unitsToSell = sellUnits;
      let costOfSold = ZERO;

      while (unitsToSell.gt(0) && lots.length > 0) {
        const lot = lots[lots.length - 1];
        if (lot.units.lte(unitsToSell)) {
          costOfSold = costOfSold.plus(lot.costBasis);
          unitsToSell = unitsToSell.minus(lot.units);
          lots = lots.slice(0, -1);
        } else {
          const fraction = unitsToSell.dividedBy(lot.units);
          const lotCostUsed = lot.costBasis.times(fraction);
          costOfSold = costOfSold.plus(lotCostUsed);
          lots = [
            ...lots.slice(0, -1),
            { units: lot.units.minus(unitsToSell), costBasis: lot.costBasis.minus(lotCostUsed) },
          ];
          unitsToSell = ZERO;
        }
      }

      totalUnits = totalUnits.minus(sellUnits);
      realizedGain = realizedGain.plus(netProceeds.minus(costOfSold));
      totalSellProceeds = totalSellProceeds.plus(amount.times(sellRatio));
    } else if (txn.type === 'split' || txn.type === 'merger' || txn.type === 'spinoff' || txn.type === 'return_of_capital') {
      const result = applyEventToLots(lots, txn.type, units, amount, totalUnits);
      totalUnits = result.totalUnits;
      lots = result.lots;
    }
  }

  const totalCost = lots.reduce((sum, lot) => sum.plus(lot.costBasis), ZERO);
  const finalUnits = Decimal.max(ZERO, totalUnits);
  const finalCost = Decimal.max(ZERO, totalCost);

  return {
    totalUnits: toNumber(finalUnits),
    totalCost: toNumber(roundToCents(finalCost)),
    avgCostBasis: toNumber(finalUnits.gt(0) ? finalCost.dividedBy(finalUnits) : ZERO),
    realizedGain: toNumber(roundToCents(realizedGain)),
    totalBuyCost: toNumber(roundToCents(totalBuyCost)),
    totalSellProceeds: toNumber(roundToCents(totalSellProceeds)),
  };
}

/**
 * Dispatch to the correct cost-basis calculator based on `method`.
 *
 * @param {Array} txns
 * @param {CostBasisMethod} method
 * @returns {CostBasisResult}
 */
export function calculateCostBasisByMethod(txns, method) {
  if (method === 'fifo') return calculateCostBasisFIFO(txns);
  if (method === 'lifo') return calculateCostBasisLIFO(txns);
  return calculateCostBasis(txns); // default: weighted_avg
}

/**
 * Calculate accrued simple interest for fixed-income assets.
 * Clock starts from last interest payment date, or first buy if no payments yet.
 *
 * @param {Array<{type: string, date: string}>} txns
 * @param {number} principal - Current invested principal
 * @param {number} interestRate - Annual rate as a percentage (e.g. 3.5 for 3.5%)
 * @returns {number} Accrued interest amount
 */
export function calculateAccruedInterest(txns, principal, interestRate) {
  if (!interestRate || principal <= 0) return 0;

  const sortedDesc = [...txns].sort((a, b) => b.date.localeCompare(a.date));
  const lastInterestTxn = sortedDesc.find(t => t.type === 'interest');
  const firstBuyTxn = [...txns]
    .filter(t => t.type === 'buy')
    .sort((a, b) => a.date.localeCompare(b.date))[0];

  const startDate = lastInterestTxn?.date || firstBuyTxn?.date;
  if (!startDate) return 0;

  // Count whole calendar days in APP_TIMEZONE — mixing a UTC-midnight start
  // with a wall-clock `new Date()` skewed the day count by up to a day.
  const daysSinceStart = Math.max(0, calendarDaysBetween(startDate, toAppDateString(new Date())));

  const dailyRate = interestRate / 100 / 365;
  return principal * dailyRate * daysSinceStart;
}

/**
 * Calculate projected annual interest for fixed-income assets.
 *
 * @param {number} principal
 * @param {number} ratePercent - Annual rate as a percentage
 * @returns {number}
 */
export function projectedAnnualInterest(principal, ratePercent) {
  if (!ratePercent || principal <= 0) return 0;
  return principal * (ratePercent / 100);
}

/**
 * Compute annualized return (CAGR) from total return and holding period.
 *
 * @param {number} currentValue
 * @param {number} totalInvested
 * @param {number} days - Holding period in days
 * @returns {number} Annualized return as a percentage
 */
export function annualizedReturn(currentValue, totalInvested, days) {
  if (totalInvested <= 0 || days <= 0 || currentValue <= 0) return 0;
  const years = days / 365.25;
  const result = (Math.pow(currentValue / totalInvested, 1 / years) - 1) * 100;
  return Number.isFinite(result) ? result : 0;
}

/**
 * Compute contribution-adjusted monthly return.
 * Isolates investment performance from cash flow effects (deposits/withdrawals).
 *
 * Formula: ((currValue/currInvested) / (prevValue/prevInvested) - 1) * 100
 *
 * @param {number} currValue
 * @param {number} currInvested
 * @param {number} prevValue
 * @param {number} prevInvested
 * @returns {number|null} Monthly return percentage, or null when inputs are invalid
 */
export function contributionAdjustedMonthlyReturn(currValue, currInvested, prevValue, prevInvested) {
  if (prevInvested <= 0 || currInvested <= 0 || prevValue <= 0) return null;
  return ((currValue / currInvested) / (prevValue / prevInvested) - 1) * 100;
}

/**
 * Compute overall portfolio metrics from the full snapshot array.
 * Ported from PerformancePage.tsx overallMetrics useMemo.
 *
 * @param {Array<{snapshot_date: string, invested: string|number, value: string|number, gain_loss: string|number, inflation_adjusted_value: string|number}>} snapshots
 * @returns {object|null}
 */
export function computeMetrics(snapshots) {
  if (!snapshots || snapshots.length < 1) return null;

  const first = snapshots[0];
  const last = snapshots[snapshots.length - 1];

  const days = Math.max(1, calendarDaysBetween(first.snapshot_date, last.snapshot_date));

  const totalInvested = toNumber(toDecimal(last.invested));
  const currentValue = toNumber(toDecimal(last.value));
  const totalGainLoss = toNumber(toDecimal(last.gain_loss));
  const inflationAdjustedValue = toNumber(toDecimal(last.inflation_adjusted_value));

  const totalReturnPct = totalInvested > 0
    ? (totalGainLoss / totalInvested) * 100
    : 0;

  const cagr = annualizedReturn(currentValue, totalInvested, days);

  const realReturnPct = totalInvested > 0
    ? ((inflationAdjustedValue - totalInvested) / totalInvested) * 100
    : 0;

  const cumulativeInflation = currentValue > 0 && inflationAdjustedValue > 0
    ? ((currentValue / inflationAdjustedValue) - 1) * 100
    : 0;

  const round2 = (v) => Math.round(v * 100) / 100;

  return {
    currentValue: round2(currentValue),
    totalInvested: round2(totalInvested),
    totalGainLoss: round2(totalGainLoss),
    totalReturnPct: round2(totalReturnPct),
    annualizedReturn: round2(cagr),
    realReturnPct: round2(realReturnPct),
    cumulativeInflation: Math.round(cumulativeInflation * 10) / 10,
  };
}

/**
 * Compute monthly returns heatmap from the full snapshot array.
 * Uses contribution-adjusted formula to isolate performance from cash flows.
 *
 * @param {Array<{snapshot_date: string, value: string|number, invested: string|number}>} snapshots
 * @returns {{ years: number[], data: Record<number, (number|null)[]>, maxAbsPct: number }}
 */
export function computeHeatmap(snapshots) {
  if (!snapshots || snapshots.length < 2) {
    return { years: [], data: {}, maxAbsPct: 0 };
  }

  // Normalise each snapshot's date to a YYYY-MM-DD string, then sort
  // ascending — the input order is not guaranteed, and "last snapshot of the
  // month" only holds if we iterate in date order.
  const withDate = snapshots.map((s) => ({
    snap: s,
    dateStr: typeof s.snapshot_date === 'string'
      ? s.snapshot_date
      : /** @type {Date} */ (s.snapshot_date).toISOString().slice(0, 10),
  }));
  withDate.sort((a, b) => a.dateStr.localeCompare(b.dateStr));

  // Group by month — take the last (latest-dated) snapshot of each month.
  /** @type {Map<string, { snapshot_date: string|Date, value: string|number, invested: string|number }>} */
  const byMonth = new Map();
  for (const { snap, dateStr } of withDate) {
    byMonth.set(dateStr.slice(0, 7), snap);
  }

  const monthKeys = [...byMonth.keys()].sort();
  const years = [...new Set(monthKeys.map(k => parseInt(k.slice(0, 4))))].sort();
  /** @type {Record<number, (number|null)[]>} */
  const data = {};
  const monthlyReturns = [];

  for (const year of years) {
    data[year] = Array(12).fill(null);
  }

  for (let i = 1; i < monthKeys.length; i++) {
    // Only compute a monthly return between *consecutive* calendar months.
    // monthKeys skips months with no snapshot, so a Jan→Mar pair would
    // otherwise be charted as March's one-month return when it spans two.
    const [py, pm] = monthKeys[i - 1].split('-').map(Number);
    const [cy, cm] = monthKeys[i].split('-').map(Number);
    if (cy * 12 + cm !== py * 12 + pm + 1) continue;

    const prev = byMonth.get(monthKeys[i - 1]);
    const curr = byMonth.get(monthKeys[i]);
    const year = parseInt(monthKeys[i].slice(0, 4));
    const monthIdx = parseInt(monthKeys[i].slice(5, 7)) - 1;

    const monthlyReturn = contributionAdjustedMonthlyReturn(
      toNumber(toDecimal(curr.value)),
      toNumber(toDecimal(curr.invested)),
      toNumber(toDecimal(prev.value)),
      toNumber(toDecimal(prev.invested)),
    );

    const rounded = monthlyReturn !== null ? Math.round(monthlyReturn * 100) / 100 : null;
    data[year][monthIdx] = rounded;
    if (rounded !== null) {
      monthlyReturns.push(Math.abs(rounded));
    }
  }

  return {
    years,
    data,
    maxAbsPct: monthlyReturns.length > 0 ? Math.max(...monthlyReturns) : 0,
  };
}

/**
 * Sanitize isolated daily value spikes in portfolio snapshots.
 * Uses log-ratio comparison to detect and replace single-day anomalies
 * with geometric mean of neighbors.
 *
 * @param {Array<{value: number|string, stocks_etfs_value?: number|string, crypto_value?: number|string, metals_value?: number|string}>} snapshots
 * @returns {Array} Sanitized copy (no mutation of input)
 */
export function sanitizeSnapshotSpikes(snapshots) {
  if (!Array.isArray(snapshots) || snapshots.length < 3) {
    return Array.isArray(snapshots) ? snapshots : [];
  }

  const sanitized = snapshots.map((s) => ({ ...s }));
  const minJump = Math.log(1.18);
  const neighborTolerance = Math.log(1.12);

  const geoMean = (a, b) => {
    const va = Number(a) || 0;
    const vb = Number(b) || 0;
    return va > 0 && vb > 0 ? Math.sqrt(va * vb) : (va + vb) / 2;
  };

  for (let i = 1; i < sanitized.length - 1; i++) {
    const prev = Number(sanitized[i - 1]?.value);
    const current = Number(sanitized[i]?.value);
    const next = Number(sanitized[i + 1]?.value);

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
    const localNeedleRatio = 1.8;
    const localNeedlePeak = current >= maxNeighbor * localNeedleRatio;
    const localNeedleTrough = current * localNeedleRatio <= minNeighbor;

    if ((oppositeDirections && largeMove && bridgeLooksNormal) || localNeedlePeak || localNeedleTrough) {
      sanitized[i].value = geoMean(prev, next);
      sanitized[i].stocks_etfs_value = geoMean(
        sanitized[i - 1]?.stocks_etfs_value, sanitized[i + 1]?.stocks_etfs_value
      );
      sanitized[i].crypto_value = geoMean(
        sanitized[i - 1]?.crypto_value, sanitized[i + 1]?.crypto_value
      );
      sanitized[i].metals_value = geoMean(
        sanitized[i - 1]?.metals_value, sanitized[i + 1]?.metals_value
      );
    }
  }

  return sanitized;
}
