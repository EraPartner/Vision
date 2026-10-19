import { QUERY_STALE_TIME_MS } from "@/lib/queryPolicies";
/**
 * Realtime portfolio summary hook.
 *
 * Single source of truth for total portfolio value, invested capital, gains,
 * and per-investment summaries — all pre-converted to the requested target
 * currency by the backend. Replaces the previous frontend-side reduce loop
 * over usePortfolioSummaries which diverged from the performance page because
 * each surface applied its own FX conversion at its own moment in time.
 */

import { useQuery } from "@tanstack/react-query";
import { apiClient } from "@/lib/api";
import { portfolioKeys } from "@/lib/queryKeys";
import type { PortfolioSummaryResponse } from "@/lib/api/info";
import type { CurrencyCode } from "@vision/types/brands";

export function usePortfolioSummaryQuery(currency: CurrencyCode, enabled = true) {
    return useQuery<PortfolioSummaryResponse>({
        queryKey: portfolioKeys.summary(currency),
        queryFn: () => apiClient.getPortfolioSummary({ currency }),
        enabled,
        staleTime: QUERY_STALE_TIME_MS.STANDARD,
        gcTime: 5 * 60_000,
    });
}

/**
 * Server summaries for every holding, archived ones included, so archived
 * gains come from the same engine (dated FX, configured cost-basis method) as
 * active ones. Only fetched when there is an archived holding to show.
 */
export function useAllHoldingsSummaryQuery(currency: CurrencyCode, enabled = true) {
    return useQuery<PortfolioSummaryResponse>({
        queryKey: portfolioKeys.summaryAllHoldings(currency),
        queryFn: () => apiClient.getPortfolioSummary({ currency, active: false }),
        enabled,
        staleTime: QUERY_STALE_TIME_MS.STANDARD,
        gcTime: 5 * 60_000,
    });
}
