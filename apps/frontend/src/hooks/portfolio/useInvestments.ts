/**
 * Portfolio data queries and mutations.
 * Pure TanStack Query layer — no calculations.
 */

import { useCallback } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "@/lib/api";
import {
    accountKeys,
    invalidateInvestmentData,
    portfolioKeys,
} from "@/lib/queryKeys";
import type {
    InvestmentCreate,
    InvestmentUpdate,
    PortfolioTransactionCreate,
    PortfolioTransaction,
    PortfolioTransactionUpdate,
} from "@/types/api";
import { toast } from "sonner";
import { apiErrorToMessage } from "@/lib/api/errorMessage";
import { useLanguage } from "@/stores/hydration/LanguageHydration";
import type {
    InvestmentId,
    PortfolioTransactionId,
} from "@vision/types/brands";

/** Stop rather than publish a partial collection if a page disappears mid-read. */
async function collectPages<T>(
    fetchPage: (offset: number) => Promise<{ items: T[]; total: number }>,
    signal?: AbortSignal,
): Promise<T[]> {
    const items: T[] = [];
    let total = Infinity;
    while (items.length < total) {
        signal?.throwIfAborted();
        const page = await fetchPage(items.length);
        total = page.total;
        if (page.items.length === 0 && items.length < total)
            throw new Error(
                "Portfolio pagination stopped before all records were loaded",
            );
        items.push(...page.items);
    }
    signal?.throwIfAborted();
    return items;
}

export function useInvestmentsQuery() {
    return useQuery({
        queryKey: portfolioKeys.investments,
        queryFn: async ({ signal }) => {
            const items = await collectPages(
                (offset) =>
                    apiClient.getInvestments(
                        {
                            limit: 500,
                            offset,
                            active: false,
                        },
                        signal,
                    ),
                signal,
            );
            return {
                items,
                total: items.length,
                limit: items.length,
                offset: 0,
                links: [],
            };
        },
        staleTime: 2 * 60_000,
        gcTime: 10 * 60_000,
    });
}

/** Recent activity only. Calculations and detail views must request complete history. */
export const RECENT_TRANSACTIONS_PER_INVESTMENT = 50;
export function usePortfolioTransactionsQuery(
    investmentIds: InvestmentId[],
    complete = false,
) {
    return useQuery({
        queryKey: [
            ...portfolioKeys.transactions(investmentIds.join(",")),
            complete ? "complete" : "recent",
        ],
        queryFn: async ({ signal }) => {
            if (!complete) {
                const items: PortfolioTransaction[] = [];
                // Bound URL size and server work for large inventories. Errors propagate:
                // this endpoint is part of the current API, not an optional capability.
                for (
                    let offset = 0;
                    offset < investmentIds.length;
                    offset += 100
                ) {
                    signal.throwIfAborted();
                    const page = await apiClient.getPortfolioTransactionsBulk(
                        {
                            investment_ids: investmentIds
                                .slice(offset, offset + 100)
                                .join(","),
                            per_investment_limit:
                                RECENT_TRANSACTIONS_PER_INVESTMENT,
                        },
                        signal,
                    );
                    items.push(...page.items);
                }
                return items;
            }
            const result: PortfolioTransaction[][] = [];
            let next = 0;
            // Object holder: the workers write it, which control-flow narrowing
            // cannot see for plain `let` variables.
            const outcome: { failed: boolean; failure?: unknown } = {
                failed: false,
            };
            // Do not reject until every in-flight worker settles: a query retry
            // must not start another pool while the previous requests still run.
            await Promise.all(
                Array.from(
                    { length: Math.min(4, investmentIds.length) },
                    async () => {
                        try {
                            while (!outcome.failed && next < investmentIds.length) {
                                signal.throwIfAborted();
                                const index = next++;
                                const investmentId = investmentIds[index];
                                if (investmentId === undefined) {
                                    throw new Error("Missing investment id");
                                }
                                result[index] = await collectPages((offset) => {
                                    if (outcome.failed) throw outcome.failure;
                                    return apiClient.getPortfolioTransactions(
                                        investmentId,
                                        { limit: 1000, offset },
                                        signal,
                                    );
                                }, signal);
                            }
                        } catch (error) {
                            if (!outcome.failed) {
                                outcome.failed = true;
                                outcome.failure = error;
                            }
                        }
                    },
                ),
            );
            if (outcome.failed) throw outcome.failure;
            return result.flat();
        },
        enabled: investmentIds.length > 0,
        staleTime: 2 * 60_000,
        gcTime: 10 * 60_000,
    });
}

export function useAllPortfolioTransactionsQuery(
    investmentId: InvestmentId,
    enabled = true,
) {
    return useQuery({
        queryKey: portfolioKeys.allTransactionsForInvestment(investmentId),
        queryFn: ({ signal }) =>
            collectPages(
                (offset) =>
                    apiClient.getPortfolioTransactions(
                        investmentId,
                        {
                            limit: 1000,
                            offset,
                        },
                        signal,
                    ),
                signal,
            ),
        enabled,
        staleTime: 2 * 60_000,
        gcTime: 10 * 60_000,
    });
}

export function useInvestmentMutations() {
    const queryClient = useQueryClient();
    const { t } = useLanguage();

    const invalidateAll = useCallback(() => {
        invalidateInvestmentData(queryClient);
    }, [queryClient]);

    const addInvestmentMutation = useMutation({
        mutationFn: (data: InvestmentCreate) =>
            apiClient.createInvestment(data),
        onSuccess: invalidateAll,
        onError: (err: Error) =>
            toast.error(t("portfolio.createInvestmentFailedTitle"), {
                description: apiErrorToMessage(err, t),
            }),
    });

    const updateInvestmentMutation = useMutation({
        mutationFn: ({ id, data }: { id: InvestmentId; data: InvestmentUpdate }) =>
            apiClient.updateInvestment(id, data),
        onSuccess: invalidateAll,
        onError: (err: Error) =>
            toast.error(t("portfolio.updateInvestmentFailedTitle"), {
                description: apiErrorToMessage(err, t),
            }),
    });

    const deleteInvestmentMutation = useMutation({
        mutationFn: (id: InvestmentId) => apiClient.deleteInvestment(id),
        onSuccess: invalidateAll,
        onError: (err: Error) =>
            toast.error(t("portfolio.deleteInvestmentFailedTitle"), {
                description: apiErrorToMessage(err, t),
            }),
    });

    const addTxnMutation = useMutation({
        mutationFn: ({
            investmentId,
            data,
        }: {
            investmentId: InvestmentId;
            data: PortfolioTransactionCreate;
        }) => apiClient.createPortfolioTransaction(investmentId, data),
        onSuccess: invalidateAll,
        onError: (err: Error) =>
            toast.error(t("portfolio.recordTxnFailedTitle"), {
                description: apiErrorToMessage(err, t),
            }),
    });

    const deleteTxnMutation = useMutation({
        mutationFn: (id: PortfolioTransactionId) => apiClient.deletePortfolioTransaction(id),
        onSuccess: invalidateAll,
        onError: (err: Error) =>
            toast.error(t("portfolio.deleteTxnFailedTitle"), {
                description: apiErrorToMessage(err, t),
            }),
    });

    const updateTxnMutation = useMutation({
        mutationFn: ({
            id,
            data,
        }: {
            id: PortfolioTransactionId;
            data: PortfolioTransactionUpdate;
        }) => apiClient.updatePortfolioTransaction(id, data),
        onSuccess: invalidateAll,
        onError: (err: Error) =>
            toast.error(t("portfolio.recordTxnFailedTitle"), {
                description: apiErrorToMessage(err, t),
            }),
    });

    const bulkRetagMutation = useMutation({
        mutationFn: (
            data: Parameters<
                typeof apiClient.bulkRetagPortfolioTransactions
            >[0],
        ) => apiClient.bulkRetagPortfolioTransactions(data),
        onSuccess: () => {
            invalidateAll();
            void queryClient.invalidateQueries({ queryKey: accountKeys.all });
        },
        onError: (err: Error) =>
            toast.error(t("portfolio.assignLotsFailedTitle"), {
                description: apiErrorToMessage(err, t),
            }),
    });

    const refreshPricesMutation = useMutation({
        mutationFn: () => apiClient.refreshInvestmentPrices(),
        onSuccess: (data) => {
            invalidateAll();
            // `total` is omitted when no holding has a live price provider.
            const total = String(data.total ?? 0);
            const sources = Object.values(data.priceSources ?? {});
            const staleCount = sources.filter(
                (s) => s === "historical_fallback" || s === "cached",
            ).length;
            // Stable id => Sonner replaces, never stacks duplicates on rapid re-clicks.
            if (staleCount > 0) {
                toast.warning(t("portfolio.refreshedPrices", { n: total }), {
                    id: "portfolio-refresh-prices",
                    description: t("portfolio.refreshedPricesStale", {
                        n: String(staleCount),
                        total,
                    }),
                });
            } else {
                toast.success(t("portfolio.refreshedPrices", { n: total }), {
                    id: "portfolio-refresh-prices",
                });
            }
        },
        onError: (err: Error) => {
            const isOffline =
                typeof navigator !== "undefined" && !navigator.onLine;
            toast.error(t("portfolio.refreshPricesFailedTitle"), {
                id: "portfolio-refresh-prices",
                description: isOffline
                    ? t("portfolio.refreshPricesOffline")
                    : apiErrorToMessage(err, t),
            });
        },
    });

    const addInvestment = useCallback(
        (data: InvestmentCreate) => addInvestmentMutation.mutateAsync(data),
        [addInvestmentMutation],
    );

    const updateInvestment = useCallback(
        (id: InvestmentId, data: InvestmentUpdate) =>
            updateInvestmentMutation.mutateAsync({ id, data }),
        [updateInvestmentMutation],
    );

    const deleteInvestment = useCallback(
        (id: InvestmentId) => deleteInvestmentMutation.mutate(id),
        [deleteInvestmentMutation],
    );

    const addTransaction = useCallback(
        (data: { investmentId: InvestmentId } & PortfolioTransactionCreate) => {
            const { investmentId, ...txnData } = data;
            return addTxnMutation.mutateAsync({ investmentId, data: txnData });
        },
        [addTxnMutation],
    );

    const deleteTransaction = useCallback(
        (id: PortfolioTransactionId) => deleteTxnMutation.mutate(id),
        [deleteTxnMutation],
    );

    const updateTransaction = useCallback(
        (id: PortfolioTransactionId, data: PortfolioTransactionUpdate) =>
            updateTxnMutation.mutateAsync({ id, data }),
        [updateTxnMutation],
    );

    const refreshPrices = useCallback(
        () => refreshPricesMutation.mutate(),
        [refreshPricesMutation],
    );

    const bulkRetagTransactions = useCallback(
        (
            data: Parameters<
                typeof apiClient.bulkRetagPortfolioTransactions
            >[0],
        ) => bulkRetagMutation.mutateAsync(data),
        [bulkRetagMutation],
    );

    return {
        addInvestment,
        updateInvestment,
        deleteInvestment,
        addTransaction,
        deleteTransaction,
        updateTransaction,
        bulkRetagTransactions,
        refreshPrices,
        isRefreshingPrices: refreshPricesMutation.isPending,
        isAddingInvestment: addInvestmentMutation.isPending,
        isUpdatingInvestment: updateInvestmentMutation.isPending,
        isAddingTransaction: addTxnMutation.isPending,
        isUpdatingTransaction: updateTxnMutation.isPending,
        isRetaggingTransactions: bulkRetagMutation.isPending,
    };
}
