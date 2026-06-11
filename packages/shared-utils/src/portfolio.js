/**
 * Portfolio math shared by the Vision backend and frontend.
 *
 * Single source of truth for cost-basis accounting (weighted-average / FIFO /
 * LIFO), fixed-income interest accrual, and the per-investment summary core.
 * Both apps previously hand-mirrored these (apps/node-backend/src/utils/
 * portfolioMath.js ↔ apps/frontend/src/hooks/portfolio/*) and drifted —
 * `.abs()` vs 0-clamp on totalInvested, missing FX, unwired cost-basis method.
 *
 * Pure functions only: no IO, no clock reads, no timezone dependency. "Today"
 * and FX multipliers are inputs; callers own conversion, rounding-on-emit, and
 * response shaping.
 */

import Decimal from 'decimal.js';
import { toDecimal, roundToCents, toNumber } from './money.js';

export const UNIT_BASED_CLASSES = new Set(['stock', 'etf', 'crypto', 'metals']);
export const FIXED_INCOME_CLASSES = new Set(['savings', 'bond']);
export const REAL_ESTATE_CLASS = 'real_estate';

/** @typedef {'weighted_avg'|'fifo'|'lifo'} CostBasisMethod */

/**
 * Shared result shape returned by all cost-basis calculators.
 * @typedef {{ totalUnits: number, totalCost: number, avgCostBasis: number, realizedGain: number, totalBuyCost: number, totalSellProceeds: number }} CostBasisResult
 */

/**
 * Whole-day count between two YYYY-MM-DD strings. Pure calendar math (UTC
 * parse on both ends), so the result is identical in every host timezone.
 *
 * @param {string} fromYmd
 * @param {string} toYmd
 * @returns {number}
 */
export function daysBetweenYmd(fromYmd, toYmd) {
  const parse = (s) => {
    const [y, m, d] = String(s).slice(0, 10).split('-').map(Number);
    return Date.UTC(y, m - 1, d);
  };
  return Math.round((parse(toYmd) - parse(fromYmd)) / 86_400_000);
}

/**
 * Apply corporate-action events (split, merger, spinoff, return_of_capital) to
 * a lot array. Called by both FIFO and LIFO helpers.
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
 * @param {Array<{type: string, units?: number|string, amount?: number|string, fees?: number|string, taxes?: number|string, date: string}>} txns
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
 * @param {Array<{type: string, units?: number|string, amount?: number|string, fees?: number|string, taxes?: number|string, date: string}>} txns
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
 * @param {Array<{type: string, units?: number|string, amount?: number|string, fees?: number|string, taxes?: number|string, date: string}>} txns
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
 * @param {CostBasisMethod} [method]
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
 * @param {string} todayYmd - "today" as YYYY-MM-DD in the caller's business timezone
 * @returns {number} Accrued interest amount
 */
export function calculateAccruedInterest(txns, principal, interestRate, todayYmd) {
  if (!interestRate || principal <= 0) return 0;

  const sortedDesc = [...txns].sort((a, b) => b.date.localeCompare(a.date));
  const lastInterestTxn = sortedDesc.find((t) => t.type === 'interest');
  const firstBuyTxn = [...txns]
    .filter((t) => t.type === 'buy')
    .sort((a, b) => a.date.localeCompare(b.date))[0];

  const startDate = lastInterestTxn?.date || firstBuyTxn?.date;
  if (!startDate) return 0;

  const daysSinceStart = Math.max(0, daysBetweenYmd(startDate, todayYmd));

  return toNumber(
    toDecimal(principal)
      .times(toDecimal(interestRate).div(100).div(365))
      .times(daysSinceStart)
  );
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
  return toNumber(toDecimal(principal).times(toDecimal(ratePercent).div(100)));
}

/**
 * Per-investment summary math core — the calculation half of the backend's
 * buildInvestmentSummary and the frontend's buildSummary, expressed once.
 *
 * Everything is computed in the investment's native currency and returned as
 * Decimal instances; the caller applies FX conversion and rounding on emit.
 *
 * @param {{ asset_class: string, current_price?: number|string, interest_rate?: number|string }} inv
 * @param {Array<object>} txns transaction rows ({type, amount, units, fees, taxes, date})
 * @param {{ costBasisMethod?: CostBasisMethod, todayYmd: string }} opts
 * @returns {Record<string, Decimal>} summary fields (totalUnits/avgCostBasis included)
 */
export function buildInvestmentSummaryCore(inv, txns, { costBasisMethod = 'weighted_avg', todayYmd }) {
  const isUnitBased = UNIT_BASED_CLASSES.has(inv.asset_class);
  const isFixedIncome = FIXED_INCOME_CLASSES.has(inv.asset_class);
  const isRealEstate = inv.asset_class === REAL_ESTATE_CLASS;

  const ZERO = toDecimal(0);

  // All running sums are kept as Decimal — IEEE-754 drift on money paths
  // compounds across many transactions before the caller's round-on-emit.
  let totalDividends = ZERO;
  let totalInterestPaid = ZERO;
  let totalRent = ZERO;
  let totalAppreciation = ZERO;
  let totalBuyAmount = ZERO;
  let totalBuyOrGiftAmount = ZERO;
  let totalSellAmount = ZERO;
  let feeTxnAmount = ZERO;
  let taxTxnAmount = ZERO;
  let feesFieldAmount = ZERO;
  let taxesFieldAmount = ZERO;

  for (const txn of txns) {
    const amount = toDecimal(txn.amount);
    feesFieldAmount = feesFieldAmount.plus(toDecimal(txn.fees));
    taxesFieldAmount = taxesFieldAmount.plus(toDecimal(txn.taxes));

    switch (txn.type) {
      case 'buy':          totalBuyAmount = totalBuyAmount.plus(amount); totalBuyOrGiftAmount = totalBuyOrGiftAmount.plus(amount); break;
      case 'gift':         totalBuyOrGiftAmount = totalBuyOrGiftAmount.plus(amount); break;
      case 'sell':         totalSellAmount = totalSellAmount.plus(amount); break;
      case 'fee':          feeTxnAmount = feeTxnAmount.plus(amount); break;
      case 'tax':          taxTxnAmount = taxTxnAmount.plus(amount); break;
      case 'dividend':     totalDividends = totalDividends.plus(amount); break;
      case 'interest':     totalInterestPaid = totalInterestPaid.plus(amount); break;
      case 'rent_income':  totalRent = totalRent.plus(amount); break;
      case 'appreciation': totalAppreciation = totalAppreciation.plus(amount); break;
    }
  }

  const totalFees = feeTxnAmount.plus(feesFieldAmount);
  const totalTaxes = taxTxnAmount.plus(taxesFieldAmount);

  let totalUnits = ZERO;
  let avgCostBasis = ZERO;
  let totalBuyCost;
  let totalSellProceeds;
  let realizedGain = ZERO;
  let unrealizedGain = ZERO;
  let currentValue;
  let totalInvested;
  let accruedInterest = ZERO;
  let projectedInterest = ZERO;

  if (isUnitBased) {
    const cb = calculateCostBasisByMethod(txns, costBasisMethod);
    totalUnits = toDecimal(cb.totalUnits);
    avgCostBasis = toDecimal(cb.avgCostBasis);
    totalBuyCost = toDecimal(cb.totalBuyCost);
    totalSellProceeds = toDecimal(cb.totalSellProceeds);
    totalInvested = toDecimal(cb.totalCost);
    realizedGain = toDecimal(cb.realizedGain);

    const currentPrice = toDecimal(inv.current_price);
    currentValue = totalUnits.times(currentPrice);
    unrealizedGain = totalUnits.gt(0)
      ? currentPrice.minus(avgCostBasis).times(totalUnits)
      : ZERO;
  } else if (isFixedIncome) {
    totalInvested = totalBuyOrGiftAmount.minus(totalSellAmount);
    totalBuyCost = totalBuyOrGiftAmount;
    totalSellProceeds = totalSellAmount;

    const interestRate = Number(inv.interest_rate) || 0;
    accruedInterest = toDecimal(calculateAccruedInterest(txns, totalInvested.toNumber(), interestRate, todayYmd));
    projectedInterest = toDecimal(projectedAnnualInterest(totalInvested.toNumber(), interestRate));

    currentValue = totalInvested.plus(accruedInterest);
    // Interest received is income (already in totalIncome below), exactly like
    // dividends — feeding it into realizedGain too double-counted it in gainLoss.
    realizedGain = ZERO;
    unrealizedGain = accruedInterest;
  } else if (isRealEstate) {
    totalInvested = totalBuyAmount.minus(totalSellAmount);
    totalBuyCost = totalBuyAmount;
    totalSellProceeds = totalSellAmount;
    currentValue = totalInvested.plus(totalAppreciation);
    unrealizedGain = totalAppreciation;
    // Rent is income (folded into totalIncome below), not a realized gain, and
    // fees/taxes are already subtracted once in the shared gainLoss line. Feeding
    // rent−fees−taxes into realizedGain here double-counted all three.
    realizedGain = ZERO;
  } else {
    totalInvested = totalBuyAmount.minus(totalSellAmount);
    totalBuyCost = totalBuyAmount;
    totalSellProceeds = totalSellAmount;
    currentValue = totalInvested;
  }

  const totalIncome = totalDividends.plus(totalInterestPaid).plus(totalRent);
  const totalGain = realizedGain.plus(unrealizedGain);
  // For unit-based assets the per-row fees/taxes *columns* are already folded
  // into cost basis by the calculators (buys add them, sells subtract them),
  // so subtracting totalFees/totalTaxes (= fee/tax tx-types + those columns)
  // would count them twice. Only the standalone fee/tax transaction *types*
  // sit outside cost basis. Other branches keep the full subtraction because
  // their totalInvested excludes the fees/taxes columns.
  const gainLoss = isUnitBased
    ? totalGain.plus(totalIncome).minus(feeTxnAmount).minus(taxTxnAmount)
    : totalGain.plus(totalIncome).minus(totalFees).minus(totalTaxes);
  const gainLossPercent = totalBuyCost.gt(0)
    ? gainLoss.div(totalBuyCost).times(100)
    : ZERO;

  // Clamp at 0 rather than abs(): for fixed-income/real-estate totalInvested =
  // buys − sells can be legitimately negative (sold above contributions), and
  // abs() silently flipped that to a positive "invested" figure. (Unit-based
  // already clamps in the cost-basis calculators.)
  const clampedInvested = totalInvested.gt(0) ? totalInvested : ZERO;

  return {
    totalUnits,
    avgCostBasis,
    totalInvested: clampedInvested,
    totalBuyCost,
    totalSellProceeds,
    currentValue,
    realizedGain,
    unrealizedGain,
    totalGain,
    gainLoss,
    gainLossPercent,
    totalFees,
    totalTaxes,
    feeTxnAmount,
    taxTxnAmount,
    totalDividends,
    totalInterestPaid,
    totalRent,
    totalAppreciation,
    totalIncome,
    accruedInterest,
    projectedAnnualInterest: projectedInterest,
  };
}
