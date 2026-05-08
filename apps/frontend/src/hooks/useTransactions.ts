import {useMutation, useQuery, useQueryClient} from '@tanstack/react-query';
import {apiClient} from '@/lib/api';
import type {
    BulkExportRequest,
    BulkSelectionRequest,
    BulkTagRequest,
    BulkUpdateRequest,
    TransactionCreate,
    TransactionUpdate,
} from '@/types/api';
import {toast} from 'sonner';
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
            queryClient.invalidateQueries({queryKey: ['transactions-virtual']});
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
            queryClient.invalidateQueries({queryKey: ['transactions-virtual']});
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
            queryClient.invalidateQueries({queryKey: ['transactions-virtual']});
            queryClient.invalidateQueries({queryKey: ['monthlySummary']});
            toast.success(t('transactions.deleted'));
        },
        onError: (error: Error) => {
            toast.error(t('transactions.deleteFailedTitle'), { description: error.message });
        },
    });
}

export function useBulkTagTransactions() {
    const queryClient = useQueryClient();
    const { t } = useLanguage();

    return useMutation({
        mutationFn: (request: BulkTagRequest) => apiClient.bulkTagTransactions(request),
        onSuccess: () => {
            queryClient.invalidateQueries({queryKey: ['transactions']});
            queryClient.invalidateQueries({queryKey: ['transactions-virtual']});
            queryClient.invalidateQueries({queryKey: ['tags']});
            toast.success(t('tags.bulkApplied'));
        },
        onError: (error: Error) => {
            toast.error(t('tags.bulkFailed'), { description: error.message });
        },
    });
}

function invalidateTransactionViews(queryClient: ReturnType<typeof useQueryClient>) {
    queryClient.invalidateQueries({ queryKey: ['transactions'] });
    queryClient.invalidateQueries({ queryKey: ['transactions-virtual'] });
    queryClient.invalidateQueries({ queryKey: ['monthlySummary'] });
    queryClient.invalidateQueries({ queryKey: ['stats'] });
}

export function useBulkDeleteTransactions() {
    const queryClient = useQueryClient();
    const { t } = useLanguage();

    return useMutation({
        mutationFn: (request: BulkSelectionRequest) => apiClient.bulkDeleteTransactions(request),
        onSuccess: (result) => {
            invalidateTransactionViews(queryClient);
            toast.success(t('txPage.bulk.deleted', { n: result.deleted }));
        },
        onError: (error: Error) => {
            toast.error(t('txPage.bulk.failed'), { description: error.message });
        },
    });
}

export function useBulkUpdateTransactions() {
    const queryClient = useQueryClient();
    const { t } = useLanguage();

    return useMutation({
        mutationFn: (request: BulkUpdateRequest) => apiClient.bulkUpdateTransactions(request),
        onSuccess: (result) => {
            invalidateTransactionViews(queryClient);
            queryClient.invalidateQueries({ queryKey: ['categories'] });
            queryClient.invalidateQueries({ queryKey: ['recipients'] });
            toast.success(t('txPage.bulk.updated', { n: result.updated }));
        },
        onError: (error: Error) => {
            toast.error(t('txPage.bulk.failed'), { description: error.message });
        },
    });
}

export function useBulkExportTransactions() {
    const { t } = useLanguage();

    return useMutation({
        mutationFn: (request: BulkExportRequest) => apiClient.bulkExportTransactions(request),
        onSuccess: (blob, request) => {
            const ext = request.format === 'csv' ? 'csv' : 'ndjson';
            const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
            const filename = `transactions_export_${stamp}.${ext}`;
            triggerBlobDownload(blob, filename);
            toast.success(t('txPage.bulk.exported'));
        },
        onError: (error: Error) => {
            toast.error(t('txPage.bulk.failed'), { description: error.message });
        },
    });
}

function triggerBlobDownload(blob: Blob, filename: string): void {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
}
