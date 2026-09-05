import { useQuery } from "@tanstack/react-query";

import { apiClient } from "@/lib/api";
import { getCashflowForecastAccuracy } from "@/lib/api/aggregations";
import { cashflowKeys } from "@/lib/queryKeys";
import { dashboardKeys } from "@/lib/queryKeys";
import { fetchRecentDashboardTransactions } from "./recentTransactions";

interface ForecastQueryOptions {
    currency: string;
    excludedCategoryIds: number[];
    excludedRecipientIds: number[];
    includePlanned: boolean;
    mode: "month" | "rolling";
    rollingDays: 30 | 60 | 90 | 180;
    showDiagnostics: boolean;
}

export function useCashflowForecastQueries({
    currency,
    excludedCategoryIds,
    excludedRecipientIds,
    includePlanned,
    mode,
    rollingDays,
    showDiagnostics,
}: ForecastQueryOptions) {
    const monthQuery = useQuery({
        queryKey: cashflowKeys.forecastMethods(
            currency,
            excludedCategoryIds,
            excludedRecipientIds,
            includePlanned,
        ),
        queryFn: () =>
            apiClient.getCashflowForecastMethods({
                currency,
                excluded_category_ids: excludedCategoryIds,
                excluded_recipient_ids: excludedRecipientIds,
                include_planned: includePlanned,
                include_backtest: true,
                mc_paths: 500,
                mc_percentiles: [25, 75],
            }),
        staleTime: 60_000,
        enabled: mode === "month",
    });

    const rollingQuery = useQuery({
        queryKey: cashflowKeys.forecastRolling(
            currency,
            excludedCategoryIds,
            excludedRecipientIds,
            includePlanned,
            rollingDays,
        ),
        queryFn: () =>
            apiClient.getCashflowForecastRolling({
                currency,
                excluded_category_ids: excludedCategoryIds,
                excluded_recipient_ids: excludedRecipientIds,
                include_planned: includePlanned,
                days_back: rollingDays,
                days_forward: rollingDays,
                mc_paths: 500,
                mc_percentiles: [25, 75],
                include_backtest: false,
            }),
        staleTime: 60_000,
        enabled: mode === "rolling",
    });

    const rollingDiagnosticsQuery = useQuery({
        queryKey: cashflowKeys.forecastRollingDiagnostics(
            currency,
            excludedCategoryIds,
            excludedRecipientIds,
            includePlanned,
            rollingDays,
        ),
        queryFn: () =>
            apiClient.getCashflowForecastRolling({
                currency,
                excluded_category_ids: excludedCategoryIds,
                excluded_recipient_ids: excludedRecipientIds,
                include_planned: includePlanned,
                days_back: rollingDays,
                days_forward: rollingDays,
                mc_paths: 500,
                mc_percentiles: [25, 75],
                include_backtest: true,
            }),
        staleTime: 300_000,
        enabled: mode === "rolling" && showDiagnostics,
    });

    return { monthQuery, rollingQuery, rollingDiagnosticsQuery };
}

export function useCashflowForecastAccuracy(enabled: boolean) {
    return useQuery({
        queryKey: cashflowKeys.forecastAccuracy,
        queryFn: () => getCashflowForecastAccuracy({ limit_months: 24 }),
        staleTime: 10 * 60 * 1000,
        enabled,
        select: (response) => response.data,
    });
}

export function useBankBalances(currency: string) {
    return useQuery({
        queryKey: cashflowKeys.bankBalances(currency),
        queryFn: () => apiClient.getBankBalances({ currency }),
        staleTime: 60_000,
    });
}

export function useDashboardRecentTransactions(
    excludedCategoryIds: number[],
    excludedRecipientIds: number[],
    exclusionsReady: boolean,
    exclusionsApply: boolean,
) {
    return useQuery({
        queryKey: dashboardKeys.recentTransactions(
            excludedCategoryIds,
            excludedRecipientIds,
            exclusionsApply,
        ),
        queryFn: () =>
            fetchRecentDashboardTransactions(
                excludedCategoryIds,
                excludedRecipientIds,
            ),
        enabled: exclusionsReady && exclusionsApply,
        staleTime: 30_000,
    });
}
