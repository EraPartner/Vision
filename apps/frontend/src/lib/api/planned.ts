import type {
    PlannedTransaction,
    PlannedTransactionCreate,
    PlannedTransactionsListResponse,
    PlannedTransactionUpdate,
    PlannedTransactionExecuteRequest,
} from "@/types/api";
import {
    PlannedMatchSuggestionListSchema,
    PlannedTotalsSchema,
    PlannedTransactionListSchema,
    PlannedTransactionSchema,
} from "@vision/types/contracts";
import type { PlannedTotals } from "@vision/types/contracts";
import { apiRequest } from "@/lib/api/client";
import { requestWithQuery } from "@/lib/api/helpers";
import type {
    AccountId,
    CategoryId,
    CurrencyCode,
    PlannedTransactionId,
    RecipientId,
    TransactionId,
} from "@vision/types/brands";

export function getPlannedTransactions(params?: {
    limit?: number | undefined;
    offset?: number | undefined;
    start_date?: string | undefined;
    end_date?: string | undefined;
    bank_account?: string | undefined;
    account_id?: AccountId | undefined;
    category_id?: CategoryId | undefined;
    recipient_id?: RecipientId | undefined;
    is_recurring?: boolean | undefined;
    is_executed?: boolean | undefined;
    active?: boolean | undefined;
    search?: string | undefined;
}): Promise<PlannedTransactionsListResponse> {
    return requestWithQuery<PlannedTransactionsListResponse>(
        "/api/planned-transactions",
        params,
        { schema: PlannedTransactionListSchema },
    );
}

export function createPlannedTransaction(
    transaction: PlannedTransactionCreate,
): Promise<PlannedTransaction> {
    return apiRequest<PlannedTransaction>("/api/planned-transactions", {
        method: "POST",
        body: JSON.stringify(transaction),
        schema: PlannedTransactionSchema,
    });
}

export function updatePlannedTransaction(
    id: PlannedTransactionId,
    transaction: PlannedTransactionUpdate,
): Promise<PlannedTransaction> {
    return apiRequest<PlannedTransaction>(`/api/planned-transactions/${id}`, {
        method: "PATCH",
        body: JSON.stringify(transaction),
        schema: PlannedTransactionSchema,
    });
}

export async function deletePlannedTransaction(id: PlannedTransactionId): Promise<void> {
    await apiRequest<void>(`/api/planned-transactions/${id}`, {
        method: "DELETE",
    });
}

export function executePlannedTransaction(
    id: PlannedTransactionId,
    executeRequest: PlannedTransactionExecuteRequest,
): Promise<PlannedTransaction> {
    return apiRequest<PlannedTransaction>(
        `/api/planned-transactions/${id}/execute`,
        {
            method: "POST",
            body: JSON.stringify(executeRequest),
            schema: PlannedTransactionSchema,
        },
    );
}

export interface PlannedMatchCandidate {
    id: TransactionId;
    recipient_name: string | null;
    amount: number;
    transaction_date: string;
    currency: CurrencyCode | null;
    memo: string | null;
}

export interface PlannedMatchSuggestion {
    planned: {
        id: PlannedTransactionId;
        recipient_id: RecipientId | null;
        recipient_name: string | null;
        amount: number;
        planned_date: string;
        currency: CurrencyCode | null;
        is_recurring: boolean;
    };
    candidates: PlannedMatchCandidate[];
}

/**
 * Planned payments with recent unlinked transactions within match tolerance
 * that were not auto-cleared (ambiguous matches, or auto-clear disabled).
 * Canonical `{items, total}` collection body — callers only need the rows.
 */
export async function getPlannedMatchSuggestions(): Promise<
    PlannedMatchSuggestion[]
> {
    const { items } = await apiRequest<{
        items: PlannedMatchSuggestion[];
        total: number;
    }>("/api/planned-transactions/match-suggestions", {
        schema: PlannedMatchSuggestionListSchema,
    });
    return items;
}

export type { PlannedTotals };

/**
 * Rest-of-month and monthly-equivalent planned totals, computed and converted
 * to `currency` on the server.
 */
export function getPlannedTotals(currency: CurrencyCode): Promise<PlannedTotals> {
    return requestWithQuery<PlannedTotals>(
        "/api/planned-transactions/totals",
        { currency },
        { schema: PlannedTotalsSchema },
    );
}
