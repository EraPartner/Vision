/**
 * Composes investment queries + pure calculations into InvestmentSummary[].
 * Provides totals and byAssetClass() filtered view.
 */

import { useCallback, useMemo } from 'react';
import type { AssetClass, Investment, PortfolioTransaction } from '@/types/api';
import type { InvestmentSummary } from '@/types/portfolio';
import {
  calculateCostBasis,
  calculateAccruedInterest,
  calculateProjectedAnnualInterest,
} from './usePortfolioCalculations';
import { isUnitBased, isFixedIncome, isRealEstate } from '@/utils/assetClass';

function buildSummary(
  inv: Investment,
  txns: PortfolioTransaction[]
): InvestmentSummary {
  const unitBased = isUnitBased(inv.asset_class as AssetClass);
  const fixedIncome = isFixedIncome(inv.asset_class as AssetClass);
  const realEstate = isRealEstate(inv.asset_class as AssetClass);

  let feeTxnAmount = 0;
  let taxTxnAmount = 0;
  let feesFieldAmount = 0;
  let taxesFieldAmount = 0;
  let totalDividends = 0;
  let totalInterestPaid = 0;
  let totalRent = 0;
  let totalAppreciation = 0;
  let totalBuyAmount = 0;
  let totalBuyOrGiftAmount = 0;
  let totalSellAmount = 0;

  for (const txn of txns) {
    const amount = Number(txn.amount) || 0;
    feesFieldAmount += Number(txn.fees) || 0;
    taxesFieldAmount += Number(txn.taxes) || 0;

    switch (txn.type) {
      case 'buy':
        totalBuyAmount += amount;
        totalBuyOrGiftAmount += amount;
        break;
      case 'gift':
        totalBuyOrGiftAmount += amount;
        break;
      case 'sell':
        totalSellAmount += amount;
        break;
      case 'fee':
        feeTxnAmount += amount;
        break;
      case 'tax':
        taxTxnAmount += amount;
        break;
      case 'dividend':
        totalDividends += amount;
        break;
      case 'interest':
        totalInterestPaid += amount;
        break;
      case 'rent_income':
        totalRent += amount;
        break;
      case 'appreciation':
        totalAppreciation += amount;
        break;
    }
  }

  const totalFees = feeTxnAmount + feesFieldAmount;
  const totalTaxes = taxTxnAmount + taxesFieldAmount;

  let totalUnits = 0;
  let avgCostBasis = 0;
  let realizedGain = 0;
  let unrealizedGain = 0;
  let currentValue: number;
  let totalInvested: number;
  let totalBuyCost = 0;
  let totalSellProceeds = 0;
  let accruedInterest = 0;
  let projectedAnnualInterest = 0;

  if (unitBased) {
    const cb = calculateCostBasis(txns);
    totalUnits = cb.totalUnits;
    avgCostBasis = cb.avgCostBasis;
    realizedGain = cb.realizedGain;
    totalBuyCost = cb.totalBuyCost;
    totalSellProceeds = cb.totalSellProceeds;
    totalInvested = cb.totalCost;

    const currentPrice = Number(inv.current_price) || 0;
    currentValue = totalUnits * currentPrice;
    unrealizedGain = totalUnits > 0 ? (currentPrice - avgCostBasis) * totalUnits : 0;
  } else if (fixedIncome) {
    totalInvested = totalBuyOrGiftAmount - totalSellAmount;
    totalBuyCost = totalBuyOrGiftAmount;
    totalSellProceeds = totalSellAmount;

    const interestRate = Number(inv.interest_rate) || 0;
    accruedInterest = calculateAccruedInterest(txns, totalInvested, interestRate);
    projectedAnnualInterest = calculateProjectedAnnualInterest(totalInvested, interestRate);

    currentValue = totalInvested + accruedInterest;
    realizedGain = totalInterestPaid;
    unrealizedGain = accruedInterest;
  } else if (realEstate) {
    totalInvested = totalBuyAmount - totalSellAmount;
    totalBuyCost = totalBuyAmount;
    totalSellProceeds = totalSellAmount;
    currentValue = totalInvested + totalAppreciation;
    unrealizedGain = totalAppreciation;
    realizedGain = totalRent - totalFees - totalTaxes;
  } else {
    totalInvested = totalBuyAmount - totalSellAmount;
    currentValue = totalInvested;
  }

  const totalIncome = totalDividends + totalInterestPaid + totalRent;
  const totalGain = realizedGain + unrealizedGain;
  const gainLoss = totalGain + totalIncome - totalFees - totalTaxes;
  const gainLossPercent = totalBuyCost > 0 ? (gainLoss / totalBuyCost) * 100 : 0;

  return {
    ...inv,
    assetClass: inv.asset_class,
    totalUnits,
    totalInvested: Math.abs(totalInvested),
    totalFees,
    totalTaxes,
    totalDividends,
    totalIncome,
    currentValue,
    currentPrice: Number(inv.current_price) || undefined,
    interestRate: Number(inv.interest_rate) || undefined,
    avgCostBasis,
    realizedGain,
    unrealizedGain,
    totalGain,
    gainLoss,
    gainLossPercent,
    accruedInterest,
    projectedAnnualInterest,
    totalAppreciation,
    totalBuyCost,
    totalSellProceeds,
    transactions: txns,
  } as InvestmentSummary;
}

interface UsePortfolioSummariesInput {
  investments: Investment[];
  transactions: PortfolioTransaction[];
}

export function usePortfolioSummaries({
  investments,
  transactions,
}: UsePortfolioSummariesInput) {
  const summaries: InvestmentSummary[] = useMemo(() => {
    const txnsByInvestment = new Map<number, PortfolioTransaction[]>();
    for (const txn of transactions) {
      const bucket = txnsByInvestment.get(txn.investment_id);
      if (bucket) bucket.push(txn);
      else txnsByInvestment.set(txn.investment_id, [txn]);
    }

    return investments.map((inv) =>
      buildSummary(inv, txnsByInvestment.get(inv.id) ?? [])
    );
  }, [investments, transactions]);

  const totals = useMemo(
    () =>
      summaries.reduce(
        (acc, item) => ({
          totalPortfolioValue: acc.totalPortfolioValue + item.currentValue,
          totalGainLoss: acc.totalGainLoss + item.gainLoss,
          totalRealizedGain: acc.totalRealizedGain + item.realizedGain,
          totalUnrealizedGain: acc.totalUnrealizedGain + item.unrealizedGain,
        }),
        {
          totalPortfolioValue: 0,
          totalGainLoss: 0,
          totalRealizedGain: 0,
          totalUnrealizedGain: 0,
        }
      ),
    [summaries]
  );

  const byAssetClass = useCallback(
    (cls: AssetClass | AssetClass[]) => {
      const classes = Array.isArray(cls) ? cls : [cls];
      return summaries.filter((s) => classes.includes(s.assetClass));
    },
    [summaries]
  );

  return { summaries, totals, byAssetClass };
}
