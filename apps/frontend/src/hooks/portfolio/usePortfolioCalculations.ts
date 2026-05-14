/**
 * Pure memoized calculation functions for portfolio math.
 * No side effects, no queries — only deterministic transforms.
 */

import type { PortfolioTransaction } from '@/types/api';
import { parseYmd, daysBetween, todayLocal } from '@/lib/timezone';
import { toDecimal, toNumber, Decimal } from '@/lib/money';

export interface CostBasisResult {
  totalUnits: number;
  totalCost: number;
  avgCostBasis: number;
  realizedGain: number;
  totalBuyCost: number;
  totalSellProceeds: number;
}

/**
 * Weighted average cost basis using FIFO-like weighted method.
 * Fees/taxes added to cost on buys, subtracted from proceeds on sells.
 */
export function calculateCostBasis(txns: PortfolioTransaction[]): CostBasisResult {
  const sorted = [...txns].sort((a, b) => a.date.localeCompare(b.date));

  const ZERO = new Decimal(0);
  let totalUnits = ZERO;
  let totalCost = ZERO;
  let realizedGain = ZERO;
  let totalBuyCost = ZERO;
  let totalSellProceeds = ZERO;

  for (const txn of sorted) {
    const units = toDecimal(txn.units);
    const amount = toDecimal(txn.amount);
    const fees = toDecimal(txn.fees);
    const taxes = toDecimal(txn.taxes);

    if (txn.type === 'buy' || txn.type === 'gift') {
      const buyCost = amount.plus(fees).plus(taxes);
      totalUnits = totalUnits.plus(units);
      totalCost = totalCost.plus(buyCost);
      totalBuyCost = totalBuyCost.plus(buyCost);
    } else if (txn.type === 'sell') {
      if (totalUnits.gt(0) && units.gt(0)) {
        const sellUnits = Decimal.min(units, totalUnits);
        const sellRatio = sellUnits.div(units);
        const avgCost = totalCost.div(totalUnits);
        const costOfSoldUnits = avgCost.times(sellUnits);
        const netProceeds = amount.minus(fees).minus(taxes).times(sellRatio);
        realizedGain = realizedGain.plus(netProceeds.minus(costOfSoldUnits));
        totalUnits = totalUnits.minus(sellUnits);
        totalCost = totalCost.minus(costOfSoldUnits);
        // Scale proceeds by sellRatio so it stays consistent with the
        // realized-gain calculation above (was: full `amount`).
        totalSellProceeds = totalSellProceeds.plus(amount.times(sellRatio));
      }
    }
  }

  const finalUnits = Decimal.max(0, totalUnits);
  const finalCost = Decimal.max(0, totalCost);

  return {
    totalUnits: toNumber(finalUnits),
    totalCost: toNumber(finalCost),
    avgCostBasis: finalUnits.gt(0) ? toNumber(finalCost.div(finalUnits)) : 0,
    realizedGain: toNumber(realizedGain),
    totalBuyCost: toNumber(totalBuyCost),
    totalSellProceeds: toNumber(totalSellProceeds),
  };
}

/**
 * Accrued simple interest since last interest payment (or first buy).
 * P * r * t where t is fraction of year elapsed.
 */
export function calculateAccruedInterest(
  txns: PortfolioTransaction[],
  principal: number,
  interestRate: number
): number {
  if (!interestRate || principal <= 0) return 0;

  const sortedDesc = [...txns].sort((a, b) => b.date.localeCompare(a.date));
  const lastInterestTxn = sortedDesc.find((t) => t.type === 'interest');
  const firstBuyTxn = txns
    .filter((t) => t.type === 'buy')
    .sort((a, b) => a.date.localeCompare(b.date))[0];

  const startDate = lastInterestTxn?.date ?? firstBuyTxn?.date;
  if (!startDate) return 0;

  const daysSince = Math.max(0, daysBetween(parseYmd(startDate), todayLocal()));

  return toNumber(
    toDecimal(principal)
      .times(toDecimal(interestRate).div(100).div(365))
      .times(daysSince)
  );
}

/**
 * Projected annual interest: P * r.
 */
export function calculateProjectedAnnualInterest(
  principal: number,
  interestRate: number
): number {
  if (!interestRate || principal <= 0) return 0;
  return toNumber(toDecimal(principal).times(toDecimal(interestRate).div(100)));
}
