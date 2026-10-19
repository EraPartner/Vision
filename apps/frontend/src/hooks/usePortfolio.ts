/**
 * Portfolio hook — re-export barrel.
 *
 * Implementation split across:
 *   hooks/portfolio/useInvestments.ts      ← queries + mutations
 *   hooks/portfolio/usePortfolioSummaries.ts    ← composed summaries
 */

import { useMemo } from "react";
import {
    useInvestmentsQuery,
    usePortfolioTransactionsQuery,
    useInvestmentMutations,
} from "./portfolio/useInvestments";
import { usePortfolioSummaries } from "./portfolio/usePortfolioSummaries";
import {
    useAllHoldingsSummaryQuery,
    usePortfolioSummaryQuery,
} from "./portfolio/usePortfolioSummary";
import { useAppSettings } from "@/stores/hydration/AppSettingsHydration";

export {
    useInvestmentsQuery,
    usePortfolioTransactionsQuery,
    useInvestmentMutations,
} from "./portfolio/useInvestments";
export { usePortfolioSummaries } from "./portfolio/usePortfolioSummaries";

const EMPTY_INVESTMENTS: never[] = [];
const EMPTY_TRANSACTIONS: never[] = [];

export function usePortfolio({
    completeHistory = false,
    completeAssetClass,
}: { completeHistory?: boolean; completeAssetClass?: string } = {}) {
    const { appSettings } = useAppSettings();
    const currency = appSettings.defaultCurrency || "EUR";
    const canonicalQuery = usePortfolioSummaryQuery(currency);
    const investmentsQuery = useInvestmentsQuery();
    const allInvestments = investmentsQuery.data?.items ?? EMPTY_INVESTMENTS;
    const archivedQuery = useAllHoldingsSummaryQuery(
        currency,
        allInvestments.some((investment) => !investment.is_active),
    );
    const investments = useMemo(
        () => allInvestments.filter((investment) => investment.is_active),
        [allInvestments],
    );
    const investmentIds = useMemo(
        () => allInvestments.map((i) => i.id).sort((a, b) => a - b),
        [allInvestments],
    );
    const completeIds = useMemo(
        () =>
            allInvestments
                .filter(
                    (i) =>
                        completeHistory ||
                        !i.is_active ||
                        i.asset_class === completeAssetClass,
                )
                .map((i) => i.id)
                .sort((a, b) => a - b),
        [allInvestments, completeHistory, completeAssetClass],
    );
    const recentIds = useMemo(() => {
        const complete = new Set(completeIds);
        return investmentIds.filter((id) => !complete.has(id));
    }, [investmentIds, completeIds]);
    const recentQuery = usePortfolioTransactionsQuery(recentIds);
    const historyQuery = usePortfolioTransactionsQuery(completeIds, true);
    const allTransactions = useMemo(
        () =>
            [
                ...(recentQuery.data ?? EMPTY_TRANSACTIONS),
                ...(historyQuery.data ?? EMPTY_TRANSACTIONS),
            ].sort((a, b) => b.date.localeCompare(a.date) || b.id - a.id),
        [recentQuery.data, historyQuery.data],
    );
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
            canonicalSummaries: canonicalQuery.data?.summaries,
            canonicalArchivedSummaries: archivedQuery.data?.summaries,
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
        isLoading:
            investmentsQuery.isLoading ||
            canonicalQuery.isLoading ||
            archivedQuery.isLoading ||
            recentQuery.isLoading ||
            historyQuery.isLoading,
        isError:
            investmentsQuery.isError ||
            canonicalQuery.isError ||
            archivedQuery.isError ||
            recentQuery.isError ||
            historyQuery.isError,
        error:
            investmentsQuery.error ||
            canonicalQuery.error ||
            archivedQuery.error ||
            recentQuery.error ||
            historyQuery.error,
        historyIsLoading: recentQuery.isLoading || historyQuery.isLoading,
        historyError: recentQuery.error || historyQuery.error,
        refetch: async () =>
            Promise.all([
                investmentsQuery.refetch(),
                canonicalQuery.refetch(),
                ...(archivedQuery.isEnabled ? [archivedQuery.refetch()] : []),
                ...(recentIds.length ? [recentQuery.refetch()] : []),
                ...(completeIds.length ? [historyQuery.refetch()] : []),
            ]),
        totalPortfolioValue: totals.totalPortfolioValue,
        totalGainLoss: totals.totalGainLoss,
        totalRealizedGain: totals.totalRealizedGain,
        totalUnrealizedGain: totals.totalUnrealizedGain,
    };
}
