import { useEffect, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { QUERY_STALE_TIME_MS } from "@/lib/queryPolicies";
import { taxKeys } from "@/lib/queryKeys";
import {
    getBelgianPortfolioTaxDashboard,
    getBelgianTaxDashboard,
} from "@/lib/api/belgianTax";
import { onTaxSettingsSaved } from "@/stores/taxPersistence";
import { useExcludedIds } from "@/hooks/useExcludedIds";
import { getStatisticsDateRange } from "@/hooks/useStatistics";
import type { CurrencyCode } from "@vision/types/brands";

/**
 * Refetch both server-computed tax dashboards once a Belgian-tax settings save is
 * acknowledged: the server reads the stored household, so edits made in the profile
 * dialog reach the charts after their debounced save lands.
 */
function useRefetchTaxDashboardsOnSave() {
    const queryClient = useQueryClient();
    useEffect(
        () =>
            onTaxSettingsSaved(() => {
                void queryClient.invalidateQueries({
                    queryKey: taxKeys.dashboardAll,
                });
                void queryClient.invalidateQueries({
                    queryKey: taxKeys.portfolioDashboardAll,
                });
            }),
        [queryClient],
    );
}

/**
 * GET /api/belgian-tax/dashboard for the viewed year, with the same currency,
 * trailing-24-month window and statistics exclusions the overview used to apply
 * to its in-browser aggregation.
 */
export function useTaxDashboardQuery(options: {
    year: number;
    currency: CurrencyCode;
    enabled: boolean;
}) {
    useRefetchTaxDashboardsOnSave();
    const { excludedCategoryIds, excludedRecipientIds, isReady } =
        useExcludedIds("statistics");
    // One window per mount, like useStatistics' memoized "24m" range.
    const range = useMemo(() => getStatisticsDateRange("24m"), []);
    const { year, currency, enabled } = options;
    return useQuery({
        queryKey: taxKeys.dashboard(
            year,
            currency,
            range.start_date,
            range.end_date,
            excludedCategoryIds,
            excludedRecipientIds,
        ),
        queryFn: ({ signal }) =>
            getBelgianTaxDashboard(
                {
                    year,
                    currency,
                    start_date: range.start_date,
                    end_date: range.end_date,
                    excluded_category_ids: excludedCategoryIds,
                    excluded_recipient_ids: excludedRecipientIds,
                },
                signal,
            ),
        enabled: enabled && isReady,
        staleTime: QUERY_STALE_TIME_MS.STANDARD,
    });
}

/** GET /api/belgian-tax/portfolio-dashboard for the viewed year. */
export function usePortfolioTaxDashboardQuery(options: {
    year: number;
    currency: CurrencyCode;
    enabled: boolean;
}) {
    useRefetchTaxDashboardsOnSave();
    const { year, currency, enabled } = options;
    return useQuery({
        queryKey: taxKeys.portfolioDashboard(year, currency),
        queryFn: ({ signal }) =>
            getBelgianPortfolioTaxDashboard({ year, currency }, signal),
        enabled,
        staleTime: QUERY_STALE_TIME_MS.STANDARD,
    });
}
