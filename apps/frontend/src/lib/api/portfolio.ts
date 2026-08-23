import type {
    Investment,
    InvestmentCreate,
    InvestmentUpdate,
    InvestmentsListResponse,
    PortfolioTransaction,
    PortfolioTransactionCreate,
    PortfolioTransactionsListResponse,
} from '@/types/api';
import { apiRequest } from '@/lib/api/client';
import { requestWithQuery } from '@/lib/api/helpers';

export function getInvestments(params?: {
    limit?: number;
    offset?: number;
    asset_class?: string;
    active?: boolean;
}): Promise<InvestmentsListResponse> {
    return requestWithQuery<InvestmentsListResponse>('/api/investments', params);
}

export function createInvestment(data: InvestmentCreate): Promise<Investment> {
    return apiRequest<Investment>('/api/investments', { method: 'POST', body: JSON.stringify(data) });
}

export type PriceSource = 'live' | 'close' | 'cached' | 'historical_fallback';

export interface SupportedPriceProvider {
    key: string;
    name: string;
    description: string;
}

export async function getSupportedPriceProviders(): Promise<SupportedPriceProvider[]> {
    const { providers } = await apiRequest<{ providers: SupportedPriceProvider[] }>(
        '/api/investments/providers',
    );
    return providers;
}

export function refreshInvestmentPrices(): Promise<{
    updated: number;
    total: number;
    prices: Record<string, number>;
    priceSources: Record<string, PriceSource>;
}> {
    return apiRequest('/api/investments/refresh-prices', { method: 'POST' });
}

export function updateInvestment(id: number, data: InvestmentUpdate): Promise<Investment> {
    return apiRequest<Investment>(`/api/investments/${id}`, { method: 'PATCH', body: JSON.stringify(data) });
}

export async function deleteInvestment(id: number): Promise<void> {
    await apiRequest<void>(`/api/investments/${id}`, { method: 'DELETE' });
}

export function getInvestmentPriceHistory(
    investmentId: number,
    params?: { from_ms?: number; to_ms?: number; db_only?: boolean },
): Promise<{ investment_id: number; provider: string; points: Array<{ timestampMs: number; price: number }> }> {
    return requestWithQuery(`/api/investments/${investmentId}/price-history`, params);
}

export async function getPortfolioTransactions(
    investmentId: number,
    params?: { type?: string; limit?: number; offset?: number },
): Promise<PortfolioTransactionsListResponse> {
    const res = await requestWithQuery<PortfolioTransactionsListResponse>(
        `/api/investments/${investmentId}/transactions`,
        params,
    );
    return {
        ...res,
        items: res.items.map((tx) => {
            const raw = tx as PortfolioTransaction & { transaction_date?: string };
            return { ...tx, date: raw.date ?? raw.transaction_date ?? '' };
        }),
    };
}

export async function getPortfolioTransactionsBulk(params: {
    investment_ids: string;
    type?: string;
    per_investment_limit?: number;
    limit?: number;
    offset?: number;
}): Promise<PortfolioTransactionsListResponse> {
    const res = await requestWithQuery<PortfolioTransactionsListResponse>(
        '/api/investments/transactions',
        params,
    );
    return {
        ...res,
        items: res.items.map((tx) => {
            const raw = tx as PortfolioTransaction & { transaction_date?: string };
            return { ...tx, date: raw.date ?? raw.transaction_date ?? '' };
        }),
    };
}

export function createPortfolioTransaction(
    investmentId: number,
    data: PortfolioTransactionCreate,
): Promise<PortfolioTransaction> {
    return apiRequest<PortfolioTransaction>(`/api/investments/${investmentId}/transactions`, {
        method: 'POST',
        body: JSON.stringify(data),
    });
}

export function updatePortfolioTransaction(
    txnId: number,
    data: Partial<PortfolioTransactionCreate>,
): Promise<PortfolioTransaction> {
    return apiRequest<PortfolioTransaction>(`/api/investments/transactions/${txnId}`, {
        method: 'PATCH',
        body: JSON.stringify(data),
    });
}

export async function deletePortfolioTransaction(txnId: number): Promise<void> {
    await apiRequest<void>(`/api/investments/transactions/${txnId}`, { method: 'DELETE' });
}
