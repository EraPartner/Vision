import type {
    BulkDeleteResult,
    BulkExportRequest,
    BulkExportResult,
    BulkSelectionRequest,
    BulkUpdateRequest,
    BulkUpdateResult,
    Transaction,
    TransactionCreate,
    TransactionsListResponse,
    TransactionUpdate,
} from "@/types/api";
import { apiRequest } from "@/lib/api/client";
import { requestBlobWithResponse } from "@/lib/api/helpers";
import { requestWithQuery } from "@/lib/api/helpers";

export async function getTransactions(
    params?: {
        transaction_id?: number;
        limit?: number;
        offset?: number;
        start_date?: string;
        end_date?: string;
        /** Preferred account filter (exact FK match, ADR-088); bank_account is the legacy substring escape hatch. */
        account_id?: number;
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
        sort_dir?: "asc" | "desc";
        /** Adds a per-account `running_balance` to each row (SQL window, ADR-088 partition). First consumer: the /accounts/:id ledger (WP-B4). */
        include_balance?: boolean;
        transaction_type?: "income" | "expense";
        amount_min?: number;
        amount_max?: number;
        amount_signed?: boolean;
        tags?: string;
    },
    signal?: AbortSignal,
): Promise<TransactionsListResponse> {
    const res = await requestWithQuery<TransactionsListResponse>(
        "/api/transactions",
        { ...params, category_ids: params?.category_ids?.join(",") },
        signal,
    );
    return {
        ...res,
        items: res.items.map((tx) => {
            const raw = tx as Transaction & { date?: string };
            return {
                ...tx,
                transaction_date: raw.transaction_date ?? raw.date ?? "",
            };
        }),
    };
}

export function createTransaction(
    transaction: TransactionCreate,
): Promise<Transaction> {
    return apiRequest<Transaction>("/api/transactions", {
        method: "POST",
        body: JSON.stringify(transaction),
    });
}

export function updateTransaction(
    id: number,
    transaction: TransactionUpdate,
): Promise<Transaction> {
    return apiRequest<Transaction>(`/api/transactions/${id}`, {
        method: "PATCH",
        body: JSON.stringify(transaction),
    });
}

export async function deleteTransaction(id: number): Promise<void> {
    await apiRequest<void>(`/api/transactions/${id}`, { method: "DELETE" });
}

export function bulkDeleteTransactions(
    request: BulkSelectionRequest,
): Promise<BulkDeleteResult> {
    return apiRequest<BulkDeleteResult>("/api/transactions/bulk-delete", {
        method: "POST",
        body: JSON.stringify(request),
    });
}

export function bulkUpdateTransactions(
    request: BulkUpdateRequest,
): Promise<BulkUpdateResult> {
    return apiRequest<BulkUpdateResult>("/api/transactions/bulk-update", {
        method: "POST",
        body: JSON.stringify(request),
    });
}

/**
 * Streams a bulk export to the browser as a `Blob`. Uses `requestBlob` (shared
 * tracked transport) rather than `apiRequest` because the response is a
 * binary/text stream rather than the standard JSON envelope.
 */
export async function bulkExportTransactions(
    request: BulkExportRequest,
): Promise<BulkExportResult> {
    const { blob, response } = await requestBlobWithResponse(
        "/api/transactions/bulk-export",
        {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(request),
        },
    );
    const rawCount = response.headers.get("X-Exported-Count");
    const exported = rawCount == null ? Number.NaN : Number(rawCount);
    return {
        blob,
        exported:
            Number.isSafeInteger(exported) && exported >= 0
                ? exported
                : "ids" in request && request.ids
                  ? request.ids.length
                  : 0,
    };
}
