import { apiRequest } from "@/lib/api/client";
import { buildExclusionQuery } from "@/lib/api/helpers";
import {
    BelgianPortfolioTaxDashboardSchema,
    BelgianTaxDashboardSchema,
} from "@vision/types/contracts";
import type { components } from "@/types/generated";

/** Server-computed tax overview charts and widget data (GET /api/belgian-tax/dashboard). */
export type BelgianTaxDashboard = components["schemas"]["BelgianTaxDashboard"];
export type BelgianTaxDashboardYear =
    components["schemas"]["BelgianTaxDashboardYearCalculation"];
export type BelgianTaxDashboardSuggestion =
    BelgianTaxDashboard["suggestions"][number];

/** Server-computed portfolio tax dashboard (GET /api/belgian-tax/portfolio-dashboard). */
export type BelgianPortfolioTaxDashboard =
    components["schemas"]["BelgianPortfolioTaxDashboard"];

export interface BelgianTaxDashboardParams {
    year: number;
    currency: string;
    start_date?: string | undefined;
    end_date?: string | undefined;
    excluded_category_ids?: number[] | undefined;
    excluded_recipient_ids?: number[] | undefined;
}

export function getBelgianTaxDashboard(
    params: BelgianTaxDashboardParams,
    signal?: AbortSignal,
): Promise<BelgianTaxDashboard> {
    const query = new URLSearchParams(buildExclusionQuery(params));
    query.set("year", String(params.year));
    return apiRequest<BelgianTaxDashboard>(
        `/api/belgian-tax/dashboard?${query.toString()}`,
        { schema: BelgianTaxDashboardSchema, ...(signal ? { signal } : {}) },
    );
}

export function getBelgianPortfolioTaxDashboard(
    params: { year: number; currency: string },
    signal?: AbortSignal,
): Promise<BelgianPortfolioTaxDashboard> {
    const query = new URLSearchParams({
        year: String(params.year),
        currency: params.currency,
    });
    return apiRequest<BelgianPortfolioTaxDashboard>(
        `/api/belgian-tax/portfolio-dashboard?${query.toString()}`,
        {
            schema: BelgianPortfolioTaxDashboardSchema,
            ...(signal ? { signal } : {}),
        },
    );
}
