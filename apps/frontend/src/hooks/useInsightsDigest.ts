/**
 * Insights digest (detection layer, no LLM) for the Statistics page.
 *
 * Shared react-query wrapper around GET /api/info/insights-digest so the
 * Statistics panel and any badge reading the counts hit one cache entry.
 * The API client fails soft to an empty digest, so consumers never need an
 * error branch — an outage just renders as "no findings".
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
    dismissInsight,
    getInsightsCount,
    getInsightsDigest,
    type InsightDismissalRequest,
    type InsightsDigestResponse,
} from "@/lib/api/info";
import { insightsKeys } from "@/lib/queryKeys";

export function useInsightsDigest() {
    return useQuery<InsightsDigestResponse>({
        queryKey: insightsKeys.digest,
        queryFn: getInsightsDigest,
        // 3 min: fresh enough for a per-visit digest, long enough that a badge
        // mounted elsewhere doesn't refetch on every navigation.
        staleTime: 3 * 60_000,
        retry: false,
        refetchOnWindowFocus: false,
        refetchOnReconnect: false,
    });
}

export function useInsightsCount() {
    return useQuery({
        queryKey: insightsKeys.count,
        queryFn: getInsightsCount,
        refetchInterval: (query) =>
            insightsCountRefetchInterval(query.state.data?.status),
        staleTime: 60_000,
        retry: false,
    });
}

export function insightsCountRefetchInterval(status?: string) {
    if (status === "pending") return 2_000;
    if (status === "unavailable") return 60_000;
    return false;
}

export function useDismissInsight() {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: (request: InsightDismissalRequest) =>
            dismissInsight(request),
        onSuccess: async () => {
            await Promise.all([
                queryClient.invalidateQueries({
                    queryKey: insightsKeys.digest,
                }),
                queryClient.invalidateQueries({ queryKey: insightsKeys.count }),
            ]);
        },
    });
}
