/**
 * Pure memoized calculation functions for portfolio math.
 * No side effects, no queries — only deterministic transforms.
 */

import type { PortfolioTransaction } from '@/types/api';
import { parseYmd, daysBetween, todayLocal } from '@/lib/timezone';

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
        const sellRatio = sellUnits / units;
        const avgCost = totalCost / totalUnits;
        const costOfSoldUnits = avgCost * sellUnits;
        const netProceeds = (amount - fees - taxes) * sellRatio;
        realizedGain += netProceeds - costOfSoldUnits;
        totalUnits -= sellUnits;
        totalCost -= costOfSoldUnits;
        totalSellProceeds += amount;
      }
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

  return principal * (interestRate / 100 / 365) * daysSince;
}

/**
 * Projected annual interest: P * r.
 */
export function calculateProjectedAnnualInterest(
  principal: number,
  interestRate: number
): number {
  if (!interestRate || principal <= 0) return 0;
  return principal * (interestRate / 100);
}
