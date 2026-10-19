import { useQuery } from "@tanstack/react-query";
import { apiClient } from "@/lib/api";
import { plannedKeys } from "@/lib/queryKeys";
import { todayYmd } from "@/lib/timezone";

/**
 * Planned totals computed on the server in `currency`: money still due this
 * month (every recurring occurrence counted) and the net monthly-equivalent of
 * active recurring rows. Planned mutations invalidate it via the upcoming
 * prefix.
 */
export function usePlannedTotals(currency: string) {
    return useQuery({
        queryKey: plannedKeys.totals(currency, todayYmd()),
        queryFn: () => apiClient.getPlannedTotals(currency),
        staleTime: 5 * 60_000,
    });
}
