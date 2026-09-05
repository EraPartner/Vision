import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { apiClient } from "@/lib/api";
import { plannedKeys } from "@/lib/queryKeys";
import type { PlannedPayment } from "@/hooks/usePlannedPayments";
import type { Transaction } from "@/types/api";
import { useBackgroundQueryCue } from "@/components/shared/BackgroundQueryIndicator";

export interface LinkTransactionFilters {
    start_date: string;
    end_date: string;
    bank_account: string;
    recipient_name: string;
    recipient_id: number | null;
    uncategorised: boolean;
    active: boolean;
    matchAmount: boolean;
    amountTolerancePct: number;
}

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

export function useRecurringPatterns() {
    return useQuery({
        queryKey: plannedKeys.recurringPatterns,
        queryFn: () => apiClient.getRecurringPatterns(),
        staleTime: 5 * 60_000,
        retry: false,
        refetchOnWindowFocus: false,
        refetchOnReconnect: false,
    });
}

export function useLinkTransactionCandidates(
    payment: PlannedPayment | null,
    filters: LinkTransactionFilters | null,
    enabled: boolean,
) {
    const query = useQuery({
        queryKey: ["linkTxCandidates", payment?.id, filters],
        enabled: enabled && !!payment && filters !== null,
        placeholderData: keepPreviousData,
        queryFn: async () => {
            const current = filters!;
            const params: Record<string, string | number | boolean> = {
                limit: 50,
            };
            if (current.start_date) params.start_date = current.start_date;
            if (current.end_date) params.end_date = current.end_date;
            if (current.bank_account)
                params.bank_account = current.bank_account;
            if (current.recipient_id != null) {
                params.recipient_id = current.recipient_id;
            } else if (current.recipient_name) {
                params.recipient_name = current.recipient_name;
            } else if (payment?.recipient) {
                params.recipient_name = payment.recipient;
            }
            if (current.uncategorised) params.uncategorised = true;
            params.active = current.active;
            const response = await apiClient.getTransactions(params);
            return (response.items ?? []) as Transaction[];
        },
    });
    useBackgroundQueryCue(query.isFetching && query.isPlaceholderData);
    return query;
}
