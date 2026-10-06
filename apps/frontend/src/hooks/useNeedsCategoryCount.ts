import { useQuery } from "@tanstack/react-query";
import { apiClient } from "@/lib/api";
import { transactionKeys } from "@/lib/queryKeys";
import { QUERY_STALE_TIME_MS } from "@/lib/queryPolicies";

const NEEDS_CATEGORY_PARAMS = {
    uncategorised: true,
    active: true,
    limit: 1,
} as const;

/**
 * How many active transactions still have no category. Read from the list
 * endpoint's `total` with a one-row page, so the sidebar count costs one
 * count query and shares the transactions cache prefix for invalidation.
 */
export function useNeedsCategoryCount() {
    return useQuery({
        queryKey: transactionKeys.list(NEEDS_CATEGORY_PARAMS),
        queryFn: ({ signal }) =>
            apiClient.getTransactions(NEEDS_CATEGORY_PARAMS, signal),
        select: (data) => data.total,
        staleTime: QUERY_STALE_TIME_MS.FREQUENT,
        retry: false,
    });
}
