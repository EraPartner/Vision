import logger from '@/lib/logger';
import { apiRequest } from '@/lib/api/client';
import { requestWithQuery } from '@/lib/api/helpers';
import type { NetWorthResponse } from '@/lib/api/types';

export async function getStatistics(params?: { currency?: string }): Promise<{
    total_transactions: number;
    total_amount: number;
    categories: Array<{ name: string; count: number }>;
}> {
    return requestWithQuery('/api/info', params);
}

export function getSupportedParsers(): Promise<{
    adapters: Array<{ key: string; name: string; adapter_class: string }>;
    total_count: number;
}> {
    return apiRequest('/api/info/supported-adapters');
}

/** @deprecated Use getSupportedParsers instead */
export async function getBanks(): Promise<{ banks: string[] }> {
    const data = await getSupportedParsers();
    return { banks: data.adapters.map((a) => a.key) };
}

export function getDistinctBankAccounts(): Promise<{ banks: string[] }> {
    return apiRequest('/api/info/banks');
}

export function getTransactionSummary(params?: {
    bank_account?: string;
    start_date?: string;
    end_date?: string;
    currency?: string;
}): Promise<{
    total_count: number;
    total_amount: number;
    average: number;
    min: number | null;
    max: number | null;
}> {
    return requestWithQuery('/api/info/transaction-summary', params);
}

export function getTransactionCount(): Promise<{ total_transactions: number }> {
    return apiRequest('/api/info/transaction-count');
}

export function getBelgianInflationRates(params?: {
    start_month?: string;
    end_month?: string;
    db_only?: boolean;
}): Promise<{
    source: 'memory' | 'database' | 'statbel' | 'eurostat';
    total_rates: number;
    rates: Array<{ month: string; monthly_rate: number }>;
}> {
    return requestWithQuery('/api/info/inflation-rates', params);
}

export async function getRecurringPatterns(): Promise<{
    patterns: Array<{
        recipientId: number;
        recipientName: string;
        detectedPattern: string;
        intervalDays: number;
        consistency: number;
        occurrences: number;
        averageAmount: number;
        latestAmount: number;
        currency: string;
        categoryId: number | null;
        categoryName: string | null;
        bankAccount: string | null;
        firstSeen: string;
        lastSeen: string;
        predictedNext: string;
        amountChanges: Array<{
            date: string;
            previousAmount: number;
            newAmount: number;
            percentChange: number;
            direction: string;
        }>;
        isAlreadyPlanned: boolean;
        confidence: number;
    }>;
    total: number;
}> {
    try {
        return await apiRequest('/api/info/recurring-patterns');
    } catch (err) {
        // Fail-soft: recurrence detection is optional UI enrichment.
        logger.warn('Recurring patterns unavailable; using empty result', err);
        return { patterns: [], total: 0 };
    }
}

export function getPortfolioPerformance(params?: {
    currency?: string;
    period?: string;
}): Promise<{
    currency: string;
    start_date: string;
    end_date: string;
    snapshots: Array<{
        date: string;
        invested: number;
        value: number;
        stocks_etfs_value: number;
        crypto_value: number;
        metals_value: number;
        stocks_etfs_invested: number;
        crypto_invested: number;
        metals_invested: number;
        inflation_adjusted_value: number;
        gain_loss: number;
        return_pct: number;
    }>;
    metrics: {
        currentValue: number;
        totalInvested: number;
        totalGainLoss: number;
        totalReturnPct: number;
        annualizedReturn: number;
        realReturnPct: number;
        cumulativeInflation: number;
    } | null;
    heatmap: {
        years: number[];
        data: Record<number, (number | null)[]>;
        maxAbsPct: number;
    };
    breakdownSummary: Array<{
        id: number;
        name: string;
        symbol: string;
        assetClass: string;
        currency: string;
        currentValue: number;
        totalInvested: number;
        gainLoss: number;
        gainLossPercent: number;
    }>;
}> {
    return requestWithQuery('/api/info/portfolio-performance', params);
}

export function getNetWorth(params?: {
    currency?: string;
    limit?: number;
    offset?: number;
}): Promise<NetWorthResponse> {
    return requestWithQuery('/api/info/net-worth', params);
}

export function refreshMaterializedViews(): Promise<{ message: string; duration_ms: number }> {
    return apiRequest('/api/info/refresh-views', { method: 'POST' });
}

export interface ExchangeRate {
    currency: string;
    rate_to_eur: number;
    rate_date: string;
    fetched_at: string;
}

export interface ExchangeRatesData {
    total_rates: number;
    rates: ExchangeRate[];
    fallback_rates: Record<string, number>;
    source?: 'database' | 'fallback';
    is_stale?: boolean;
    last_fetched_at?: string | null;
}

export function getExchangeRates(options: { dbOnly?: boolean } = {}): Promise<ExchangeRatesData> {
    const qs = options.dbOnly ? '?db_only=true' : '';
    return apiRequest(`/api/info/exchange-rates${qs}`);
}

export function refreshExchangeRates(): Promise<{ message: string }> {
    return apiRequest('/api/info/exchange-rates/refresh', { method: 'POST' });
}
