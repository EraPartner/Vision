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
import {
    BulkDeleteResultSchema,
    BulkUpdateResultSchema,
    TransactionCreatedSchema,
    TransactionListSchema,
} from "@vision/types/contracts";
import { apiRequest, checkResponseContract } from "@/lib/api/client";
import { requestBlobWithResponse } from "@/lib/api/helpers";
import { requestWithQuery } from "@/lib/api/helpers";
import type {
    AccountId,
    CategoryId,
    CurrencyCode,
    RecipientId,
    TransactionId,
} from "@vision/types/brands";

export async function getTransactions(
    params?: {
        transaction_id?: TransactionId | undefined;
        limit?: number | undefined;
        offset?: number | undefined;
        start_date?: string | undefined;
        end_date?: string | undefined;
        /** Preferred account filter (exact FK match, ADR-088); bank_account is the legacy substring escape hatch. */
        account_id?: AccountId | undefined;
        bank_account?: string | undefined;
        category_id?: CategoryId | undefined;
        category_ids?: CategoryId[] | undefined;
        recipient_id?: RecipientId | undefined;
        recipient_group_id?: RecipientId | undefined;
        recipient_name?: string | undefined;
        uncategorised?: boolean | undefined;
        active?: boolean | undefined;
        search?: string | undefined;
        normalize_to_eur?: boolean | undefined;
        target_currency?: CurrencyCode | undefined;
        sort_by?: string | undefined;
        sort_dir?: "asc" | "desc" | undefined;
        /** Adds a per-account, per-currency `running_balance` to each row. */
        include_balance?: boolean | undefined;
        transaction_type?: "income" | "expense" | undefined;
        amount_min?: number | undefined;
        amount_max?: number | undefined;
        amount_signed?: boolean | undefined;
        tags?: string | undefined;
    },
    signal?: AbortSignal,
): Promise<TransactionsListResponse> {
    const res = await requestWithQuery<TransactionsListResponse>(
        "/api/transactions",
        { ...params, category_ids: params?.category_ids?.join(",") },
        signal,
    );
    for (const [index, transaction] of res.items.entries()) {
        if (
            typeof transaction.transaction_date !== "string" ||
            transaction.transaction_date.length === 0
        ) {
            throw new Error(
                `Malformed transaction response: items[${index}].transaction_date must be a non-empty string`,
            );
        }
    }
    // After the transaction_date guard above, which blocks in every mode.
    checkResponseContract(TransactionListSchema, res, "GET /api/transactions");
    return {
        ...res,
        items: res.items,
    };
}

export function createTransaction(
    transaction: TransactionCreate,
): Promise<Transaction> {
    return apiRequest<Transaction>("/api/transactions", {
        method: "POST",
        body: JSON.stringify(transaction),
        schema: TransactionCreatedSchema,
    });
}

export function updateTransaction(
    id: TransactionId,
    transaction: TransactionUpdate,
): Promise<Transaction> {
    return apiRequest<Transaction>(`/api/transactions/${id}`, {
        method: "PATCH",
        body: JSON.stringify(transaction),
    });
}

/**
 * Marks two existing rows as the legs of one transfer (ADR transfers contract):
 * both must be active, on different accounts and of opposite sign.
 */
export function markTransfer(aId: TransactionId, bId: TransactionId): Promise<void> {
    return apiRequest("/api/transactions/transfers", {
        method: "POST",
        body: JSON.stringify({ aId, bId }),
    });
}

export async function deleteTransaction(id: TransactionId): Promise<void> {
    await apiRequest(`/api/transactions/${id}`, { method: "DELETE" });
}

export function bulkDeleteTransactions(
    request: BulkSelectionRequest,
): Promise<BulkDeleteResult> {
    return apiRequest<BulkDeleteResult>("/api/transactions/bulk-delete", {
        method: "POST",
        body: JSON.stringify(request),
        schema: BulkDeleteResultSchema,
    });
}

export function bulkUpdateTransactions(
    request: BulkUpdateRequest,
): Promise<BulkUpdateResult> {
    return apiRequest<BulkUpdateResult>("/api/transactions/bulk-update", {
        method: "POST",
        body: JSON.stringify(request),
        schema: BulkUpdateResultSchema,
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
                : (request.ids?.length ?? 0),
    };
}
