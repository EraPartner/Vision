import { apiRequest } from "@/lib/api/client";
import { buildExclusionQuery } from "@/lib/api/helpers";
import {
    BelgianPortfolioTaxDashboardSchema,
    BelgianTaxComputationSchema,
    BelgianTaxDashboardSchema,
    BelgianTaxOverviewSchema,
} from "@vision/types/contracts";
import type { components } from "@/types/generated";
import type {
    BelgianTaxCalculation,
    BelgianTaxProfileSnapshotMeta,
} from "@/lib/belgianTax/types";
import type {
    BelgianTaxHouseholdSnapshotsV2,
    BelgianTaxHouseholdV2,
    HouseholdTaxResult,
} from "@/lib/belgianTax/householdTypes";
import type {
    CategoryId,
    CurrencyCode,
    RecipientId,
} from "@vision/types/brands";

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
    currency: CurrencyCode;
    start_date?: string | undefined;
    end_date?: string | undefined;
    excluded_category_ids?: CategoryId[] | undefined;
    excluded_recipient_ids?: RecipientId[] | undefined;
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
    params: { year: number; currency: CurrencyCode },
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

/** Engine output for one household (POST /api/belgian-tax/compute). */
export interface BelgianTaxComputation {
    result: HouseholdTaxResult;
    calculation: BelgianTaxCalculation;
}

/**
 * Compute a household's tax on the server without saving anything. The household may hold
 * unsaved edits or be a historical snapshot.
 */
export function computeBelgianTax(
    household: BelgianTaxHouseholdV2,
    signal?: AbortSignal,
): Promise<BelgianTaxComputation> {
    return apiRequest<BelgianTaxComputation>("/api/belgian-tax/compute", {
        method: "POST",
        body: JSON.stringify({ household }),
        schema: BelgianTaxComputationSchema,
        ...(signal ? { signal } : {}),
    });
}

/** Stored setting with its compare-and-swap baseline, as the overview read it. */
export interface BelgianTaxSettingRecord {
    key: string;
    value: unknown;
    expected: { exists: boolean; value?: unknown };
}

/**
 * Hydrated Belgian-tax state (GET /api/belgian-tax/overview): the upgraded live household,
 * its snapshots and metadata, the selected year's frozen-first figures, and the CAS baselines
 * of the stored keys from the same read.
 */
export interface BelgianTaxOverview {
    year: number;
    liveYear: number;
    isHistorical: boolean;
    hasSnapshot: boolean;
    hasProfile: boolean;
    household: BelgianTaxHouseholdV2;
    liveHousehold: BelgianTaxHouseholdV2;
    householdSnapshots: BelgianTaxHouseholdSnapshotsV2;
    snapshotMetas: Record<string, BelgianTaxProfileSnapshotMeta>;
    metadata: BelgianTaxProfileSnapshotMeta;
    calculation: BelgianTaxCalculation;
    result: HouseholdTaxResult;
    calculationSource: "frozen" | "computed";
    householdResultSource: "frozen" | "computed";
    householdMigrationNeeded: boolean;
    snapshotsMigrationNeeded: boolean;
    storedValueInvalid: boolean;
    warnings: Array<{ key: string; kind: string; issues?: unknown }>;
    records: BelgianTaxSettingRecord[];
}

export function getBelgianTaxOverview(
    year?: number,
    signal?: AbortSignal,
): Promise<BelgianTaxOverview> {
    const query = year === undefined ? "" : `?year=${year}`;
    return apiRequest<BelgianTaxOverview>(
        `/api/belgian-tax/overview${query}`,
        { schema: BelgianTaxOverviewSchema, ...(signal ? { signal } : {}) },
    );
}
