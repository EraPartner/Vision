import { useQuery } from "@tanstack/react-query";
import { apiClient } from "@/lib/api";
import { dashboardKeys } from "@/lib/queryKeys";
import { QUERY_STALE_TIME_MS } from "@/lib/queryPolicies";
import type { CurrencyCode } from "@vision/types/brands";

/**
 * Month-to-date spending pace for the Home hero (ADR-181): what was spent
 * from the 1st to today, per-day totals for the cumulative line, and the
 * six-month average the "typical month" guide is drawn from.
 *
 * The endpoint takes no exclusion parameters, so the settings-level
 * category/recipient exclusions do not apply here; the charts below the hero
 * still honour them.
 */
export function useMonthToDate(currency: CurrencyCode) {
    return useQuery({
        queryKey: dashboardKeys.monthToDate(currency),
        queryFn: () =>
            apiClient
                .getAggregationAverageVsCurrent({ currency })
                .then((r) => r.data),
        staleTime: QUERY_STALE_TIME_MS.FREQUENT,
    });
}
