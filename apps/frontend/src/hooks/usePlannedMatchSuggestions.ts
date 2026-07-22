import { useQuery } from "@tanstack/react-query";
import { apiClient } from "@/lib/api";
import { plannedKeys } from "@/lib/queryKeys";

/**
 * Planned payments that have recent unlinked transactions within match
 * tolerance but were not auto-cleared (ambiguous matches, or auto-clear off).
 * The shared plannedKeys.matchSuggestions key lets the planned-payments page
 * invalidate after a confirm.
 */
export function usePlannedMatchSuggestions() {
    const { data, isLoading, refetch } = useQuery({
        queryKey: plannedKeys.matchSuggestions,
        queryFn: () => apiClient.getPlannedMatchSuggestions(),
        staleTime: 5 * 60_000,
    });
    return { suggestions: data ?? [], isLoading, refetch };
}
