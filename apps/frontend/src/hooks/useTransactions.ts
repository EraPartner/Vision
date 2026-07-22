import {useMutation, useQuery, useQueryClient} from '@tanstack/react-query';
import {registerUndo} from '@/lib/undo';
import { downloadBlob } from '@/lib/downloadBlob';
import {apiClient} from '@/lib/api';
import {
    categoryKeys,
    invalidateTransactionData,
    recipientKeys,
    tagKeys,
    transactionKeys,
} from '@/lib/queryKeys';
import type {
    BulkExportRequest,
    BulkSelectionRequest,
    BulkTagRequest,
    BulkUpdateRequest,
    Transaction,
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
        queryKey: transactionKeys.list(params),
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
        // Optimistic insert at the head of the plain list caches with a
        // temporary negative id; onSuccess swaps in the server row (so row
        // actions get the real id immediately), onSettled re-sorts/filters
        // via invalidation. Derived fields (category_name, …) stay undefined
        // until the refetch — renderers already fall back for those.
        onMutate: async (transaction) => {
            await queryClient.cancelQueries({queryKey: transactionKeys.all});
            const snapshot = snapshotTransactionLists(queryClient);
            const tempId = -Date.now();
            const tempRow = {...transaction, id: tempId} as unknown as Transaction;
            queryClient.setQueriesData<TransactionsListResponse>({queryKey: transactionKeys.all}, (old) => {
                if (!old?.items) return old;
                return {
                    ...old,
                    items: [tempRow, ...old.items],
                    total: (old.total ?? old.items.length) + 1,
                };
            });
            return {snapshot, tempId};
        },
        onSuccess: (created, _vars, context) => {
            if (context?.tempId != null) {
                queryClient.setQueriesData<TransactionsListResponse>({queryKey: transactionKeys.all}, (old) => {
                    if (!old?.items) return old;
                    return {
                        ...old,
                        items: old.items.map((tx) => (tx.id === context.tempId ? created : tx)),
                    };
                });
            }
            toast.success(t('transactions.created'));
        },
        onError: (error: Error, _vars, context) => {
            if (context?.snapshot) rollbackTransactionLists(queryClient, context.snapshot);
            toast.error(t('transactions.createFailedTitle'), { description: error.message });
        },
        onSettled: () => {
            invalidateTransactionData(queryClient);
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
    return queryClient.getQueriesData<TransactionsListResponse>({queryKey: transactionKeys.all});
}

function rollbackTransactionLists(queryClient: ReturnType<typeof useQueryClient>, snapshot: TransactionsSnapshot) {
    for (const [key, data] of snapshot) {
        queryClient.setQueryData(key, data);
    }
}

export function useUpdateTransaction() {
    const queryClient = useQueryClient();
    const { t } = useLanguage();

    return useMutation({
        mutationFn: ({id, data}: { id: number; data: TransactionUpdate }) =>
            apiClient.updateTransaction(id, data),
        onMutate: async ({id, data}) => {
            await queryClient.cancelQueries({queryKey: transactionKeys.all});
            const snapshot = snapshotTransactionLists(queryClient);
            // `tags` is excluded from the optimistic merge: the update payload
            // carries string[] while the cached rows hold Tag[] objects.
            const {tags: _tags, ...optimisticFields} = data;
            queryClient.setQueriesData<TransactionsListResponse>({queryKey: transactionKeys.all}, (old) => {
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
            invalidateTransactionData(queryClient);
        },
    });
}

export function useDeleteTransaction() {
    const queryClient = useQueryClient();
    const { t } = useLanguage();

    return useMutation({
        mutationFn: (id: number) => apiClient.deleteTransaction(id),
        onMutate: async (id) => {
            await queryClient.cancelQueries({queryKey: transactionKeys.all});
            const snapshot = snapshotTransactionLists(queryClient);
            // Keep the deleted row so Undo can faithfully recreate it.
            let deletedRow: Transaction | undefined;
            for (const [, data] of snapshot) {
                deletedRow = data?.items?.find((tx) => tx.id === id);
                if (deletedRow) break;
            }
            queryClient.setQueriesData<TransactionsListResponse>({queryKey: transactionKeys.all}, (old) => {
                if (!old?.items) return old;
                const items = old.items.filter((tx) => tx.id !== id);
                if (items.length === old.items.length) return old;
                return {
                    ...old,
                    items,
                    total: Math.max(0, (old.total ?? old.items.length) - 1),
                };
            });
            return {snapshot, deletedRow};
        },
        onSuccess: (_data, _id, context) => {
            const row = context?.deletedRow;
            // recipient_id is required by the create contract — without it we
            // cannot faithfully restore, so no Undo is offered.
            if (row?.recipient_id != null && row.transaction_date && row.bank_account) {
                const restore = async () => {
                    try {
                        await apiClient.createTransaction({
                            transaction_date: row.transaction_date,
                            // Guarded truthy above; nullable wire fields map to
                            // undefined for the create contract.
                            bank_account: row.bank_account as string,
                            recipient_id: row.recipient_id as number,
                            memo: row.memo ?? undefined,
                            amount: row.amount,
                            currency: row.currency,
                            balance: row.balance,
                            category_id: row.category_id ?? undefined,
                            comment: row.comment ?? undefined,
                            tags: row.tags?.map((tag) => (typeof tag === 'string' ? tag : tag.slug)),
                        });
                        invalidateTransactionData(queryClient);
                        toast.success(t('transactions.restored'));
                    } catch (error) {
                        toast.error(t('transactions.restoreFailedTitle'), {
                            description: error instanceof Error ? error.message : String(error),
                        });
                    }
                };
                registerUndo(restore);
                toast.success(t('transactions.deleted'), {
                    action: {label: t('common.undo'), onClick: () => void restore()},
                });
            } else {
                toast.success(t('transactions.deleted'));
            }
        },
        onError: (error: Error, _id, context) => {
            if (context?.snapshot) rollbackTransactionLists(queryClient, context.snapshot);
            toast.error(t('transactions.deleteFailedTitle'), { description: error.message });
        },
        onSettled: () => {
            invalidateTransactionData(queryClient);
        },
    });
}

export function useBulkTagTransactions() {
    const queryClient = useQueryClient();
    const { t } = useLanguage();

    return useMutation({
        mutationFn: (request: BulkTagRequest) => apiClient.bulkTagTransactions(request),
        onSuccess: () => {
            invalidateTransactionData(queryClient);
            queryClient.invalidateQueries({queryKey: tagKeys.all});
            toast.success(t('tags.bulkApplied'));
        },
        onError: (error: Error) => {
            toast.error(t('tags.bulkFailed'), { description: error.message });
        },
    });
}

export function useBulkDeleteTransactions() {
    const queryClient = useQueryClient();
    const { t } = useLanguage();

    return useMutation({
        mutationFn: (request: BulkSelectionRequest) => apiClient.bulkDeleteTransactions(request),
        onSuccess: (result) => {
            invalidateTransactionData(queryClient);
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
            invalidateTransactionData(queryClient);
            queryClient.invalidateQueries({ queryKey: categoryKeys.all });
            queryClient.invalidateQueries({ queryKey: recipientKeys.all });
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
            downloadBlob(blob, filename);
            toast.success(t('txPage.bulk.exported'));
        },
        onError: (error: Error) => {
            toast.error(t('txPage.bulk.failed'), { description: error.message });
        },
    });
}


