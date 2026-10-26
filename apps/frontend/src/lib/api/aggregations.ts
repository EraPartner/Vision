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
    PeriodPivotConversionSchema,
    RecipientByYearSchema,
    RecipientInsightsSchema,
    RecipientPivotSchema,
    SankeyFlowSchema,
    TagPivotSchema,
} from "@vision/types/contracts";
import type { z } from "zod";
import type {
    CategoryId,
    CurrencyCode,
    RecipientId,
    TagId,
} from "@vision/types/brands";

export function getAggregationMonthlySummary(params?: {
    excluded_category_ids?: CategoryId[] | undefined;
    excluded_recipient_ids?: RecipientId[] | undefined;
    currency?: CurrencyCode | undefined;
    all_time?: boolean | undefined;
    start_date?: string | undefined;
    end_date?: string | undefined;
}): Promise<z.output<typeof MonthlySummarySchema>> {
    const qp = new URLSearchParams();
    if (params?.currency) qp.set("currency", params.currency);
    if (params?.all_time) qp.set("all_time", "true");
    if (params?.start_date) qp.set("start_date", params.start_date);
    if (params?.end_date) qp.set("end_date", params.end_date);
    if (
        params?.excluded_category_ids != null &&
        params.excluded_category_ids.length > 0
    ) {
        params.excluded_category_ids.forEach((id) =>
            qp.append("excluded_category_ids", String(id)),
        );
    }
    if (
        params?.excluded_recipient_ids != null &&
        params.excluded_recipient_ids.length > 0
    ) {
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
    currency?: CurrencyCode | undefined;
    start_date?: string | undefined;
    end_date?: string | undefined;
    excluded_category_ids?: CategoryId[] | undefined;
    excluded_recipient_ids?: RecipientId[] | undefined;
}): Promise<z.output<typeof RecipientInsightsSchema>> {
    const q = buildExclusionQuery(params);
    return apiRequest(
        `/api/aggregations/recipient-insights${q ? `?${q}` : ""}`,
        { schema: RecipientInsightsSchema },
    );
}

/** Month-to-date spending against the six-month average (Home hero). */
export function getAggregationAverageVsCurrent(params?: {
    currency?: CurrencyCode | undefined;
}): Promise<z.output<typeof AverageVsCurrentSchema>> {
    return requestWithQuery("/api/aggregations/average-vs-current", params, {
        schema: AverageVsCurrentSchema,
    });
}

export function getAggregationBankBalances(params?: {
    currency?: CurrencyCode | undefined;
}): Promise<z.output<typeof BankBalancesSchema>> {
    return requestWithQuery("/api/aggregations/bank-balances", params, {
        schema: BankBalancesSchema,
    });
}

export type CategoryPivotItem = z.output<typeof CategoryPivotSchema>["data"]["categoryPivot"][string][number];

export type RecipientPivotConversion = z.output<typeof PeriodPivotConversionSchema>;

export function getAggregationCategoryPivot(params?: {
    currency?: CurrencyCode | undefined;
    start_date?: string | undefined;
    end_date?: string | undefined;
    excluded_category_ids?: CategoryId[] | undefined;
    excluded_recipient_ids?: RecipientId[] | undefined;
}): Promise<z.output<typeof CategoryPivotSchema>> {
    const qp = new URLSearchParams();
    if (params?.currency) qp.set("currency", params.currency);
    if (params?.start_date) qp.set("start_date", params.start_date);
    if (params?.end_date) qp.set("end_date", params.end_date);
    if (
        params?.excluded_category_ids != null &&
        params.excluded_category_ids.length > 0
    ) {
        params.excluded_category_ids.forEach((id) =>
            qp.append("excluded_category_ids", String(id)),
        );
    }
    if (
        params?.excluded_recipient_ids != null &&
        params.excluded_recipient_ids.length > 0
    ) {
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
    currency?: CurrencyCode | undefined;
    start_date?: string | undefined;
    end_date?: string | undefined;
    excluded_recipient_ids?: RecipientId[] | undefined;
    excluded_category_ids?: CategoryId[] | undefined;
}): Promise<z.output<typeof RecipientByYearSchema>> {
    const qp = new URLSearchParams();
    if (params?.currency) qp.set("currency", params.currency);
    if (params?.start_date) qp.set("start_date", params.start_date);
    if (params?.end_date) qp.set("end_date", params.end_date);
    if (
        params?.excluded_recipient_ids != null &&
        params.excluded_recipient_ids.length > 0
    ) {
        params.excluded_recipient_ids.forEach((id) =>
            qp.append("excluded_recipient_ids", String(id)),
        );
    }
    if (
        params?.excluded_category_ids != null &&
        params.excluded_category_ids.length > 0
    ) {
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

export type RecipientPivotItem = z.output<typeof RecipientPivotSchema>["data"]["recipientPivot"][string][number];

export function getAggregationRecipientPivot(params?: {
    currency?: CurrencyCode | undefined;
    excluded_recipient_ids?: RecipientId[] | undefined;
    recipient_ids?: RecipientId[] | undefined;
    bucket?: "monthly" | "yearly" | undefined;
    start_date?: string | null | undefined;
    end_date?: string | null | undefined;
}): Promise<z.output<typeof RecipientPivotSchema>> {
    const qp = new URLSearchParams();
    if (params?.currency) qp.set("currency", params.currency);
    if (params?.bucket) qp.set("bucket", params.bucket);
    if (params?.start_date) qp.set("start_date", params.start_date);
    if (params?.end_date) qp.set("end_date", params.end_date);
    if (
        params?.excluded_recipient_ids != null &&
        params.excluded_recipient_ids.length > 0
    ) {
        params.excluded_recipient_ids.forEach((id) =>
            qp.append("excluded_recipient_ids", String(id)),
        );
    }
    if (params?.recipient_ids != null && params.recipient_ids.length > 0) {
        params.recipient_ids.forEach((id) =>
            qp.append("recipient_ids", String(id)),
        );
    }
    const q = qp.toString();
    return apiRequest(`/api/aggregations/recipient-pivot${q ? `?${q}` : ""}`, {
        schema: RecipientPivotSchema,
    });
}

export type TagPivotItem = z.output<typeof TagPivotSchema>["data"]["tagPivot"][string][number];

export function getAggregationTagPivot(params?: {
    currency?: CurrencyCode | undefined;
    tag_ids?: TagId[] | undefined;
    all?: boolean | undefined;
    bucket?: "monthly" | "yearly" | undefined;
    start_date?: string | null | undefined;
    end_date?: string | null | undefined;
}): Promise<z.output<typeof TagPivotSchema>> {
    const qp = new URLSearchParams();
    if (params?.currency) qp.set("currency", params.currency);
    if (params?.bucket) qp.set("bucket", params.bucket);
    if (params?.start_date) qp.set("start_date", params.start_date);
    if (params?.end_date) qp.set("end_date", params.end_date);
    if (params?.all) {
        // "all tags": let the server return every tag with spend in range.
        qp.set("all", "true");
    } else if (params?.tag_ids != null && params.tag_ids.length > 0) {
        params.tag_ids.forEach((id) => qp.append("tag_ids", String(id)));
    }
    const q = qp.toString();
    return apiRequest(`/api/aggregations/tag-pivot${q ? `?${q}` : ""}`, {
        schema: TagPivotSchema,
    });
}

export type SankeyFlowData = z.output<typeof SankeyFlowSchema>["data"];

// ==================== Cash Flow Forecast Methods ====================

/** Dynamic-percentile `bands`: keys are "p{N}" for each requested percentile. */
export type CashflowForecastMethod = CashflowForecastMethodsData["methods"][number];

export type ForecastBacktestEntry = ForecastDiagnostics["backtest"][number];

export type ForecastDiagnostics = NonNullable<CashflowForecastMethodsData["diagnostics"]>;

export type CashflowForecastMethodsData = z.output<typeof CashflowForecastMethodsSchema>["data"];

export function getCashflowForecastMethods(params?: {
    currency?: CurrencyCode | undefined;
    excluded_category_ids?: CategoryId[] | undefined;
    excluded_recipient_ids?: RecipientId[] | undefined;
    history_months?: number | undefined;
    mc_paths?: number | undefined;
    mc_percentiles?: number[] | undefined;
    include_planned?: boolean | undefined;
    include_backtest?: boolean | undefined;
}): Promise<z.output<typeof CashflowForecastMethodsSchema>> {
    const qp = new URLSearchParams();
    if (params?.currency) qp.set("currency", params.currency);
    if (params?.history_months != null)
        qp.set("history_months", String(params.history_months));
    if (params?.mc_paths != null) qp.set("mc_paths", String(params.mc_paths));
    if (params?.mc_percentiles != null && params.mc_percentiles.length > 0) {
        params.mc_percentiles.forEach((p) =>
            qp.append("mc_percentiles", String(p)),
        );
    }
    if (params?.include_planned != null)
        qp.set("include_planned", params.include_planned ? "true" : "false");
    if (params?.include_backtest != null)
        qp.set("include_backtest", params.include_backtest ? "true" : "false");
    if (
        params?.excluded_category_ids != null &&
        params.excluded_category_ids.length > 0
    ) {
        params.excluded_category_ids.forEach((id) =>
            qp.append("excluded_category_ids", String(id)),
        );
    }
    if (
        params?.excluded_recipient_ids != null &&
        params.excluded_recipient_ids.length > 0
    ) {
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

export type CashflowForecastRollingData = z.output<typeof CashflowForecastRollingSchema>["data"];

export function getCashflowForecastRolling(params?: {
    currency?: CurrencyCode | undefined;
    excluded_category_ids?: CategoryId[] | undefined;
    excluded_recipient_ids?: RecipientId[] | undefined;
    history_months?: number | undefined;
    days_back?: number | undefined;
    days_forward?: number | undefined;
    mc_paths?: number | undefined;
    mc_percentiles?: number[] | undefined;
    include_planned?: boolean | undefined;
    include_backtest?: boolean | undefined;
}): Promise<z.output<typeof CashflowForecastRollingSchema>> {
    const qp = new URLSearchParams();
    if (params?.currency) qp.set("currency", params.currency);
    if (params?.history_months != null)
        qp.set("history_months", String(params.history_months));
    if (params?.days_back != null)
        qp.set("days_back", String(params.days_back));
    if (params?.days_forward != null)
        qp.set("days_forward", String(params.days_forward));
    if (params?.mc_paths != null) qp.set("mc_paths", String(params.mc_paths));
    if (params?.mc_percentiles != null && params.mc_percentiles.length > 0) {
        params.mc_percentiles.forEach((p) =>
            qp.append("mc_percentiles", String(p)),
        );
    }
    if (params?.include_planned != null)
        qp.set("include_planned", params.include_planned ? "true" : "false");
    if (params?.include_backtest != null)
        qp.set("include_backtest", params.include_backtest ? "true" : "false");
    if (
        params?.excluded_category_ids != null &&
        params.excluded_category_ids.length > 0
    ) {
        params.excluded_category_ids.forEach((id) =>
            qp.append("excluded_category_ids", String(id)),
        );
    }
    if (
        params?.excluded_recipient_ids != null &&
        params.excluded_recipient_ids.length > 0
    ) {
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

export type AccuracyHistoryPoint = AccuracyMethodEntry["history"][number];

export type AccuracyMethodEntry = CashflowForecastAccuracyData["methods"][number];

export type CashflowForecastAccuracyData = z.output<typeof CashflowForecastAccuracySchema>["data"];

export function getCashflowForecastAccuracy(params?: {
    limit_months?: number | undefined;
}): Promise<z.output<typeof CashflowForecastAccuracySchema>> {
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
    currency?: CurrencyCode | undefined;
    year?: number | undefined;
    excluded_category_ids?: CategoryId[] | undefined;
    excluded_recipient_ids?: RecipientId[] | undefined;
}): Promise<z.output<typeof SankeyFlowSchema>> {
    const qp = new URLSearchParams();
    if (params?.currency) qp.set("currency", params.currency);
    if (params?.year != null) qp.set("year", String(params.year));
    if (
        params?.excluded_category_ids != null &&
        params.excluded_category_ids.length > 0
    ) {
        params.excluded_category_ids.forEach((id) =>
            qp.append("excluded_category_ids", String(id)),
        );
    }
    if (
        params?.excluded_recipient_ids != null &&
        params.excluded_recipient_ids.length > 0
    ) {
        params.excluded_recipient_ids.forEach((id) =>
            qp.append("excluded_recipient_ids", String(id)),
        );
    }
    const q = qp.toString();
    return apiRequest(`/api/aggregations/sankey${q ? `?${q}` : ""}`, {
        schema: SankeyFlowSchema,
    });
}
