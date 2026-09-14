import { useQuery } from "@tanstack/react-query";
import { apiClient } from "@/lib/api";
import { aiKeys } from "@/lib/queryKeys";
import { QUERY_STALE_TIME_MS } from "@/lib/queryPolicies";

export function useAiResearchStatus() {
    return useQuery({
        queryKey: aiKeys.openAiResearchStatus,
        queryFn: () => apiClient.getAiResearchStatus(),
        staleTime: QUERY_STALE_TIME_MS.STANDARD,
        retry: 0,
    });
}
