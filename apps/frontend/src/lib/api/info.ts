import logger from '@/lib/logger';
import { apiRequest } from '@/lib/api/client';
import { requestWithQuery } from '@/lib/api/helpers';
import type { NetWorthResponse } from '@/lib/api/types';

// (Removed getStatistics — legacy GET /api/info was deleted in the Phase 9
// cutover; it had no callers. Use the aggregations endpoints instead.)

export function getSupportedParsers(): Promise<{
    adapters: Array<{ key: string; name: string; adapter_class?: string }>;
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

// (Removed getTransactionSummary — legacy GET /api/info/transaction-summary was
// deleted in the Phase 9 cutover; it had no callers.)

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
        /** Flow direction — a recipient can yield one pattern per direction. */
        direction: 'income' | 'expense';
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
        /** Value at cost-weighted purchase-date FX rates. Absent until migration 0039 + a snapshot recompute. */
        value_fx_neutral?: number;
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
        assetGain?: number;
        fxGain?: number;
        nativeCurrentValue?: number;
        usedFallbackRate?: boolean;
    }>;
    totals?: PortfolioSummaryTotals;
}> {
    return requestWithQuery('/api/info/portfolio-performance', params);
}

export interface PortfolioSummaryTotals {
    totalPortfolioValue: number;
    totalInvested: number;
    totalGainLoss: number;
    totalRealizedGain: number;
    totalUnrealizedGain: number;
    totalGain: number;
    totalIncome: number;
    totalFees: number;
    totalTaxes: number;
    /** Portion of totalGainLoss from native asset performance (at today's rates). */
    totalAssetGain: number;
    /** Portion of totalGainLoss from currency moves (totalGainLoss − totalAssetGain). */
    totalFxGain: number;
    totalReturnPct: number;
    /** True when some historical FX rate was missing and today's rate was used instead. */
    usedFallbackRate: boolean;
}

export interface PortfolioSummaryItem {
    id: number;
    name: string;
    symbol?: string;
    asset_class: string;
    assetClass: string;
    is_active: boolean;
    created_at: string;
    updated_at: string;
    description?: string;
    notes?: string;
    location?: string;
    municipality?: string;
    cadastral_income?: number;
    municipality_tax_rate?: number;
    maturity_date?: string;
    maturityDate?: string;
    price_provider?: string;
    price_provider_id?: string;
    price_updated_at?: string;
    /** Display currency — every monetary field on this object is in this currency. */
    currency: string;
    /** The investment's native currency (for label display only). */
    originalCurrency: string;
    totalUnits: number;
    currentPrice: number;
    current_price: number;
    interestRate: number;
    interest_rate: number;
    totalInvested: number;
    totalBuyCost: number;
    totalSellProceeds: number;
    currentValue: number;
    totalFees: number;
    totalTaxes: number;
    totalDividends: number;
    totalIncome: number;
    avgCostBasis: number;
    realizedGain: number;
    unrealizedGain: number;
    totalGain: number;
    gainLoss: number;
    gainLossPercent: number;
    /** gainLoss = assetGain (native performance at today's rate) + fxGain (currency effect). */
    assetGain: number;
    fxGain: number;
    /** Current value in the investment's own currency, untouched by FX. */
    nativeCurrentValue: number;
    /** True when a historical FX rate was missing and today's rate was used instead. */
    usedFallbackRate: boolean;
    accruedInterest: number;
    projectedAnnualInterest: number;
    totalAppreciation: number;
}

export interface PortfolioSummaryResponse {
    currency: string;
    computed_at: string;
    totals: PortfolioSummaryTotals;
    summaries: PortfolioSummaryItem[];
}

export function getPortfolioSummary(params?: { currency?: string }): Promise<PortfolioSummaryResponse> {
    return requestWithQuery('/api/info/portfolio-summary', params);
}

export function getNetWorth(params?: {
    currency?: string;
    limit?: number;
    offset?: number;
}): Promise<NetWorthResponse> {
    return requestWithQuery('/api/info/net-worth', params);
}

/** Net worth as Σ accounts (ADR-100): per-account current cash + holdings and the rebuilt daily holdings history. */
export interface NetWorthByAccountRow {
    accountId: number | null;
    name: string | null;
    currency: string;
    cash: number;
    currentHoldings: number;
    currentTotal: number;
    holdingsSeries: { date: string; holdings: number }[];
}
export interface NetWorthByAccountResponse {
    currency: string;
    accounts: NetWorthByAccountRow[];
}
export function getNetWorthByAccount(params?: { currency?: string }): Promise<NetWorthByAccountResponse> {
    return requestWithQuery('/api/info/net-worth/by-account', params);
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
