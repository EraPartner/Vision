import { useQuery } from "@tanstack/react-query";
import { apiClient } from "@/lib/api";
import { plannedKeys } from "@/lib/queryKeys";
import type { AccountId } from "@vision/types/brands";

/** Active, unexecuted plans for the account forecast section. */
export function useAccountPlannedTransactions(
    accountId: AccountId | undefined,
    enabled: boolean,
) {
    return useQuery({
        queryKey: plannedKeys.accountTransactions(accountId),
        queryFn: () =>
            apiClient.getPlannedTransactions({
                account_id: accountId!,
                active: true,
                is_executed: false,
                limit: 5000,
            }),
        enabled: enabled && accountId != null,
        retry: false,
    });
}
