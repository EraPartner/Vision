/**
 * Portfolio hook — re-export barrel.
 *
 * Implementation split across:
 *   hooks/portfolio/useInvestments.ts      ← queries + mutations
 *   hooks/portfolio/usePortfolioCalculations.ts ← pure math
 *   hooks/portfolio/usePortfolioSummaries.ts    ← composed summaries
 */

import { useMemo } from "react";
import {
    useInvestmentsQuery,
    usePortfolioTransactionsQuery,
    useInvestmentMutations,
} from "./portfolio/useInvestments";
import { usePortfolioSummaries } from "./portfolio/usePortfolioSummaries";

export {
    calculateCostBasis,
    calculateAccruedInterest,
    calculateProjectedAnnualInterest,
} from "./portfolio/usePortfolioCalculations";
export type { CostBasisResult } from "./portfolio/usePortfolioCalculations";
export {
    useInvestmentsQuery,
    usePortfolioTransactionsQuery,
    useInvestmentMutations,
} from "./portfolio/useInvestments";
export { usePortfolioSummaries } from "./portfolio/usePortfolioSummaries";

const EMPTY_INVESTMENTS: never[] = [];
const EMPTY_TRANSACTIONS: never[] = [];

export function usePortfolio() {
    const investmentsQuery = useInvestmentsQuery();
    const allInvestments = investmentsQuery.data?.items ?? EMPTY_INVESTMENTS;
    const investments = useMemo(
        () => allInvestments.filter((investment) => investment.is_active),
        [allInvestments],
    );
    const investmentIds = useMemo(
        () => allInvestments.map((i) => i.id).sort((a, b) => a - b),
        [allInvestments],
    );
    const { data: allTransactions = EMPTY_TRANSACTIONS } =
        usePortfolioTransactionsQuery(investmentIds);
    const activeInvestmentIds = useMemo(
        () => new Set(investments.map((investment) => investment.id)),
        [investments],
    );
    const transactions = useMemo(
        () =>
            allTransactions.filter((transaction) =>
                activeInvestmentIds.has(transaction.investment_id),
            ),
        [allTransactions, activeInvestmentIds],
    );

    const mutations = useInvestmentMutations();
    const { summaries, allSummaries, inactiveSummaries, totals, byAssetClass } =
        usePortfolioSummaries({
            investments: allInvestments,
            transactions: allTransactions,
        });

    return {
        investments,
        allInvestments,
        transactions,
        allTransactions,
        summaries,
        allSummaries,
        inactiveSummaries,
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
