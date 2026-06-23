import { useQuery } from "@tanstack/react-query";
import { apiClient } from "@/lib/api";

/**
 * Planned payments that have recent unlinked transactions within match
 * tolerance but were not auto-cleared (ambiguous matches, or auto-clear off).
 * Shared query key so the planned-payments page can invalidate after a confirm.
 */
export const PLANNED_MATCH_SUGGESTIONS_KEY = ["plannedMatchSuggestions"] as const;

export function usePlannedMatchSuggestions() {
    const { data, isLoading, refetch } = useQuery({
        queryKey: PLANNED_MATCH_SUGGESTIONS_KEY,
        queryFn: () => apiClient.getPlannedMatchSuggestions(),
        staleTime: 5 * 60_000,
    });
    return { suggestions: data ?? [], isLoading, refetch };
}
