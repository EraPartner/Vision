import { apiRequest } from "@/lib/api/client";
import { requestWithQuery, buildExclusionQuery } from "@/lib/api/helpers";
import {
    AverageVsCurrentSchema,
    BankBalancesSchema,
    CashflowForecastAccuracySchema,
    CashflowForecastMethodsSchema,
    CashflowForecastRollingSchema,
    CategoryPivotSchema,
    MonthlySummarySchema,
    RecipientByYearSchema,
    RecipientInsightsSchema,
    RecipientPivotSchema,
    SankeyFlowSchema,
    TagPivotSchema,
} from "@vision/types/contracts";
import type { AggregationEnvelope } from "@/types/apiClient";

export function getAggregationMonthlySummary(params?: {
    excluded_category_ids?: number[] | undefined;
    excluded_recipient_ids?: number[] | undefined;
    currency?: string | undefined;
    all_time?: boolean | undefined;
    start_date?: string | undefined;
    end_date?: string | undefined;
}): Promise<
    AggregationEnvelope<{
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
    }>
> {
    const qp = new URLSearchParams();
    if (params?.currency) qp.set("currency", params.currency);
    if (params?.all_time) qp.set("all_time", "true");
    if (params?.start_date) qp.set("start_date", params.start_date);
    if (params?.end_date) qp.set("end_date", params.end_date);
    if (params?.excluded_category_ids?.length) {
        params.excluded_category_ids.forEach((id) =>
            qp.append("excluded_category_ids", String(id)),
        );
    }
    if (params?.excluded_recipient_ids?.length) {
        params.excluded_recipient_ids.forEach((id) =>
            qp.append("excluded_recipient_ids", String(id)),
        );
    }
    const q = qp.toString();
    return apiRequest(`/api/aggregations/monthly-summary${q ? `?${q}` : ""}`, {
        schema: MonthlySummarySchema,
    });
}

export function getAggregationRecipientInsights(params?: {
    currency?: string | undefined;
    start_date?: string | undefined;
    end_date?: string | undefined;
    excluded_category_ids?: number[] | undefined;
    excluded_recipient_ids?: number[] | undefined;
}): Promise<
    AggregationEnvelope<{
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
    }>
> {
    const q = buildExclusionQuery(params);
    return apiRequest(
        `/api/aggregations/recipient-insights${q ? `?${q}` : ""}`,
        { schema: RecipientInsightsSchema },
    );
}

export interface AverageVsCurrentData {
    past_6_months: {
        avg_daily_spending: number;
        avg_monthly_spending: number;
        months_counted: number;
    };
    current_month: {
        /** One entry per day with activity; spending is a positive magnitude. */
        daily_data: Array<{ date: string; spending: number; income: number }>;
        total_spending: number;
        days_elapsed: number;
        days_in_month: number;
    };
    comparison: {
        projected_monthly_total: number;
        avg_monthly_spending: number;
        variance: number;
        pace: number | null;
    };
}

/** Month-to-date spending against the six-month average (Home hero). */
export function getAggregationAverageVsCurrent(params?: {
    currency?: string | undefined;
}): Promise<AggregationEnvelope<AverageVsCurrentData>> {
    return requestWithQuery("/api/aggregations/average-vs-current", params, {
        schema: AverageVsCurrentSchema,
    });
}

export function getAggregationBankBalances(params?: {
    currency?: string | undefined;
}): Promise<
    AggregationEnvelope<{
        accounts: Array<{
            account_id: number;
            bank_account: string;
            display_name: string;
            balance: number;
            drift?: number;
            anchor_date?: string;
            post_anchor_count?: number;
            transaction_count: number;
            first_transaction: string;
            last_transaction: string;
        }>;
        total_net_position: number;
        // Daily balance points (YYYY-MM-DD) over the last 12 months.
        history: Record<string, Array<{ date: string; balance: number }>>;
        total_history: Array<{ date: string; balance: number }>;
    }>
> {
    return requestWithQuery("/api/aggregations/bank-balances", params, {
        schema: BankBalancesSchema,
    });
}

export interface CategoryPivotItem {
    categoryId: number | null;
    categoryName: string;
    categoryPathIds?: number[];
    categoryPathSegments?: string[];
    total: number; // net (income + expense)
    income?: number; // sum of amount >= 0 (explicit, not sign-of-net)
    expense?: number; // sum of amount < 0 (negative)
    transactionCount: number;
    /** Part of `income` on partner / joint accounts (ADR-201); absent when both are 0. */
    incomeByOwner?: { partner?: number; joint?: number };
}

export interface RecipientYearlySpending {
    recipientId: number;
    name: string;
    totalSpend: number;
    transactionCount: number;
}

export interface RecipientPivotConversion {
    usedHistoricalFallback: boolean;
    affectedCurrencies: string[];
}

export function getAggregationCategoryPivot(params?: {
    currency?: string | undefined;
    start_date?: string | undefined;
    end_date?: string | undefined;
    excluded_category_ids?: number[] | undefined;
    excluded_recipient_ids?: number[] | undefined;
}): Promise<
    AggregationEnvelope<{ categoryPivot: Record<string, CategoryPivotItem[]> }>
> {
    const qp = new URLSearchParams();
    if (params?.currency) qp.set("currency", params.currency);
    if (params?.start_date) qp.set("start_date", params.start_date);
    if (params?.end_date) qp.set("end_date", params.end_date);
    if (params?.excluded_category_ids?.length) {
        params.excluded_category_ids.forEach((id) =>
            qp.append("excluded_category_ids", String(id)),
        );
    }
    if (params?.excluded_recipient_ids?.length) {
        params.excluded_recipient_ids.forEach((id) =>
            qp.append("excluded_recipient_ids", String(id)),
        );
    }
    const q = qp.toString();
    return apiRequest(`/api/aggregations/category-pivot${q ? `?${q}` : ""}`, {
        schema: CategoryPivotSchema,
    });
}

export function getAggregationRecipientByYear(params?: {
    currency?: string | undefined;
    start_date?: string | undefined;
    end_date?: string | undefined;
    excluded_recipient_ids?: number[] | undefined;
    excluded_category_ids?: number[] | undefined;
}): Promise<
    AggregationEnvelope<{
        recipientsByYear: Record<string, RecipientYearlySpending[]>;
    }>
> {
    const qp = new URLSearchParams();
    if (params?.currency) qp.set("currency", params.currency);
    if (params?.start_date) qp.set("start_date", params.start_date);
    if (params?.end_date) qp.set("end_date", params.end_date);
    if (params?.excluded_recipient_ids?.length) {
        params.excluded_recipient_ids.forEach((id) =>
            qp.append("excluded_recipient_ids", String(id)),
        );
    }
    if (params?.excluded_category_ids?.length) {
        params.excluded_category_ids.forEach((id) =>
            qp.append("excluded_category_ids", String(id)),
        );
    }
    const q = qp.toString();
    return apiRequest(
        `/api/aggregations/recipient-by-year${q ? `?${q}` : ""}`,
        {
            schema: RecipientByYearSchema,
        },
    );
}

export interface RecipientPivotItem {
    recipientId: number;
    name: string;
    total: number;
    transactionCount: number;
}

export function getAggregationRecipientPivot(params?: {
    currency?: string | undefined;
    excluded_recipient_ids?: number[] | undefined;
    recipient_ids?: number[] | undefined;
    bucket?: "monthly" | "yearly" | undefined;
    start_date?: string | null | undefined;
    end_date?: string | null | undefined;
}): Promise<
    AggregationEnvelope<{
        recipientPivot: Record<string, RecipientPivotItem[]>;
        conversion: RecipientPivotConversion;
    }>
> {
    const qp = new URLSearchParams();
    if (params?.currency) qp.set("currency", params.currency);
    if (params?.bucket) qp.set("bucket", params.bucket);
    if (params?.start_date) qp.set("start_date", params.start_date);
    if (params?.end_date) qp.set("end_date", params.end_date);
    if (params?.excluded_recipient_ids?.length) {
        params.excluded_recipient_ids.forEach((id) =>
            qp.append("excluded_recipient_ids", String(id)),
        );
    }
    if (params?.recipient_ids?.length) {
        params.recipient_ids.forEach((id) =>
            qp.append("recipient_ids", String(id)),
        );
    }
    const q = qp.toString();
    return apiRequest(`/api/aggregations/recipient-pivot${q ? `?${q}` : ""}`, {
        schema: RecipientPivotSchema,
    });
}

export interface TagPivotItem {
    tagId: number;
    slug: string;
    total: number;
    transactionCount: number;
}

export function getAggregationTagPivot(params?: {
    currency?: string | undefined;
    tag_ids?: number[] | undefined;
    all?: boolean | undefined;
    bucket?: "monthly" | "yearly" | undefined;
    start_date?: string | null | undefined;
    end_date?: string | null | undefined;
}): Promise<AggregationEnvelope<{ tagPivot: Record<string, TagPivotItem[]> }>> {
    const qp = new URLSearchParams();
    if (params?.currency) qp.set("currency", params.currency);
    if (params?.bucket) qp.set("bucket", params.bucket);
    if (params?.start_date) qp.set("start_date", params.start_date);
    if (params?.end_date) qp.set("end_date", params.end_date);
    if (params?.all) {
        // "all tags": let the server return every tag with spend in range.
        qp.set("all", "true");
    } else if (params?.tag_ids?.length) {
        params.tag_ids.forEach((id) => qp.append("tag_ids", String(id)));
    }
    const q = qp.toString();
    return apiRequest(`/api/aggregations/tag-pivot${q ? `?${q}` : ""}`, {
        schema: TagPivotSchema,
    });
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

export interface CashflowForecastMethod {
    readonly id: string;
    readonly label: string;
    readonly daily: ForecastDailyPoint[];
    readonly cumulative: ForecastDailyPoint[];
    readonly bands: ForecastBands | null;
    readonly cumulative_bands?: ForecastBands | null;
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
    readonly mape: number | null;
    readonly months: number;
    readonly per_month: ReadonlyArray<{
        readonly month: string;
        readonly mae: number;
        readonly rmse: number;
        readonly mape: number | null;
        readonly sample_days: number;
    }>;
}

export interface ForecastDiagnostics {
    readonly history_months: number;
    /** Weights the ensemble applied to each point method (server-computed). */
    readonly ensemble_weights?: Readonly<Record<string, number>>;
    readonly backtest: ForecastBacktestEntry[];
}

export interface CashflowForecastMethodsData {
    readonly month: string;
    readonly currency: string;
    readonly days_in_month: number;
    readonly current_day: number;
    readonly actual: ForecastActualPoint[];
    readonly scheduled_actual: ForecastPlannedPoint[];
    readonly methods: CashflowForecastMethod[];
    readonly planned: ForecastPlannedPoint[];
    readonly diagnostics: ForecastDiagnostics | null;
    readonly history_months: number;
    readonly include_planned: boolean;
}

export function getCashflowForecastMethods(params?: {
    currency?: string | undefined;
    excluded_category_ids?: number[] | undefined;
    excluded_recipient_ids?: number[] | undefined;
    history_months?: number | undefined;
    mc_paths?: number | undefined;
    mc_percentiles?: number[] | undefined;
    include_planned?: boolean | undefined;
    include_backtest?: boolean | undefined;
}): Promise<AggregationEnvelope<CashflowForecastMethodsData>> {
    const qp = new URLSearchParams();
    if (params?.currency) qp.set("currency", params.currency);
    if (params?.history_months != null)
        qp.set("history_months", String(params.history_months));
    if (params?.mc_paths != null) qp.set("mc_paths", String(params.mc_paths));
    if (params?.mc_percentiles?.length) {
        params.mc_percentiles.forEach((p) =>
            qp.append("mc_percentiles", String(p)),
        );
    }
    if (params?.include_planned != null)
        qp.set("include_planned", params.include_planned ? "true" : "false");
    if (params?.include_backtest != null)
        qp.set("include_backtest", params.include_backtest ? "true" : "false");
    if (params?.excluded_category_ids?.length) {
        params.excluded_category_ids.forEach((id) =>
            qp.append("excluded_category_ids", String(id)),
        );
    }
    if (params?.excluded_recipient_ids?.length) {
        params.excluded_recipient_ids.forEach((id) =>
            qp.append("excluded_recipient_ids", String(id)),
        );
    }
    const q = qp.toString();
    return apiRequest(
        `/api/aggregations/cashflow-forecast-methods${q ? `?${q}` : ""}`,
        { schema: CashflowForecastMethodsSchema },
    );
}

// ==================== Rolling-Window Cash Flow Forecast ====================

export interface CashflowForecastRollingData {
    readonly window_start: string;
    readonly window_end: string;
    readonly today: string;
    readonly currency: string;
    readonly days_back: number;
    readonly days_forward: number;
    readonly actual: ForecastActualPoint[];
    readonly scheduled_actual: ForecastPlannedPoint[];
    readonly methods: CashflowForecastMethod[];
    readonly planned: ForecastPlannedPoint[];
    readonly diagnostics: ForecastDiagnostics | null;
    readonly history_months: number;
    readonly include_planned: boolean;
}

export function getCashflowForecastRolling(params?: {
    currency?: string | undefined;
    excluded_category_ids?: number[] | undefined;
    excluded_recipient_ids?: number[] | undefined;
    history_months?: number | undefined;
    days_back?: number | undefined;
    days_forward?: number | undefined;
    mc_paths?: number | undefined;
    mc_percentiles?: number[] | undefined;
    include_planned?: boolean | undefined;
    include_backtest?: boolean | undefined;
}): Promise<AggregationEnvelope<CashflowForecastRollingData>> {
    const qp = new URLSearchParams();
    if (params?.currency) qp.set("currency", params.currency);
    if (params?.history_months != null)
        qp.set("history_months", String(params.history_months));
    if (params?.days_back != null)
        qp.set("days_back", String(params.days_back));
    if (params?.days_forward != null)
        qp.set("days_forward", String(params.days_forward));
    if (params?.mc_paths != null) qp.set("mc_paths", String(params.mc_paths));
    if (params?.mc_percentiles?.length) {
        params.mc_percentiles.forEach((p) =>
            qp.append("mc_percentiles", String(p)),
        );
    }
    if (params?.include_planned != null)
        qp.set("include_planned", params.include_planned ? "true" : "false");
    if (params?.include_backtest != null)
        qp.set("include_backtest", params.include_backtest ? "true" : "false");
    if (params?.excluded_category_ids?.length) {
        params.excluded_category_ids.forEach((id) =>
            qp.append("excluded_category_ids", String(id)),
        );
    }
    if (params?.excluded_recipient_ids?.length) {
        params.excluded_recipient_ids.forEach((id) =>
            qp.append("excluded_recipient_ids", String(id)),
        );
    }
    const q = qp.toString();
    return apiRequest(
        `/api/aggregations/cashflow-forecast-rolling${q ? `?${q}` : ""}`,
        { schema: CashflowForecastRollingSchema },
    );
}

export interface AccuracyHistoryPoint {
    readonly month: string;
    readonly mae: number;
    readonly rmse: number;
    readonly mape: number | null;
    readonly sample_days: number;
}

export interface AccuracyMethodEntry {
    readonly method_id: string;
    readonly as_of_month: string;
    readonly mae: number;
    readonly rmse: number;
    readonly mape: number | null;
    readonly sample_days: number;
    readonly history: AccuracyHistoryPoint[];
}

export interface CashflowForecastAccuracyData {
    readonly methods: AccuracyMethodEntry[];
    readonly limit_months: number;
}

export function getCashflowForecastAccuracy(params?: {
    limit_months?: number | undefined;
}): Promise<AggregationEnvelope<CashflowForecastAccuracyData>> {
    const qp = new URLSearchParams();
    if (params?.limit_months != null)
        qp.set("limit_months", String(params.limit_months));
    const q = qp.toString();
    return apiRequest(
        `/api/aggregations/cashflow-forecast-accuracy${q ? `?${q}` : ""}`,
        { schema: CashflowForecastAccuracySchema },
    );
}

export function getSankeyFlow(params?: {
    currency?: string | undefined;
    year?: number | undefined;
    excluded_category_ids?: number[] | undefined;
    excluded_recipient_ids?: number[] | undefined;
}): Promise<AggregationEnvelope<SankeyFlowData>> {
    const qp = new URLSearchParams();
    if (params?.currency) qp.set("currency", params.currency);
    if (params?.year != null) qp.set("year", String(params.year));
    if (params?.excluded_category_ids?.length) {
        params.excluded_category_ids.forEach((id) =>
            qp.append("excluded_category_ids", String(id)),
        );
    }
    if (params?.excluded_recipient_ids?.length) {
        params.excluded_recipient_ids.forEach((id) =>
            qp.append("excluded_recipient_ids", String(id)),
        );
    }
    const q = qp.toString();
    return apiRequest(`/api/aggregations/sankey${q ? `?${q}` : ""}`, {
        schema: SankeyFlowSchema,
    });
}
