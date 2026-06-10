import {useMutation, useQuery, useQueryClient} from '@tanstack/react-query';
import {apiClient} from '@/lib/api';
import type {
    BulkExportRequest,
    BulkSelectionRequest,
    BulkTagRequest,
    BulkUpdateRequest,
    TransactionCreate,
    TransactionsListResponse,
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

type TransactionsSnapshot = Array<[readonly unknown[], TransactionsListResponse | undefined]>;

/**
 * Optimistic-update helpers for the plain `['transactions', params]` caches.
 *
 * Deliberately does NOT touch `['transactions-virtual', …]`: the virtual list
 * mirrors its cached first page into local state and would collapse a
 * scrolled list if that cache changed under it. It stays invalidate-only.
 *
 * Snapshot-all → patch-all → rollback-all-on-error, with onSettled
 * invalidation so server truth always wins regardless of outcome.
 */
function snapshotTransactionLists(queryClient: ReturnType<typeof useQueryClient>): TransactionsSnapshot {
    return queryClient.getQueriesData<TransactionsListResponse>({queryKey: ['transactions']});
}

function rollbackTransactionLists(queryClient: ReturnType<typeof useQueryClient>, snapshot: TransactionsSnapshot) {
    for (const [key, data] of snapshot) {
        queryClient.setQueryData(key, data);
    }
}

function invalidateTransactionLists(queryClient: ReturnType<typeof useQueryClient>) {
    queryClient.invalidateQueries({queryKey: ['transactions']});
    queryClient.invalidateQueries({queryKey: ['transactions-virtual']});
    queryClient.invalidateQueries({queryKey: ['monthlySummary']});
}

export function useUpdateTransaction() {
    const queryClient = useQueryClient();
    const { t } = useLanguage();

    return useMutation({
        mutationFn: ({id, data}: { id: number; data: TransactionUpdate }) =>
            apiClient.updateTransaction(id, data),
        onMutate: async ({id, data}) => {
            await queryClient.cancelQueries({queryKey: ['transactions']});
            const snapshot = snapshotTransactionLists(queryClient);
            // `tags` is excluded from the optimistic merge: the update payload
            // carries string[] while the cached rows hold Tag[] objects.
            const {tags: _tags, ...optimisticFields} = data;
            queryClient.setQueriesData<TransactionsListResponse>({queryKey: ['transactions']}, (old) => {
                if (!old?.items) return old;
                return {
                    ...old,
                    items: old.items.map((tx) => (tx.id === id ? {...tx, ...optimisticFields} : tx)),
                };
            });
            return {snapshot};
        },
        onSuccess: () => {
            toast.success(t('transactions.updated'));
        },
        onError: (error: Error, _vars, context) => {
            if (context?.snapshot) rollbackTransactionLists(queryClient, context.snapshot);
            toast.error(t('transactions.updateFailedTitle'), { description: error.message });
        },
        onSettled: () => {
            invalidateTransactionLists(queryClient);
        },
    });
}

export function useDeleteTransaction() {
    const queryClient = useQueryClient();
    const { t } = useLanguage();

    return useMutation({
        mutationFn: (id: number) => apiClient.deleteTransaction(id),
        onMutate: async (id) => {
            await queryClient.cancelQueries({queryKey: ['transactions']});
            const snapshot = snapshotTransactionLists(queryClient);
            queryClient.setQueriesData<TransactionsListResponse>({queryKey: ['transactions']}, (old) => {
                if (!old?.items) return old;
                const items = old.items.filter((tx) => tx.id !== id);
                if (items.length === old.items.length) return old;
                return {
                    ...old,
                    items,
                    total: Math.max(0, (old.total ?? old.items.length) - 1),
                };
            });
            return {snapshot};
        },
        onSuccess: () => {
            toast.success(t('transactions.deleted'));
        },
        onError: (error: Error, _id, context) => {
            if (context?.snapshot) rollbackTransactionLists(queryClient, context.snapshot);
            toast.error(t('transactions.deleteFailedTitle'), { description: error.message });
        },
        onSettled: () => {
            invalidateTransactionLists(queryClient);
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
