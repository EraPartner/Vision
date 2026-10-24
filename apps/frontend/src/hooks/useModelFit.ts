import { QUERY_STALE_TIME_MS } from "@/lib/queryPolicies";
import { useQuery } from "@tanstack/react-query";
import { APPLE_FOUNDATION_MODEL } from "@vision/types/aiChat";
import { apiClient } from "@/lib/api";
import { aiKeys } from "@/lib/queryKeys";

/** Memory facts for the memory advisor line; off for the Apple model. */
export function useModelFit(model: string | undefined) {
    return useQuery({
        queryKey: aiKeys.modelFit(model ?? ""),
        queryFn: () => apiClient.getModelFit(model ?? ""),
        enabled: model !== undefined && model !== APPLE_FOUNDATION_MODEL,
        staleTime: QUERY_STALE_TIME_MS.STANDARD,
        retry: 0,
    });
}
