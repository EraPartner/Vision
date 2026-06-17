import type {
    PlannedTransaction,
    PlannedTransactionCreate,
    PlannedTransactionsListResponse,
    PlannedTransactionUpdate,
    PlannedTransactionExecuteRequest,
} from '@/types/api';
import { apiRequest } from '@/lib/api/client';
import { requestWithQuery } from '@/lib/api/helpers';

export function getPlannedTransactions(params?: {
    limit?: number;
    offset?: number;
    start_date?: string;
    end_date?: string;
    bank_account?: string;
    category_id?: number;
    recipient_id?: number;
    is_recurring?: boolean;
    is_executed?: boolean;
    active?: boolean;
    search?: string;
}): Promise<PlannedTransactionsListResponse> {
    return requestWithQuery<PlannedTransactionsListResponse>('/api/planned-transactions', params);
}

export function getPlannedTransaction(id: number): Promise<PlannedTransaction> {
    return apiRequest<PlannedTransaction>(`/api/planned-transactions/${id}`);
}

export function createPlannedTransaction(
    transaction: PlannedTransactionCreate,
): Promise<PlannedTransaction> {
    return apiRequest<PlannedTransaction>('/api/planned-transactions', {
        method: 'POST',
        body: JSON.stringify(transaction),
    });
}

export function updatePlannedTransaction(
    id: number,
    transaction: PlannedTransactionUpdate,
): Promise<PlannedTransaction> {
    return apiRequest<PlannedTransaction>(`/api/planned-transactions/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(transaction),
    });
}

export async function deletePlannedTransaction(id: number): Promise<void> {
    await apiRequest<void>(`/api/planned-transactions/${id}`, { method: 'DELETE' });
}

export function executePlannedTransaction(
    id: number,
    executeRequest: PlannedTransactionExecuteRequest,
): Promise<PlannedTransaction> {
    return apiRequest<PlannedTransaction>(`/api/planned-transactions/${id}/execute`, {
        method: 'POST',
        body: JSON.stringify(executeRequest),
    });
}

export interface PlannedMatchCandidate {
    id: number;
    recipient_name: string | null;
    amount: number;
    transaction_date: string;
    currency: string | null;
    memo: string | null;
}

export interface PlannedMatchSuggestion {
    planned: {
        id: number;
        recipient_id: number | null;
        recipient_name: string | null;
        amount: number;
        planned_date: string;
        currency: string | null;
        is_recurring: boolean;
    };
    candidates: PlannedMatchCandidate[];
}

/**
 * Planned payments with recent unlinked transactions within match tolerance
 * that were not auto-cleared (ambiguous matches, or auto-clear disabled).
 */
export function getPlannedMatchSuggestions(): Promise<PlannedMatchSuggestion[]> {
    return apiRequest<PlannedMatchSuggestion[]>('/api/planned-transactions/match-suggestions');
}
