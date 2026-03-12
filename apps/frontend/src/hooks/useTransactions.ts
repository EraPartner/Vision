import {useMutation, useQuery, useQueryClient} from '@tanstack/react-query';
import {apiClient} from '@/lib/api';
import type {TransactionCreate, TransactionUpdate} from '@/types/api';
import {toast} from 'sonner';
import {useCallback} from 'react';
import {useLanguage} from '@/contexts/LanguageContext';

interface UseTransactionsParams {
    limit?: number;
    offset?: number;
    start_date?: string;
    end_date?: string;
    bank_account?: string;
    category_id?: number;
    recipient_id?: number;
    recipient_name?: string;
    uncategorised?: boolean;
    active?: boolean;
    search?: string;
}

export function useTransactions(params?: UseTransactionsParams) {
    return useQuery({
        queryKey: ['transactions', params],
        queryFn: () => apiClient.getTransactions(params),
        staleTime: 30_000,
        placeholderData: (prev) => prev, // keep previous data while fetching (smooth pagination)
    });
}

export function useTransaction(id: number) {
    return useQuery({
        queryKey: ['transactions', id],
        queryFn: () => apiClient.getTransaction(id),
        enabled: !!id,
        staleTime: 60_000,
    });
}

export function useCreateTransaction() {
    const queryClient = useQueryClient();
    const { t } = useLanguage();

    return useMutation({
        mutationFn: (transaction: TransactionCreate) => apiClient.createTransaction(transaction),
        onSuccess: () => {
            queryClient.invalidateQueries({queryKey: ['transactions']});
            queryClient.invalidateQueries({queryKey: ['monthlySummary']});
            toast.success(t('transactions.created'));
        },
        onError: (error: Error) => {
            toast.error(t('transactions.createFailedTitle'), { description: error.message });
        },
    });
}

export function useUpdateTransaction() {
    const queryClient = useQueryClient();
    const { t } = useLanguage();

    return useMutation({
        mutationFn: ({id, data}: { id: number; data: TransactionUpdate }) =>
            apiClient.updateTransaction(id, data),
        onSuccess: () => {
            queryClient.invalidateQueries({queryKey: ['transactions']});
            queryClient.invalidateQueries({queryKey: ['monthlySummary']});
            toast.success(t('transactions.updated'));
        },
        onError: (error: Error) => {
            toast.error(t('transactions.updateFailedTitle'), { description: error.message });
        },
    });
}

export function useDeleteTransaction() {
    const queryClient = useQueryClient();
    const { t } = useLanguage();

    return useMutation({
        mutationFn: (id: number) => apiClient.deleteTransaction(id),
        onSuccess: () => {
            queryClient.invalidateQueries({queryKey: ['transactions']});
            queryClient.invalidateQueries({queryKey: ['monthlySummary']});
            toast.success(t('transactions.deleted'));
        },
        onError: (error: Error) => {
            toast.error(t('transactions.deleteFailedTitle'), { description: error.message });
        },
    });
}
