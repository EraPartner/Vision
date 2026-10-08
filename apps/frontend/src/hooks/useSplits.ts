import { QUERY_STALE_TIME_MS } from "@/lib/queryPolicies";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "@/lib/api";
import { invalidateTransactionData, splitKeys } from "@/lib/queryKeys";
import { toast } from "sonner";
import { apiErrorToMessage } from "@/lib/api/errorMessage";
import { useLanguage } from "@/stores/hydration/LanguageHydration";
import type { BulkSplitRequest, SplitCreateInput } from "@/lib/api/splits";

export function useOwedSummary() {
    return useQuery({
        queryKey: splitKeys.owedSummary,
        queryFn: () => apiClient.getOwedSummary(),
        staleTime: QUERY_STALE_TIME_MS.FREQUENT,
    });
}

export function useOwedByRecipient(recipientId: number | null) {
    return useQuery({
        queryKey: splitKeys.owedByRecipient(recipientId),
        queryFn: () => apiClient.getOwedByRecipient(recipientId!),
        enabled: !!recipientId,
        staleTime: QUERY_STALE_TIME_MS.FREQUENT,
    });
}

export function useSplitsByTransaction(transactionId: number | null) {
    return useQuery({
        queryKey: splitKeys.byTransaction(transactionId),
        queryFn: () => apiClient.getSplitsByTransaction(transactionId!),
        enabled: !!transactionId,
        staleTime: QUERY_STALE_TIME_MS.FREQUENT,
    });
}

export function useCreateSplits() {
    const qc = useQueryClient();
    const { t } = useLanguage();
    return useMutation({
        mutationFn: (data: {
            transaction_id: number;
            splits: SplitCreateInput[];
        }) => apiClient.createSplitsBatch(data.transaction_id, data.splits),
        onSuccess: () => {
            qc.invalidateQueries({ queryKey: splitKeys.all });
            toast.success(t("splits.created"));
        },
        onError: (e: Error) =>
            toast.error(t("splits.createFailed"), {
                description: apiErrorToMessage(e, t),
            }),
    });
}

/**
 * Bulk "Split" from the transactions toolbar. The toast names what was NOT
 * split (already split, no amount, gone) so a partial result is never read as
 * a full one.
 */
export function useBulkSplitTransactions() {
    const qc = useQueryClient();
    const { t, tc } = useLanguage();
    return useMutation({
        mutationFn: (request: BulkSplitRequest) =>
            apiClient.createBulkSplits(request),
        onSuccess: (result) => {
            qc.invalidateQueries({ queryKey: splitKeys.all });
            invalidateTransactionData(qc);
            const skippedOther =
                result.skipped_zero_amount + result.skipped_missing;
            const details = [
                result.skipped_already_split > 0
                    ? tc(
                          "splits.bulkSkippedAlreadySplit",
                          result.skipped_already_split,
                      )
                    : null,
                skippedOther > 0
                    ? tc("splits.bulkSkippedOther", skippedOther)
                    : null,
            ].filter((line): line is string => line !== null);
            const description =
                details.length > 0 ? details.join(" ") : undefined;
            if (result.split === 0) {
                toast.info(t("splits.bulkNothingSplit"), { description });
                return;
            }
            toast.success(tc("splits.bulkCreated", result.split), {
                description,
            });
        },
        onError: (e: Error) =>
            toast.error(t("splits.bulkCreateFailed"), {
                description: apiErrorToMessage(e, t),
            }),
    });
}

export function useRecordPayment() {
    const qc = useQueryClient();
    const { t } = useLanguage();
    return useMutation({
        mutationFn: (data: {
            splitId: number;
            amount: number;
            note?: string;
            paid_at?: string;
        }) =>
            apiClient.recordSplitPayment(
                data.splitId,
                data.amount,
                data.note,
                data.paid_at,
            ),
        onSuccess: () => {
            qc.invalidateQueries({ queryKey: splitKeys.all });
            toast.success(t("splits.paymentRecorded"));
        },
        onError: (e: Error) =>
            toast.error(t("splits.paymentFailed"), {
                description: apiErrorToMessage(e, t),
            }),
    });
}

export function useSettleSplit() {
    const qc = useQueryClient();
    const { t } = useLanguage();
    return useMutation({
        mutationFn: (splitId: number) => apiClient.settleSplit(splitId),
        onSuccess: () => {
            qc.invalidateQueries({ queryKey: splitKeys.all });
            toast.success(t("splits.settled"));
        },
        onError: (e: Error) =>
            toast.error(t("splits.settledFailed"), {
                description: apiErrorToMessage(e, t),
            }),
    });
}

export function useSettleAllSplitsByRecipient() {
    const qc = useQueryClient();
    const { t } = useLanguage();
    return useMutation({
        mutationFn: (recipientId: number) =>
            apiClient.settleAllSplitsByRecipient(recipientId),
        onSuccess: (result) => {
            qc.invalidateQueries({ queryKey: splitKeys.all });
            toast.success(t("splits.allSettled", { n: result.settled_count }));
        },
        onError: (e: Error) =>
            toast.error(t("splits.allSettledFailed"), {
                description: apiErrorToMessage(e, t),
            }),
    });
}

export function useDeleteSplit() {
    const qc = useQueryClient();
    const { t } = useLanguage();
    return useMutation({
        mutationFn: (splitId: number) => apiClient.deleteSplit(splitId),
        onSuccess: () => {
            qc.invalidateQueries({ queryKey: splitKeys.all });
            toast.success(t("splits.removed"));
        },
        onError: (e: Error) =>
            toast.error(t("splits.removeFailed"), {
                description: apiErrorToMessage(e, t),
            }),
    });
}
