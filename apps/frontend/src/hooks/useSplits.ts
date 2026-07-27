import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '@/lib/api';
import { splitKeys } from '@/lib/queryKeys';
import { toast } from 'sonner';
import { apiErrorToMessage } from '@/lib/api/errorMessage';
import { useLanguage } from '@/contexts/LanguageContext';
import type { SplitCreateInput } from '@/types/splits';

export function useOwedSummary() {
    return useQuery({
        queryKey: splitKeys.owedSummary,
        queryFn: () => apiClient.getOwedSummary(),
        staleTime: 30_000,
    });
}

export function useOwedByRecipient(recipientId: number | null) {
    return useQuery({
        queryKey: splitKeys.owedByRecipient(recipientId),
        queryFn: () => apiClient.getOwedByRecipient(recipientId!),
        enabled: !!recipientId,
        staleTime: 30_000,
    });
}

export function useSplitsByTransaction(transactionId: number | null) {
    return useQuery({
        queryKey: splitKeys.byTransaction(transactionId),
        queryFn: () => apiClient.getSplitsByTransaction(transactionId!),
        enabled: !!transactionId,
        staleTime: 30_000,
    });
}

export function useCreateSplits() {
    const qc = useQueryClient();
    const { t } = useLanguage();
    return useMutation({
        mutationFn: (data: { transaction_id: number; splits: SplitCreateInput[] }) =>
            apiClient.createSplitsBatch(data.transaction_id, data.splits),
        onSuccess: () => {
            qc.invalidateQueries({ queryKey: splitKeys.all });
            toast.success(t('splits.created'));
        },
        onError: (e: Error) => toast.error(t('splits.createFailed'), { description: apiErrorToMessage(e, t) }),
    });
}

export function useRecordPayment() {
    const qc = useQueryClient();
    const { t } = useLanguage();
    return useMutation({
        mutationFn: (data: { splitId: number; amount: number; note?: string; paid_at?: string }) =>
            apiClient.recordSplitPayment(data.splitId, data.amount, data.note, data.paid_at),
        onSuccess: () => {
            qc.invalidateQueries({ queryKey: splitKeys.all });
            toast.success(t('splits.paymentRecorded'));
        },
        onError: (e: Error) => toast.error(t('splits.paymentFailed'), { description: apiErrorToMessage(e, t) }),
    });
}

export function useSettleSplit() {
    const qc = useQueryClient();
    const { t } = useLanguage();
    return useMutation({
        mutationFn: (splitId: number) => apiClient.settleSplit(splitId),
        onSuccess: () => {
            qc.invalidateQueries({ queryKey: splitKeys.all });
            toast.success(t('splits.settled'));
        },
        onError: (e: Error) => toast.error(t('splits.settledFailed'), { description: apiErrorToMessage(e, t) }),
    });
}

export function useSettleAllSplitsByRecipient() {
    const qc = useQueryClient();
    const { t } = useLanguage();
    return useMutation({
        mutationFn: (recipientId: number) => apiClient.settleAllSplitsByRecipient(recipientId),
        onSuccess: (result) => {
            qc.invalidateQueries({ queryKey: splitKeys.all });
            toast.success(t('splits.allSettled', { n: result.settled_count }));
        },
        onError: (e: Error) => toast.error(t('splits.allSettledFailed'), { description: apiErrorToMessage(e, t) }),
    });
}

export function useDeleteSplit() {
    const qc = useQueryClient();
    const { t } = useLanguage();
    return useMutation({
        mutationFn: (splitId: number) => apiClient.deleteSplit(splitId),
        onSuccess: () => {
            qc.invalidateQueries({ queryKey: splitKeys.all });
            toast.success(t('splits.removed'));
        },
        onError: (e: Error) => toast.error(t('splits.removeFailed'), { description: apiErrorToMessage(e, t) }),
    });
}
