import { apiRequest } from '@/lib/api/client';
import { requestWithQuery, buildExclusionQuery } from '@/lib/api/helpers';
import type { AggregationEnvelope } from '@/lib/api/types';

export function getAggregationMonthlySummary(params?: {
    excluded_category_ids?: number[];
    excluded_recipient_ids?: number[];
    currency?: string;
}): Promise<AggregationEnvelope<{
    months: Array<{
        month: number;
        year: number;
        period_start: string;
        period_end: string;
        total_spending: number;
        total_income: number;
        net_amount: number;
        transaction_count: number;
    }>;
    summary: {
        total_spending: number;
        total_income: number;
        net_amount: number;
        transaction_count: number;
        period_start: string;
        period_end: string;
    };
}>> {
    const q = buildExclusionQuery(params);
    return apiRequest(`/api/aggregations/monthly-summary${q ? `?${q}` : ''}`);
}

export function getAggregationCategoryBreakdown(params?: {
    currency?: string;
}): Promise<AggregationEnvelope<{
    categories: Array<{ id: number | null; name: string; count: number; total: number }>;
}>> {
    return requestWithQuery('/api/aggregations/category-breakdown', params);
}

export function getAggregationRecipientInsights(params?: {
    currency?: string;
}): Promise<AggregationEnvelope<{
    topMerchants: Array<{
        recipientId: number;
        name: string;
        totalSpend: number;
        transactionCount: number;
        avgAmount: number;
        firstSeen: string;
        lastSeen: string;
    }>;
    monthOverMonth: Array<{
        recipientId: number;
        name: string;
        currentSpend: number;
        previousSpend: number;
        changePercent: number;
    }>;
}>> {
    return requestWithQuery('/api/aggregations/recipient-insights', params);
}

export function getAggregationCashflowComparison(params?: {
    excluded_category_ids?: number[];
    excluded_recipient_ids?: number[];
    currency?: string;
}): Promise<AggregationEnvelope<{
    days_in_month: number;
    current_day: number;
    month: number;
    year: number;
    without_planned: Array<{ day: number; average: number; current: number | null }>;
    with_planned: Array<{ day: number; average: number; current: number | null }>;
}>> {
    const q = buildExclusionQuery(params);
    return apiRequest(`/api/aggregations/cashflow-comparison${q ? `?${q}` : ''}`);
}

export function getAggregationAverageVsCurrent(params?: {
    currency?: string;
}): Promise<AggregationEnvelope<unknown>> {
    return requestWithQuery('/api/aggregations/average-vs-current', params);
}

export function getAggregationBankBalances(params?: {
    currency?: string;
}): Promise<AggregationEnvelope<{
    accounts: Array<{
        bank_account: string;
        balance: number;
        transaction_count: number;
        first_transaction: string;
        last_transaction: string;
    }>;
    total_net_position: number;
    history: Record<string, Array<{ month: string; balance: number }>>;
    total_history: Array<{ month: string; balance: number }>;
}>> {
    return requestWithQuery('/api/aggregations/bank-balances', params);
}
