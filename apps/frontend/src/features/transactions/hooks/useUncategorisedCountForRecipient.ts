import { useQuery } from "@tanstack/react-query";
import { apiClient } from "@/lib/api";
import { transactionKeys } from "@/lib/queryKeys";
import { QUERY_STALE_TIME_MS } from "@/lib/queryPolicies";

/**
 * Active rows of one payee still without a category, read from the list
 * endpoint's `total` with a one-row page (the same count query the sidebar
 * badge uses, narrowed to the payee). Feeds the inspector's category tips.
 */
export function useUncategorisedCountForRecipient(recipientId: number | undefined) {
    const params = {
        recipient_id: recipientId,
        uncategorised: true,
        active: true,
        limit: 1,
    } as const;
    return useQuery({
        queryKey: transactionKeys.list(params),
        queryFn: ({ signal }) => apiClient.getTransactions(params, signal),
        select: (data) => data.total,
        enabled: recipientId != null,
        staleTime: QUERY_STALE_TIME_MS.FREQUENT,
        retry: false,
    });
}
