/**
 * Portfolio Math Utilities
 *
 * Pure functions for portfolio calculations. No I/O, no side effects.
 * Used by both backend services and imported as equivalent TypeScript
 * implementations in frontend hooks.
 */

import { toDecimal, toNumber } from '../lib/money.js';

/** @typedef {'weighted_avg'|'fifo'|'lifo'} CostBasisMethod */

/**
 * Shared result shape returned by all cost-basis calculators.
 * @typedef {{ totalUnits: number, totalCost: number, avgCostBasis: number, realizedGain: number, totalBuyCost: number, totalSellProceeds: number }} CostBasisResult
 */

/**
 * Apply corporate-action events (split, merger, spinoff, return_of_capital) to
 * a mutable lot array in-place.  Called by both FIFO and LIFO helpers.
 *
 * @param {{ units: number, costBasis: number }[]} lots - mutable array of open lots
 * @param {string} type
 * @param {number} units - new total units after split, or units received from spinoff
 * @param {number} amount - proceeds for return_of_capital
 * @param {number} totalUnits - current total units held
 * @returns {{ totalUnits: number }} updated totalUnits
 */
function applyEventToLots(lots, type, units, amount, totalUnits) {
  if (type === 'split' && totalUnits > 0 && units > 0) {
    // `units` is the post-split total; scale every lot proportionally.
    const ratio = units / totalUnits;
    for (const lot of lots) {
      lot.costBasis = lot.costBasis; // cost basis per lot unchanged
      lot.units = lot.units * ratio;
    }
    return { totalUnits: units };
  }

  if (type === 'return_of_capital' && totalUnits > 0) {
    // Reduces cost basis per unit for each open lot.
    const reductionPerUnit = amount / totalUnits;
    for (const lot of lots) {
      lot.costBasis = Math.max(0, lot.costBasis - reductionPerUnit * lot.units);
    }
    return { totalUnits };
  }

  // merger / spinoff — treated as cost-basis-neutral events for now;
  // the caller can still apply amount as additional cost if needed.
  return { totalUnits };
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

  let totalUnits = 0;
  let totalCost = 0;
  let realizedGain = 0;
  let totalBuyCost = 0;
  let totalSellProceeds = 0;

  for (const txn of sorted) {
    const units = Number(txn.units) || 0;
    const amount = Number(txn.amount) || 0;
    const fees = Number(txn.fees) || 0;
    const taxes = Number(txn.taxes) || 0;

    if (txn.type === 'buy' || txn.type === 'gift') {
      const buyCost = amount + fees + taxes;
      totalUnits += units;
      totalCost += buyCost;
      totalBuyCost += buyCost;
    } else if (txn.type === 'sell') {
      if (totalUnits > 0 && units > 0) {
        const sellUnits = Math.min(units, totalUnits);
        const sellRatio = units > 0 ? sellUnits / units : 0;
        const avgCost = totalCost / totalUnits;
        const costOfSoldUnits = avgCost * sellUnits;
        const netProceeds = (amount - fees - taxes) * sellRatio;
        realizedGain += netProceeds - costOfSoldUnits;
        totalUnits -= sellUnits;
        totalCost -= costOfSoldUnits;
        totalSellProceeds += amount;
      }
    } else if (txn.type === 'split' && totalUnits > 0 && units > 0) {
      // units = new total post-split; cost basis is unchanged
      totalUnits = units;
    } else if (txn.type === 'return_of_capital' && totalUnits > 0) {
      totalCost = Math.max(0, totalCost - amount);
    }
  }

  return {
    totalUnits: Math.max(0, totalUnits),
    totalCost: Math.max(0, totalCost),
    avgCostBasis: totalUnits > 0 ? totalCost / totalUnits : 0,
    realizedGain,
    totalBuyCost,
    totalSellProceeds,
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

  /** @type {{ units: number, costBasis: number }[]} */
  const lots = [];
  let totalUnits = 0;
  let realizedGain = 0;
  let totalBuyCost = 0;
  let totalSellProceeds = 0;

  for (const txn of sorted) {
    const units = Number(txn.units) || 0;
    const amount = Number(txn.amount) || 0;
    const fees = Number(txn.fees) || 0;
    const taxes = Number(txn.taxes) || 0;

    if (txn.type === 'buy' || txn.type === 'gift') {
      const buyCost = amount + fees + taxes;
      lots.push({ units, costBasis: buyCost });
      totalUnits += units;
      totalBuyCost += buyCost;
    } else if (txn.type === 'sell' && units > 0) {
      let unitsToSell = Math.min(units, totalUnits);
      const netProceeds = amount - fees - taxes;
      let costOfSold = 0;

      while (unitsToSell > 0 && lots.length > 0) {
        const lot = lots[0];
        if (lot.units <= unitsToSell) {
          costOfSold += lot.costBasis;
          unitsToSell -= lot.units;
          totalUnits -= lot.units;
          lots.shift();
        } else {
          const fraction = unitsToSell / lot.units;
          const lotCostUsed = lot.costBasis * fraction;
          costOfSold += lotCostUsed;
          lot.costBasis -= lotCostUsed;
          lot.units -= unitsToSell;
          totalUnits -= unitsToSell;
          unitsToSell = 0;
        }
      }

      realizedGain += netProceeds - costOfSold;
      totalSellProceeds += amount;
    } else if (txn.type === 'split' || txn.type === 'merger' || txn.type === 'spinoff' || txn.type === 'return_of_capital') {
      const result = applyEventToLots(lots, txn.type, units, amount, totalUnits);
      totalUnits = result.totalUnits;
    }
  }

  const totalCost = lots.reduce((sum, lot) => sum + lot.costBasis, 0);

  return {
    totalUnits: Math.max(0, totalUnits),
    totalCost: Math.max(0, totalCost),
    avgCostBasis: totalUnits > 0 ? totalCost / totalUnits : 0,
    realizedGain,
    totalBuyCost,
    totalSellProceeds,
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

  /** @type {{ units: number, costBasis: number }[]} */
  const lots = [];
  let totalUnits = 0;
  let realizedGain = 0;
  let totalBuyCost = 0;
  let totalSellProceeds = 0;

  for (const txn of sorted) {
    const units = Number(txn.units) || 0;
    const amount = Number(txn.amount) || 0;
    const fees = Number(txn.fees) || 0;
    const taxes = Number(txn.taxes) || 0;

    if (txn.type === 'buy' || txn.type === 'gift') {
      const buyCost = amount + fees + taxes;
      lots.push({ units, costBasis: buyCost });
      totalUnits += units;
      totalBuyCost += buyCost;
    } else if (txn.type === 'sell' && units > 0) {
      let unitsToSell = Math.min(units, totalUnits);
      const netProceeds = amount - fees - taxes;
      let costOfSold = 0;

      while (unitsToSell > 0 && lots.length > 0) {
        const lot = lots[lots.length - 1];
        if (lot.units <= unitsToSell) {
          costOfSold += lot.costBasis;
          unitsToSell -= lot.units;
          totalUnits -= lot.units;
          lots.pop();
        } else {
          const fraction = unitsToSell / lot.units;
          const lotCostUsed = lot.costBasis * fraction;
          costOfSold += lotCostUsed;
          lot.costBasis -= lotCostUsed;
          lot.units -= unitsToSell;
          totalUnits -= unitsToSell;
          unitsToSell = 0;
        }
      }

      realizedGain += netProceeds - costOfSold;
      totalSellProceeds += amount;
    } else if (txn.type === 'split' || txn.type === 'merger' || txn.type === 'spinoff' || txn.type === 'return_of_capital') {
      const result = applyEventToLots(lots, txn.type, units, amount, totalUnits);
      totalUnits = result.totalUnits;
    }
  }

  const totalCost = lots.reduce((sum, lot) => sum + lot.costBasis, 0);

  return {
    totalUnits: Math.max(0, totalUnits),
    totalCost: Math.max(0, totalCost),
    avgCostBasis: totalUnits > 0 ? totalCost / totalUnits : 0,
    realizedGain,
    totalBuyCost,
    totalSellProceeds,
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

  const start = new Date(startDate);
  const now = new Date();
  const daysSinceStart = Math.max(0, (now.getTime() - start.getTime()) / (1000 * 60 * 60 * 24));

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

  const firstDate = new Date(first.snapshot_date);
  const lastDate = new Date(last.snapshot_date);
  const days = Math.max(1, Math.round((lastDate - firstDate) / (1000 * 60 * 60 * 24)));

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

  // Group by month — take last snapshot of each month
  const byMonth = new Map();
  for (const s of snapshots) {
    const date = typeof s.snapshot_date === 'string'
      ? s.snapshot_date
      : s.snapshot_date.toISOString().slice(0, 10);
    const month = date.slice(0, 7);
    byMonth.set(month, s);
  }

  const monthKeys = [...byMonth.keys()].sort();
  const years = [...new Set(monthKeys.map(k => parseInt(k.slice(0, 4))))].sort();
  const data = {};
  const monthlyReturns = [];

  for (const year of years) {
    data[year] = Array(12).fill(null);
  }

  for (let i = 1; i < monthKeys.length; i++) {
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
