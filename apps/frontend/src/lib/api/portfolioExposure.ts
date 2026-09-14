import { apiRequest } from "@/lib/api/client";

export interface PortfolioExposureContribution {
    sourceType: "direct" | "fund";
    investmentId: number;
    investmentName: string;
    sourceFundName: string | null;
    amount: number;
    sourceAsOfDate: string | null;
    stale: boolean;
}
export interface PortfolioExposureDimension {
    rows: Array<{
        id: string;
        label: string;
        amount: number;
        weightPercent: number;
        contributions: PortfolioExposureContribution[];
    }>;
    classifiedValue: number;
    classifiedWeightPercent: number;
    unclassifiedValue: number;
    unclassifiedWeightPercent: number;
}
export interface PortfolioExposureResponse {
    currency: string;
    computedAt: string;
    totalValue: number;
    uncoveredValue: number;
    uncoveredWeightPercent: number;
    coveredCashValue: number;
    coveredCashWeightPercent: number;
    fundSources: Array<{
        investmentId: number;
        investmentName: string;
        asOfDate: string;
        evaluatedAt: string;
        ageDays: number;
        maximumAgeDays: number;
        stale: boolean;
        coverageStatus: "complete" | "partial";
    }>;
    issuer: PortfolioExposureDimension;
    sector: PortfolioExposureDimension;
    issuerCountry: PortfolioExposureDimension;
    warnings: Array<Record<string, unknown>>;
    scopeNotes: string[];
}

export const getPortfolioExposure = (currency: string) =>
    apiRequest<PortfolioExposureResponse>(
        `/api/investments/exposure?currency=${encodeURIComponent(currency)}`,
    );
export const upsertPortfolioExposureSources = (bundle: unknown) =>
    apiRequest<Record<string, unknown>>("/api/investments/exposure/sources", {
        method: "PUT",
        body: JSON.stringify(bundle),
    });
