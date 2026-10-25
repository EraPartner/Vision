import type {
    Investment,
    InvestmentCreate,
    InvestmentUpdate,
    InvestmentsListResponse,
    AssetClass,
    PortfolioTransaction,
    PortfolioTransactionCreate,
    PortfolioTransactionUpdate,
    PortfolioBrokerRetagRequest,
    PortfolioBrokerRetagReceipt,
    PortfolioTransactionsListResponse,
} from "@/types/api";
import { apiRequest } from "@/lib/api/client";
import { requestWithQuery } from "@/lib/api/helpers";
import { z } from "zod";
import { PORTFOLIO_INCOME_RECOGNITION_ROLES } from "@vision/types/portfolioTxnTypes";
import {
    InvestmentListSchema,
    InvestmentPriceHistorySchema,
    InvestmentSchema,
    PortfolioBrokerRetagReceiptSchema,
    PortfolioTransactionListSchema,
    PortfolioTransactionSchema,
    PriceProviderListSchema,
    RefreshPricesResultSchema,
} from "@vision/types/contracts";
import type {
    InvestmentId,
    PortfolioTransactionId,
} from "@vision/types/brands";

const incomeRoleSchema = z
    .enum(PORTFOLIO_INCOME_RECOGNITION_ROLES)
    .default("standard");

function verifiedPortfolioTransaction(
    tx: PortfolioTransaction,
): PortfolioTransaction {
    const role = incomeRoleSchema.safeParse(tx.income_recognition_role);
    if (
        !role.success ||
        (role.data === "included_in_units" && tx.type !== "dividend")
    ) {
        const error = new Error("Unverified portfolio income recognition role");
        error.name = "PortfolioResponseError";
        throw error;
    }
    const raw = tx as PortfolioTransaction & { transaction_date?: string };
    return {
        ...tx,
        date: raw.date ?? raw.transaction_date ?? "",
        income_recognition_role: role.data,
    };
}

function rejectManualIncomeRole(
    data: PortfolioTransactionCreate | PortfolioTransactionUpdate,
) {
    if (Object.hasOwn(data, "income_recognition_role"))
        throw new Error("Portfolio income recognition role is read-only");
}

export function getInvestments(
    params?: {
        limit?: number | undefined;
        offset?: number | undefined;
        asset_class?: AssetClass | undefined;
        active?: boolean | undefined;
    },
    signal?: AbortSignal,
): Promise<InvestmentsListResponse> {
    return requestWithQuery<InvestmentsListResponse>(
        "/api/investments",
        params,
        { schema: InvestmentListSchema, ...(signal ? { signal } : {}) },
    );
}

export function createInvestment(data: InvestmentCreate): Promise<Investment> {
    return apiRequest<Investment>("/api/investments", {
        method: "POST",
        body: JSON.stringify(data),
        schema: InvestmentSchema,
    });
}

export type PriceSource = "live" | "close" | "cached" | "historical_fallback";

export interface SupportedPriceProvider {
    key: string;
    name: string;
    description: string;
}

export async function getSupportedPriceProviders(): Promise<
    SupportedPriceProvider[]
> {
    const { providers } = await apiRequest<{
        providers: SupportedPriceProvider[];
    }>("/api/investments/providers", { schema: PriceProviderListSchema });
    return providers;
}

/**
 * With no live-priced holding the route answers only `{ updated: 0, message }`;
 * otherwise the counts and per-investment maps (a provider may answer null).
 */
export function refreshInvestmentPrices(): Promise<{
    updated: number;
    message?: string;
    total?: number;
    prices?: Record<string, number | null>;
    priceSources?: Record<string, PriceSource>;
}> {
    return apiRequest("/api/investments/refresh-prices", {
        method: "POST",
        schema: RefreshPricesResultSchema,
    });
}

export function updateInvestment(
    id: InvestmentId,
    data: InvestmentUpdate,
): Promise<Investment> {
    return apiRequest<Investment>(`/api/investments/${id}`, {
        method: "PATCH",
        body: JSON.stringify(data),
        schema: InvestmentSchema,
    });
}

export async function deleteInvestment(id: InvestmentId): Promise<void> {
    await apiRequest<void>(`/api/investments/${id}`, { method: "DELETE" });
}

export function getInvestmentPriceHistory(
    investmentId: InvestmentId,
    params?: { from_ms?: number; to_ms?: number; db_only?: boolean },
): Promise<{
    investment_id: InvestmentId;
    provider: string;
    points: Array<{ timestampMs: number; price: number }>;
}> {
    return requestWithQuery(
        `/api/investments/${investmentId}/price-history`,
        params,
        { schema: InvestmentPriceHistorySchema },
    );
}

export async function getPortfolioTransactions(
    investmentId: InvestmentId,
    params?: { type?: string; limit?: number; offset?: number },
    signal?: AbortSignal,
): Promise<PortfolioTransactionsListResponse> {
    const res = await requestWithQuery<PortfolioTransactionsListResponse>(
        `/api/investments/${investmentId}/transactions`,
        params,
        {
            schema: PortfolioTransactionListSchema,
            ...(signal ? { signal } : {}),
        },
    );
    return {
        ...res,
        items: res.items.map(verifiedPortfolioTransaction),
    };
}

export async function getPortfolioTransactionsBulk(
    params: {
        investment_ids: string;
        type?: string | undefined;
        per_investment_limit?: number | undefined;
        limit?: number | undefined;
        offset?: number | undefined;
    },
    signal?: AbortSignal,
): Promise<PortfolioTransactionsListResponse> {
    const res = await requestWithQuery<PortfolioTransactionsListResponse>(
        "/api/investments/transactions",
        params,
        {
            schema: PortfolioTransactionListSchema,
            ...(signal ? { signal } : {}),
        },
    );
    return {
        ...res,
        items: res.items.map(verifiedPortfolioTransaction),
    };
}

export async function createPortfolioTransaction(
    investmentId: InvestmentId,
    data: PortfolioTransactionCreate,
): Promise<PortfolioTransaction> {
    rejectManualIncomeRole(data);
    return verifiedPortfolioTransaction(
        await apiRequest<PortfolioTransaction>(
            `/api/investments/${investmentId}/transactions`,
            {
                method: "POST",
                body: JSON.stringify(data),
                schema: PortfolioTransactionSchema,
            },
        ),
    );
}

export async function updatePortfolioTransaction(
    txnId: PortfolioTransactionId,
    data: PortfolioTransactionUpdate,
): Promise<PortfolioTransaction> {
    rejectManualIncomeRole(data);
    return verifiedPortfolioTransaction(
        await apiRequest<PortfolioTransaction>(
            `/api/investments/transactions/${txnId}`,
            {
                method: "PATCH",
                body: JSON.stringify(data),
                schema: PortfolioTransactionSchema,
            },
        ),
    );
}

export async function deletePortfolioTransaction(txnId: PortfolioTransactionId): Promise<void> {
    await apiRequest<void>(`/api/investments/transactions/${txnId}`, {
        method: "DELETE",
    });
}

/**
 * Lots the re-tag left on the destination. A replay writes nothing, so its
 * changed_count is 0 although every selected lot was moved by the earlier
 * identical attempt.
 */
export function retagMovedCount(receipt: PortfolioBrokerRetagReceipt): number {
    return receipt.replayed ? receipt.selected_count : receipt.changed_count;
}

export function bulkRetagPortfolioTransactions(
    data: PortfolioBrokerRetagRequest,
): Promise<PortfolioBrokerRetagReceipt> {
    return apiRequest<PortfolioBrokerRetagReceipt>(
        "/api/investments/transactions/broker",
        {
            method: "PUT",
            body: JSON.stringify(data),
            schema: PortfolioBrokerRetagReceiptSchema,
        },
    );
}
