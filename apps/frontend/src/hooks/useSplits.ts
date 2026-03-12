import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '@/lib/api';
import { toast } from 'sonner';
import { useLanguage } from '@/contexts/LanguageContext';
import type { OwedSummary, TransactionSplit, TransactionSplitDetail, SplitPayment, SplitCreateInput } from '@/types/splits';

export function useOwedSummary() {
    return useQuery({
        queryKey: ['splits', 'owed'],
        queryFn: () => apiClient.getOwedSummary(),
        staleTime: 30_000,
    });
}

export function useOwedByRecipient(recipientId: number | null) {
    return useQuery({
        queryKey: ['splits', 'owed', recipientId],
        queryFn: () => apiClient.getOwedByRecipient(recipientId!),
        enabled: !!recipientId,
        staleTime: 30_000,
    });
}

export function useSplitsByTransaction(transactionId: number | null) {
    return useQuery({
        queryKey: ['splits', 'transaction', transactionId],
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
            qc.invalidateQueries({ queryKey: ['splits'] });
            toast.success(t('splits.created'));
        },
        onError: (e: Error) => toast.error(t('splits.createFailed'), { description: e.message }),
    });
}

export function useRecordPayment() {
    const qc = useQueryClient();
    const { t } = useLanguage();
    return useMutation({
        mutationFn: (data: { splitId: number; amount: number; note?: string; paid_at?: string }) =>
            apiClient.recordSplitPayment(data.splitId, data.amount, data.note, data.paid_at),
        onSuccess: () => {
            qc.invalidateQueries({ queryKey: ['splits'] });
            toast.success(t('splits.paymentRecorded'));
        },
        onError: (e: Error) => toast.error(t('splits.paymentFailed'), { description: e.message }),
    });
}

export function useSettleSplit() {
    const qc = useQueryClient();
    const { t } = useLanguage();
    return useMutation({
        mutationFn: (splitId: number) => apiClient.settleSplit(splitId),
        onSuccess: () => {
            qc.invalidateQueries({ queryKey: ['splits'] });
            toast.success(t('splits.settled'));
        },
        onError: (e: Error) => toast.error(t('splits.settledFailed'), { description: e.message }),
    });
}

export function useDeleteSplit() {
    const qc = useQueryClient();
    const { t } = useLanguage();
    return useMutation({
        mutationFn: (splitId: number) => apiClient.deleteSplit(splitId),
        onSuccess: () => {
            qc.invalidateQueries({ queryKey: ['splits'] });
            toast.success(t('splits.removed'));
        },
        onError: (e: Error) => toast.error(t('splits.removeFailed'), { description: e.message }),
    });
}
