import {useMutation, useQuery, useQueryClient} from '@tanstack/react-query';
import {apiClient} from '@/lib/api';
import type {TransactionCreate, TransactionUpdate} from '@/types/api';
import {toast} from 'sonner';

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
}

export function useTransactions(params?: UseTransactionsParams) {
    return useQuery({
        queryKey: ['transactions', params],
        queryFn: () => apiClient.getTransactions(params),
    });
}

export function useTransaction(id: number) {
    return useQuery({
        queryKey: ['transactions', id],
        queryFn: () => apiClient.getTransaction(id),
        enabled: !!id,
    });
}

export function useCreateTransaction() {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: (transaction: TransactionCreate) => apiClient.createTransaction(transaction),
        onSuccess: () => {
            queryClient.invalidateQueries({queryKey: ['transactions']});
            toast.success('Transaction created successfully');
        },
        onError: (error: Error) => {
            toast.error(`Failed to create transaction: ${error.message}`);
        },
    });
}

export function useUpdateTransaction() {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: ({id, data}: { id: number; data: TransactionUpdate }) =>
            apiClient.updateTransaction(id, data),
        onSuccess: () => {
            queryClient.invalidateQueries({queryKey: ['transactions']});
            toast.success('Transaction updated successfully');
        },
        onError: (error: Error) => {
            toast.error(`Failed to update transaction: ${error.message}`);
        },
    });
}

export function useDeleteTransaction() {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: (id: number) => apiClient.deleteTransaction(id),
        onSuccess: () => {
            queryClient.invalidateQueries({queryKey: ['transactions']});
            toast.success('Transaction deleted successfully');
        },
        onError: (error: Error) => {
            toast.error(`Failed to delete transaction: ${error.message}`);
        },
    });
}
