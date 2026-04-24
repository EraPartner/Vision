import { apiRequest } from '@/lib/api/client';
import { requestWithQuery, buildExclusionQuery } from '@/lib/api/helpers';
import type { AggregationEnvelope } from '@/lib/api/types';

export function getAggregationMonthlySummary(params?: {
    excluded_category_ids?: number[];
    excluded_recipient_ids?: number[];
    currency?: string;
    all_time?: boolean;
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
    const qp = new URLSearchParams();
    if (params?.currency) qp.set('currency', params.currency);
    if (params?.all_time) qp.set('all_time', 'true');
    if (params?.excluded_category_ids?.length) {
        params.excluded_category_ids.forEach((id) => qp.append('excluded_category_ids', String(id)));
    }
    if (params?.excluded_recipient_ids?.length) {
        params.excluded_recipient_ids.forEach((id) => qp.append('excluded_recipient_ids', String(id)));
    }
    const q = qp.toString();
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

export interface CategoryPivotItem {
    categoryId: number | null;
    categoryName: string;
    total: number;
    transactionCount: number;
}

export interface RecipientYearlySpending {
    recipientId: number;
    name: string;
    totalSpend: number;
    transactionCount: number;
}

export function getAggregationCategoryPivot(params?: {
    currency?: string;
    excluded_category_ids?: number[];
    excluded_recipient_ids?: number[];
}): Promise<AggregationEnvelope<{ categoryPivot: Record<string, CategoryPivotItem[]> }>> {
    const qp = new URLSearchParams();
    if (params?.currency) qp.set('currency', params.currency);
    if (params?.excluded_category_ids?.length) {
        params.excluded_category_ids.forEach((id) => qp.append('excluded_category_ids', String(id)));
    }
    if (params?.excluded_recipient_ids?.length) {
        params.excluded_recipient_ids.forEach((id) => qp.append('excluded_recipient_ids', String(id)));
    }
    const q = qp.toString();
    return apiRequest(`/api/aggregations/category-pivot${q ? `?${q}` : ''}`);
}

export function getAggregationRecipientByYear(params?: {
    currency?: string;
    excluded_recipient_ids?: number[];
}): Promise<AggregationEnvelope<{ recipientsByYear: Record<string, RecipientYearlySpending[]> }>> {
    const qp = new URLSearchParams();
    if (params?.currency) qp.set('currency', params.currency);
    if (params?.excluded_recipient_ids?.length) {
        params.excluded_recipient_ids.forEach((id) => qp.append('excluded_recipient_ids', String(id)));
    }
    const q = qp.toString();
    return apiRequest(`/api/aggregations/recipient-by-year${q ? `?${q}` : ''}`);
}

export interface SankeyNode {
    readonly id: string;
    readonly label: string;
    readonly value: number;
}

export interface SankeyLink {
    readonly source: string;
    readonly target: string;
    readonly value: number;
}

export interface SankeyFlowData {
    readonly nodes: SankeyNode[];
    readonly links: SankeyLink[];
    readonly year: number;
}

// ==================== Cash Flow Forecast Methods ====================

export interface ForecastDailyPoint {
    readonly date: string;
    readonly value: number;
}

/** Dynamic-percentile bands: keys are "p{N}" for each requested percentile. */
export type ForecastBands = Record<string, ForecastDailyPoint[]>;

export interface ForecastMethod {
    readonly id: string;
    readonly label: string;
    readonly daily: ForecastDailyPoint[];
    readonly cumulative: ForecastDailyPoint[];
    readonly bands: ForecastBands | null;
    readonly error: string | null;
}

export interface ForecastActualPoint {
    readonly date: string;
    readonly net: number | null;
    readonly cumulative: number | null;
}

export interface ForecastPlannedPoint {
    readonly date: string;
    readonly net: number;
}

export interface ForecastBacktestEntry {
    readonly method_id: string;
    readonly label: string;
    readonly mae: number;
    readonly rmse: number;
    readonly mape: number;
    readonly months: number;
    readonly per_month: ReadonlyArray<{
        readonly month: string;
        readonly mae: number;
        readonly rmse: number;
        readonly mape: number;
        readonly sample_days: number;
    }>;
}

export interface ForecastDiagnostics {
    readonly history_months: number;
    readonly backtest: ForecastBacktestEntry[];
}

export interface CashflowForecastMethodsData {
    readonly month: string;
    readonly currency: string;
    readonly days_in_month: number;
    readonly current_day: number;
    readonly actual: ForecastActualPoint[];
    readonly methods: ForecastMethod[];
    readonly planned: ForecastPlannedPoint[];
    readonly diagnostics: ForecastDiagnostics | null;
    readonly history_months: number;
    readonly include_planned: boolean;
}

export function getCashflowForecastMethods(params?: {
    currency?: string;
    excluded_category_ids?: number[];
    excluded_recipient_ids?: number[];
    history_months?: number;
    mc_paths?: number;
    mc_percentiles?: number[];
    include_planned?: boolean;
    include_backtest?: boolean;
}): Promise<AggregationEnvelope<CashflowForecastMethodsData>> {
    const qp = new URLSearchParams();
    if (params?.currency) qp.set('currency', params.currency);
    if (params?.history_months != null) qp.set('history_months', String(params.history_months));
    if (params?.mc_paths != null) qp.set('mc_paths', String(params.mc_paths));
    if (params?.mc_percentiles?.length) {
        params.mc_percentiles.forEach((p) => qp.append('mc_percentiles', String(p)));
    }
    if (params?.include_planned != null) qp.set('include_planned', params.include_planned ? 'true' : 'false');
    if (params?.include_backtest != null) qp.set('include_backtest', params.include_backtest ? 'true' : 'false');
    if (params?.excluded_category_ids?.length) {
        params.excluded_category_ids.forEach((id) => qp.append('excluded_category_ids', String(id)));
    }
    if (params?.excluded_recipient_ids?.length) {
        params.excluded_recipient_ids.forEach((id) => qp.append('excluded_recipient_ids', String(id)));
    }
    const q = qp.toString();
    return apiRequest(`/api/aggregations/cashflow-forecast-methods${q ? `?${q}` : ''}`);
}

export interface AccuracyHistoryPoint {
    readonly month: string;
    readonly mae: number;
    readonly rmse: number;
    readonly mape: number;
    readonly sample_days: number;
}

export interface AccuracyMethodEntry {
    readonly method_id: string;
    readonly as_of_month: string;
    readonly mae: number;
    readonly rmse: number;
    readonly mape: number;
    readonly sample_days: number;
    readonly history: AccuracyHistoryPoint[];
}

export interface CashflowForecastAccuracyData {
    readonly methods: AccuracyMethodEntry[];
    readonly limit_months: number;
}

export function getCashflowForecastAccuracy(params?: {
    limit_months?: number;
}): Promise<AggregationEnvelope<CashflowForecastAccuracyData>> {
    const qp = new URLSearchParams();
    if (params?.limit_months != null) qp.set('limit_months', String(params.limit_months));
    const q = qp.toString();
    return apiRequest(`/api/aggregations/cashflow-forecast-accuracy${q ? `?${q}` : ''}`);
}

export function getSankeyFlow(params?: {
    currency?: string;
    year?: number;
    excluded_category_ids?: number[];
    excluded_recipient_ids?: number[];
}): Promise<AggregationEnvelope<SankeyFlowData>> {
    const qp = new URLSearchParams();
    if (params?.currency) qp.set('currency', params.currency);
    if (params?.year != null) qp.set('year', String(params.year));
    if (params?.excluded_category_ids?.length) {
        params.excluded_category_ids.forEach((id) => qp.append('excluded_category_ids', String(id)));
    }
    if (params?.excluded_recipient_ids?.length) {
        params.excluded_recipient_ids.forEach((id) => qp.append('excluded_recipient_ids', String(id)));
    }
    const q = qp.toString();
    return apiRequest(`/api/aggregations/sankey${q ? `?${q}` : ''}`);
}
