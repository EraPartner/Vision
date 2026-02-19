/**
 * Custom React hooks for API data fetching
 */

import {useMutation, useQuery, useQueryClient} from '@tanstack/react-query';
import {apiClient} from '@/lib/api';
import type {TransactionUpdate} from '@/types/api';
import {toast} from 'sonner';

export const useStatistics = () => {
    return useQuery({
        queryKey: ['statistics'],
        queryFn: () => apiClient.getStatistics(),
        staleTime: 30000, // 30 seconds
    });
};

export const useSupportedParsers = () => {
    return useQuery({
        queryKey: ['supported-parsers'],
        queryFn: () => apiClient.getSupportedParsers(),
        staleTime: 300000, // 5 minutes (this is static configuration data)
    });
};

/** @deprecated Use useSupportedParsers instead */
export const useBanks = () => {
    return useQuery({
        queryKey: ['banks'],
        queryFn: () => apiClient.getBanks(),
        staleTime: 60000, // 1 minute
    });
};

interface TransactionsParams {
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

export const useTransactions = (params?: TransactionsParams) => {
    console.log('🔄 useTransactions hook called with params:', params);

    return useQuery({
        queryKey: ['transactions', params],
        queryFn: async () => {
            console.log('💳 Fetching transactions...');
            const data = await apiClient.getTransactions(params);
            console.log('💳 Transactions received:', {
                total: data.total,
                count: data.transactions?.length || 0,
                limit: data.limit,
                offset: data.offset,
            });
            return data;
        },
        staleTime: 10000,
        onError: (error) => {
            console.error('❌ Transactions fetch error:', error);
        },
        onSuccess: (data) => {
            console.log('✅ Transactions fetch success:', {
                total: data.total,
                returned: data.transactions?.length || 0,
            });
        },
    });
};

export const useUpdateTransaction = () => {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: ({id, update}: { id: number; update: TransactionUpdate }) =>
            apiClient.updateTransaction(id, update),
        onSuccess: () => {
            queryClient.invalidateQueries({queryKey: ['transactions']});
            queryClient.invalidateQueries({queryKey: ['statistics']});
            toast.success('Transaction updated successfully');
        },
        onError: (error: Error) => {
            toast.error(`Failed to update transaction: ${error.message}`);
        },
    });
};

export const useDeleteTransaction = () => {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: (id: number) => apiClient.deleteTransaction(id),
        onSuccess: () => {
            queryClient.invalidateQueries({queryKey: ['transactions']});
            queryClient.invalidateQueries({queryKey: ['statistics']});
            toast.success('Transaction deleted successfully');
        },
        onError: (error: Error) => {
            toast.error(`Failed to delete transaction: ${error.message}`);
        },
    });
};
