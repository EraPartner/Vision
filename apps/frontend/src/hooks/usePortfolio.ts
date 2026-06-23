/**
 * Portfolio hook — re-export barrel.
 *
 * Implementation split across:
 *   hooks/portfolio/useInvestments.ts      ← queries + mutations
 *   hooks/portfolio/usePortfolioCalculations.ts ← pure math
 *   hooks/portfolio/usePortfolioSummaries.ts    ← composed summaries
 */

import { useMemo } from 'react';
import { useInvestmentsQuery, usePortfolioTransactionsQuery, useInvestmentMutations } from './portfolio/useInvestments';
import { usePortfolioSummaries } from './portfolio/usePortfolioSummaries';

export { calculateCostBasis, calculateAccruedInterest, calculateProjectedAnnualInterest } from './portfolio/usePortfolioCalculations';
export type { CostBasisResult } from './portfolio/usePortfolioCalculations';
export { useInvestmentsQuery, usePortfolioTransactionsQuery, useInvestmentMutations } from './portfolio/useInvestments';
export { usePortfolioSummaries } from './portfolio/usePortfolioSummaries';

const EMPTY_INVESTMENTS: never[] = [];
const EMPTY_TRANSACTIONS: never[] = [];

export function usePortfolio() {
  const investmentsQuery = useInvestmentsQuery();
  const investments = investmentsQuery.data?.items ?? EMPTY_INVESTMENTS;
  const investmentIds = useMemo(
    () => investments.map((i) => i.id).sort((a, b) => a - b),
    [investments]
  );
  const { data: transactions = EMPTY_TRANSACTIONS } = usePortfolioTransactionsQuery(investmentIds);

  const mutations = useInvestmentMutations();
  const { summaries, totals, byAssetClass } = usePortfolioSummaries({ investments, transactions });

  return {
    investments,
    transactions,
    summaries,
    byAssetClass,
    ...mutations,
    // Surface the investments query state so pages can distinguish loading /
    // error from genuinely-empty — otherwise a failed fetch silently renders the
    // "no holdings" empty state and masks the error.
    isLoading: investmentsQuery.isLoading,
    isError: investmentsQuery.isError,
    error: investmentsQuery.error,
    refetch: investmentsQuery.refetch,
    totalPortfolioValue: totals.totalPortfolioValue,
    totalGainLoss: totals.totalGainLoss,
    totalRealizedGain: totals.totalRealizedGain,
    totalUnrealizedGain: totals.totalUnrealizedGain,
  };
}
