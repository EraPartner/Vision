import type {
    Transaction,
    TransactionCreate,
    TransactionsListResponse,
    TransactionUpdate,
} from '@/types/api';
import { apiRequest } from '@/lib/api/client';
import { requestWithQuery } from '@/lib/api/helpers';

export async function getTransactions(params?: {
    transaction_id?: number;
    limit?: number;
    offset?: number;
    start_date?: string;
    end_date?: string;
    bank_account?: string;
    category_id?: number;
    category_ids?: number[];
    recipient_id?: number;
    recipient_group_id?: number;
    recipient_name?: string;
    uncategorised?: boolean;
    active?: boolean;
    search?: string;
    normalize_to_eur?: boolean;
    target_currency?: string;
    sort_by?: string;
    sort_dir?: 'asc' | 'desc';
    transaction_type?: 'income' | 'expense';
}): Promise<TransactionsListResponse> {
    const res = await requestWithQuery<TransactionsListResponse>('/api/transactions', params);
    return {
        ...res,
        items: res.items.map((tx) => {
            const raw = tx as Transaction & { date?: string };
            return {
                ...tx,
                transaction_date: raw.transaction_date ?? raw.date ?? '',
            };
        }),
    };
}

export function getTransaction(id: number): Promise<Transaction> {
    return apiRequest<Transaction>(`/api/transactions/${id}`);
}

export function createTransaction(transaction: TransactionCreate): Promise<Transaction> {
    return apiRequest<Transaction>('/api/transactions', {
        method: 'POST',
        body: JSON.stringify(transaction),
    });
}

export function updateTransaction(id: number, transaction: TransactionUpdate): Promise<Transaction> {
    return apiRequest<Transaction>(`/api/transactions/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(transaction),
    });
}

export async function deleteTransaction(id: number): Promise<void> {
    await apiRequest<void>(`/api/transactions/${id}`, { method: 'DELETE' });
}
