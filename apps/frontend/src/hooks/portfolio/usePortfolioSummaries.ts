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
import { toDecimal, addAll, divide, toNumber, Decimal } from '@/lib/money';

function buildSummary(
  inv: Investment,
  txns: PortfolioTransaction[]
): InvestmentSummary {
  const unitBased = isUnitBased(inv.asset_class as AssetClass);
  const fixedIncome = isFixedIncome(inv.asset_class as AssetClass);
  const realEstate = isRealEstate(inv.asset_class as AssetClass);

  // Running sums are kept as Decimal — float drift on money paths compounds
  // across many transactions before the values reach the UI.
  let feeTxnAmount = new Decimal(0);
  let taxTxnAmount = new Decimal(0);
  let feesFieldAmount = new Decimal(0);
  let taxesFieldAmount = new Decimal(0);
  let totalDividends = new Decimal(0);
  let totalInterestPaid = new Decimal(0);
  let totalRent = new Decimal(0);
  let totalAppreciation = new Decimal(0);
  let totalBuyAmount = new Decimal(0);
  let totalBuyOrGiftAmount = new Decimal(0);
  let totalSellAmount = new Decimal(0);

  for (const txn of txns) {
    const amount = toDecimal(txn.amount);
    feesFieldAmount = feesFieldAmount.plus(toDecimal(txn.fees));
    taxesFieldAmount = taxesFieldAmount.plus(toDecimal(txn.taxes));

    switch (txn.type) {
      case 'buy':
        totalBuyAmount = totalBuyAmount.plus(amount);
        totalBuyOrGiftAmount = totalBuyOrGiftAmount.plus(amount);
        break;
      case 'gift':
        totalBuyOrGiftAmount = totalBuyOrGiftAmount.plus(amount);
        break;
      case 'sell':
        totalSellAmount = totalSellAmount.plus(amount);
        break;
      case 'fee':
        feeTxnAmount = feeTxnAmount.plus(amount);
        break;
      case 'tax':
        taxTxnAmount = taxTxnAmount.plus(amount);
        break;
      case 'dividend':
        totalDividends = totalDividends.plus(amount);
        break;
      case 'interest':
        totalInterestPaid = totalInterestPaid.plus(amount);
        break;
      case 'rent_income':
        totalRent = totalRent.plus(amount);
        break;
      case 'appreciation':
        totalAppreciation = totalAppreciation.plus(amount);
        break;
    }
  }

  const totalFees = feeTxnAmount.plus(feesFieldAmount);
  const totalTaxes = taxTxnAmount.plus(taxesFieldAmount);

  let totalUnits = new Decimal(0);
  let avgCostBasis = new Decimal(0);
  let realizedGain = new Decimal(0);
  let unrealizedGain = new Decimal(0);
  let currentValue: Decimal;
  let totalInvested: Decimal;
  let totalBuyCost: Decimal; // assigned in every branch of the asset-class if/else below
  let totalSellProceeds = new Decimal(0);
  let accruedInterest = new Decimal(0);
  let projectedAnnualInterest = new Decimal(0);

  if (unitBased) {
    const cb = calculateCostBasis(txns);
    totalUnits = toDecimal(cb.totalUnits);
    avgCostBasis = toDecimal(cb.avgCostBasis);
    realizedGain = toDecimal(cb.realizedGain);
    totalBuyCost = toDecimal(cb.totalBuyCost);
    totalSellProceeds = toDecimal(cb.totalSellProceeds);
    totalInvested = toDecimal(cb.totalCost);

    const currentPrice = toDecimal(inv.current_price);
    currentValue = totalUnits.times(currentPrice);
    unrealizedGain = totalUnits.gt(0)
      ? currentPrice.minus(avgCostBasis).times(totalUnits)
      : new Decimal(0);
  } else if (fixedIncome) {
    totalInvested = totalBuyOrGiftAmount.minus(totalSellAmount);
    totalBuyCost = totalBuyOrGiftAmount;
    totalSellProceeds = totalSellAmount;

    const interestRate = Number(inv.interest_rate) || 0;
    accruedInterest = toDecimal(
      calculateAccruedInterest(txns, toNumber(totalInvested), interestRate)
    );
    projectedAnnualInterest = toDecimal(
      calculateProjectedAnnualInterest(toNumber(totalInvested), interestRate)
    );

    currentValue = totalInvested.plus(accruedInterest);
    // Interest received is income (already in totalIncome) — feeding it into
    // realizedGain too double-counted it in gainLoss. Mirrors the backend.
    realizedGain = new Decimal(0);
    unrealizedGain = accruedInterest;
  } else if (realEstate) {
    totalInvested = totalBuyAmount.minus(totalSellAmount);
    totalBuyCost = totalBuyAmount;
    totalSellProceeds = totalSellAmount;
    currentValue = totalInvested.plus(totalAppreciation);
    unrealizedGain = totalAppreciation;
    // Rent is income (in totalIncome) and fees/taxes are already subtracted once
    // in the shared gainLoss line — this double-counted all three. Mirrors backend.
    realizedGain = new Decimal(0);
  } else {
    totalInvested = totalBuyAmount.minus(totalSellAmount);
    // Match the backend (portfolioSummaryService): "other" assets use gross buy
    // amount as the cost basis. Leaving it at 0 forced gainLossPercent to 0% and
    // dropped these holdings from the best/worst-performers filter (totalBuyCost > 0).
    totalBuyCost = totalBuyAmount;
    currentValue = totalInvested;
  }

  const totalIncome = totalDividends.plus(totalInterestPaid).plus(totalRent);
  const totalGain = realizedGain.plus(unrealizedGain);
  // Unit-based assets already fold the per-row fees/taxes columns into cost
  // basis (calculateCostBasis), so subtracting totalFees/totalTaxes again would
  // double-count them. Only standalone fee/tax transaction types are outside
  // cost basis. Other branches keep the full subtraction. Mirrors the backend.
  const gainLoss = unitBased
    ? totalGain.plus(totalIncome).minus(feeTxnAmount).minus(taxTxnAmount)
    : totalGain.plus(totalIncome).minus(totalFees).minus(totalTaxes);
  const gainLossPercent = totalBuyCost.gt(0)
    ? divide(gainLoss, totalBuyCost).times(100)
    : new Decimal(0);

  return {
    ...inv,
    assetClass: inv.asset_class,
    totalUnits: toNumber(totalUnits),
    totalInvested: toNumber(totalInvested.abs()),
    totalFees: toNumber(totalFees),
    totalTaxes: toNumber(totalTaxes),
    feeTransactions: toNumber(feeTxnAmount),
    taxTransactions: toNumber(taxTxnAmount),
    totalDividends: toNumber(totalDividends),
    totalIncome: toNumber(totalIncome),
    currentValue: toNumber(currentValue),
    currentPrice: Number(inv.current_price) || undefined,
    interestRate: Number(inv.interest_rate) || undefined,
    avgCostBasis: toNumber(avgCostBasis),
    realizedGain: toNumber(realizedGain),
    unrealizedGain: toNumber(unrealizedGain),
    totalGain: toNumber(totalGain),
    gainLoss: toNumber(gainLoss),
    gainLossPercent: toNumber(gainLossPercent),
    accruedInterest: toNumber(accruedInterest),
    projectedAnnualInterest: toNumber(projectedAnnualInterest),
    totalAppreciation: toNumber(totalAppreciation),
    totalBuyCost: toNumber(totalBuyCost),
    totalSellProceeds: toNumber(totalSellProceeds),
    transactions: txns,
  } as InvestmentSummary;
}

interface UsePortfolioSummariesInput {
  investments: Investment[];
  transactions: PortfolioTransaction[];
}

// Stable empty result so a single-class lookup with no matches keeps its
// identity across renders.
const EMPTY_SUMMARIES: InvestmentSummary[] = [];

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
    () => ({
      totalPortfolioValue: toNumber(addAll(summaries.map((s) => s.currentValue))),
      totalGainLoss: toNumber(addAll(summaries.map((s) => s.gainLoss))),
      totalRealizedGain: toNumber(addAll(summaries.map((s) => s.realizedGain))),
      totalUnrealizedGain: toNumber(addAll(summaries.map((s) => s.unrealizedGain))),
    }),
    [summaries]
  );

  // Pre-group once per summaries change. A single-class lookup then returns the
  // grouped array directly with a stable identity — previously every render
  // produced a fresh `.filter()` result, so the Stocks/Crypto/Metals pages
  // re-rendered even when nothing changed.
  const groupedByClass = useMemo(() => {
    const map = new Map<AssetClass, InvestmentSummary[]>();
    for (const s of summaries) {
      const cls = s.assetClass as AssetClass;
      const list = map.get(cls);
      if (list) list.push(s);
      else map.set(cls, [s]);
    }
    return map;
  }, [summaries]);

  const byAssetClass = useCallback(
    (cls: AssetClass | AssetClass[]): InvestmentSummary[] => {
      if (!Array.isArray(cls)) return groupedByClass.get(cls) ?? EMPTY_SUMMARIES;
      return cls.flatMap((c) => groupedByClass.get(c) ?? []);
    },
    [groupedByClass]
  );

  return { summaries, totals, byAssetClass };
}
