import logger from '@/lib/logger';
import { apiRequest } from '@/lib/api/client';
import { requestWithQuery } from '@/lib/api/helpers';
import type { NetWorthResponse } from '@/types/apiClient';

// (Removed getStatistics — legacy GET /api/info was deleted in the Phase 9
// cutover; it had no callers. Use the aggregations endpoints instead.)

export interface SupportedAdapter {
    key: string;
    name: string;
    adapter_class?: string;
}

/** Canonical `{items, total}` collection body — callers only need the rows. */
export async function getSupportedParsers(): Promise<SupportedAdapter[]> {
    const { items } = await apiRequest<{ items: SupportedAdapter[]; total: number }>(
        '/api/info/supported-adapters',
    );
    return items;
}

/** Canonical `{items, total}` collection body — callers only need the rows. */
export async function getDistinctBankAccounts(): Promise<string[]> {
    const { items } = await apiRequest<{ items: string[]; total: number }>('/api/info/banks');
    return items;
}

// (Removed getTransactionSummary — legacy GET /api/info/transaction-summary was
// deleted in the Phase 9 cutover; it had no callers.)

export function getTransactionCount(): Promise<{ total_transactions: number }> {
    return apiRequest('/api/info/transaction-count');
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

/** New-subscription finding from the subscription-creep detector. */
export interface SubscriptionCreepNew {
    recipientId: number;
    recipientName: string;
    findingType: 'new';
    latestAmount: number;
    currency: string;
    detectedPattern: string;
    intervalDays: number;
    predictedNext: string;
    confidence: number;
}

/** Price-change finding from the subscription-creep detector. */
export interface SubscriptionCreepPriceChange {
    recipientId: number;
    recipientName: string;
    findingType: 'priceChange';
    previousAmount: number;
    newAmount: number;
    percentChange: number;
    direction: string;
    currency: string;
    confidence: number;
}

/** Current-month category overspend outlier vs the trailing baseline median. */
export interface CategoryOutlier {
    categoryId: number;
    categoryName: string;
    monthKey: string;
    currentAmount: number;
    baselineMedian: number;
    deviation: number;
    direction: string;
}

/** Month-end cash forecast insight (null when no forecast is available). */
export interface CashForecast {
    month: string;
    currency: string;
    monthEndProjected: number;
    minProjected: number;
    monthEndLow: number;
    monthEndHigh: number;
    crossesZero: boolean;
    movedSignificantly: boolean;
    prominence: string;
    methodId: string;
}

export interface InsightsDigestResponse {
    subscriptionCreep: {
        new: SubscriptionCreepNew[];
        priceChanges: SubscriptionCreepPriceChange[];
    };
    categoryOutliers: CategoryOutlier[];
    cashForecast: CashForecast | null;
}

/** Pre-computed detection-layer findings for the Statistics insights panel (no LLM). */
export async function getInsightsDigest(): Promise<InsightsDigestResponse> {
    try {
        return await apiRequest('/api/info/insights-digest');
    } catch (err) {
        // Fail-soft: the insights digest is optional UI enrichment.
        logger.warn('Insights digest unavailable; using empty result', err);
        return {
            subscriptionCreep: { new: [], priceChanges: [] },
            categoryOutliers: [],
            cashForecast: null,
        };
    }
}

/** One user category contributing to a deduction-type candidate group. */
export interface DeductionCandidateCategory {
    category: string;
    total: number;
    count: number;
}

/** One Belgian deduction type with its transaction-derived candidate total. */
export interface DeductionTypeGroup {
    deductionType: string;
    total: number;
    categoryCount: number;
    /** Contributing categories, sorted by total desc. */
    categories: DeductionCandidateCategory[];
}

export interface DeductionCandidatesResponse {
    year: number;
    from: string;
    to: string;
    currency: string;
    /** Sorted by total desc; empty when nothing classifies. */
    byDeductionType: DeductionTypeGroup[];
}

/** Transaction-derived Belgian deduction candidates for the tax review card. */
export async function getDeductionCandidates(year: number): Promise<DeductionCandidatesResponse> {
    try {
        return await apiRequest('/api/info/deduction-candidates?year=' + year);
    } catch (err) {
        // Fail-soft: deduction candidates are optional UI enrichment.
        logger.warn('Deduction candidates unavailable; using empty result', err);
        return {
            year,
            from: `${year}-01-01`,
            to: `${year}-12-31`,
            currency: 'EUR',
            byDeductionType: [],
        };
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
