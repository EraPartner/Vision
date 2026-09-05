import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiClient } from "@/lib/api";
import { dashboardKeys, monthlySummaryKeys } from "@/lib/queryKeys";
import { useAppSettings } from "@/stores/hydration/AppSettingsHydration";
import { useExcludedIds } from "@/hooks/useExcludedIds";

export interface NetHistoryPoint {
    year: number;
    month: number;
    net: number;
}

interface FilteredDashboardStats {
    totalTransactions: number;
    monthlyIncome: number;
    monthlySpending: number;
    netBalance: number;
    netHistory: NetHistoryPoint[];
    latestPeriod?: string;
}

const NET_HISTORY_MONTHS = 12;
const EMPTY_IDS: number[] = [];

export interface UseMonthlySummaryOptions {
    excludedCategoryIds?: number[];
    excludedRecipientIds?: number[];
    enabled?: boolean;
}

/**
 * Shared fetch of `/api/aggregations/monthly-summary` for the dashboard.
 *
 * The stat cards (via useFilteredDashboardStats) and the monthly-trends
 * chart's filtered + unfiltered variants previously issued this same request
 * under three unrelated cache keys, so every dashboard mount — and every
 * transaction mutation, via invalidation — refired up to three identical
 * round trips. Keying strictly on the resolved exclusion arrays lets React
 * Query dedupe them: consumers with the same effective exclusions share one
 * cache entry, and with exclusions off everything collapses onto
 * `['monthlySummary', currency, [], []]`.
 *
 * The `'monthlySummary'` prefix is what invalidateTransactionData
 * (lib/queryKeys) invalidates after mutations — keep it.
 */
export function useMonthlySummary({
    excludedCategoryIds = EMPTY_IDS,
    excludedRecipientIds = EMPTY_IDS,
    enabled = true,
}: UseMonthlySummaryOptions = {}) {
    const { appSettings } = useAppSettings();
    const targetCurrency = appSettings.defaultCurrency || "EUR";

    return useQuery({
        queryKey: monthlySummaryKeys.summary(
            targetCurrency,
            excludedCategoryIds,
            excludedRecipientIds,
        ),
        enabled,
        queryFn: async () => {
            const envelope = await apiClient.getAggregationMonthlySummary({
                excluded_category_ids:
                    excludedCategoryIds.length > 0
                        ? excludedCategoryIds
                        : undefined,
                excluded_recipient_ids:
                    excludedRecipientIds.length > 0
                        ? excludedRecipientIds
                        : undefined,
                currency: targetCurrency,
            });
            return envelope.data;
        },
        staleTime: 30000, // Consider data fresh for 30 seconds
        // Do not refetch on window focus — the dashboard has its own staleTime and
        // refetching on every alt-tab creates unnecessary API load.
        refetchOnWindowFocus: false,
    });
}

/**
 * Hook that applies dashboard settings to statistics calculations.
 *
 * Phase 2 (dashboard perf): reads the server-side aggregation envelope
 * `/api/aggregations/monthly-summary`, which already applies category and
 * recipient exclusions. Client-side transaction pagination + re-filtering
 * have been removed.
 */
export function useFilteredDashboardStats() {
    // Shared resolution of excluded category/recipient IDs (incl. hidden categories)
    // so the dashboard, statistics page, and net-summary card all exclude the same
    // set — see useExcludedIds for why this was centralized.
    const { excludedCategoryIds, excludedRecipientIds, isReady } =
        useExcludedIds("dashboard");

    // Wait until hidden-category resolution has settled, otherwise the first
    // run would omit hidden categories and momentarily show wrong totals.
    const summaryQuery = useMonthlySummary({
        excludedCategoryIds,
        excludedRecipientIds,
        enabled: isReady,
    });

    // The count is the DB total, independent of filters and currency — one cache
    // entry, kept under the 'filteredDashboardStats' prefix that
    // invalidateTransactionData already invalidates after mutations.
    const countQuery = useQuery({
        queryKey: dashboardKeys.transactionCount,
        queryFn: () => apiClient.getTransactionCount(),
        staleTime: 30000,
        refetchOnWindowFocus: false,
    });

    const data = useMemo<FilteredDashboardStats | undefined>(() => {
        if (!summaryQuery.data || !countQuery.data) return undefined;

        // Use the most recent month with data to keep cards aligned with actual latest activity.
        const monthsWithData = summaryQuery.data.months
            .filter((month) => month.transaction_count > 0)
            .sort((a, b) => a.year - b.year || a.month - b.month);

        const latest = monthsWithData[monthsWithData.length - 1];

        const netHistory: NetHistoryPoint[] = monthsWithData
            .slice(-NET_HISTORY_MONTHS)
            .map((m) => ({
                year: m.year,
                month: m.month,
                net: m.total_income - Math.abs(m.total_spending),
            }));

        if (!latest) {
            return {
                totalTransactions: countQuery.data.total_transactions,
                monthlyIncome: 0,
                monthlySpending: 0,
                netBalance: 0,
                netHistory,
                latestPeriod: undefined,
            };
        }

        // Server stores spending as negative; surface as positive magnitude.
        const monthlyIncome = latest.total_income;
        const monthlySpending = Math.abs(latest.total_spending);
        const netBalance = monthlyIncome - monthlySpending;

        return {
            totalTransactions: countQuery.data.total_transactions,
            monthlyIncome,
            monthlySpending,
            netBalance,
            netHistory,
            latestPeriod: `${latest.year}-${String(latest.month).padStart(2, "0")}`,
        };
    }, [summaryQuery.data, countQuery.data]);

    return {
        data,
        // `!isReady` counts as loading. While the summary query is disabled React
        // Query reports it as pending-but-idle (isLoading false), so once the cheap
        // count query settles the caller would see `isLoading: false, data:
        // undefined` and paint its `?? 0` fallbacks — zeros for income, spending and
        // net, indistinguishable from a genuinely empty month, replaced a moment
        // later by the real totals. The skeleton has to stay up until the exclusion
        // set is settled and the numbers are real.
        isLoading: !isReady || summaryQuery.isLoading || countQuery.isLoading,
        error: summaryQuery.error ?? countQuery.error,
        refetch: async () => {
            await Promise.allSettled([
                summaryQuery.refetch(),
                countQuery.refetch(),
            ]);
        },
    };
}
