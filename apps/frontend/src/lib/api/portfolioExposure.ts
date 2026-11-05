import { apiRequest } from "@/lib/api/client";
import {
    PortfolioExposureClassificationsSchema,
    PortfolioExposureSchema,
} from "@vision/types/contracts";
import type { CurrencyCode, InvestmentId } from "@vision/types/brands";
import type { components } from "@/types/generated";

type Schemas = components["schemas"];

export type PortfolioExposureSourceType =
    Schemas["PortfolioExposureContribution"]["sourceType"];
export type PortfolioExposureCoverageStatus =
    Schemas["PortfolioExposureFundSource"]["coverageStatus"];

export interface PortfolioExposureContribution {
    sourceType: PortfolioExposureSourceType;
    investmentId: InvestmentId;
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
    currency: CurrencyCode;
    computedAt: string;
    totalValue: number;
    uncoveredValue: number;
    uncoveredWeightPercent: number;
    coveredCashValue: number;
    coveredCashWeightPercent: number;
    fundSources: Array<{
        investmentId: InvestmentId;
        investmentName: string;
        asOfDate: string;
        evaluatedAt: string;
        ageDays: number;
        maximumAgeDays: number;
        stale: boolean;
        coverageStatus: PortfolioExposureCoverageStatus;
    }>;
    issuer: PortfolioExposureDimension;
    sector: PortfolioExposureDimension;
    issuerCountry: PortfolioExposureDimension;
    warnings: Array<Record<string, unknown>>;
    scopeNotes: string[];
}

export const getPortfolioExposure = (currency: CurrencyCode) =>
    apiRequest<PortfolioExposureResponse>(
        `/api/investments/exposure?currency=${encodeURIComponent(currency)}`,
        { schema: PortfolioExposureSchema },
    );
export const upsertPortfolioExposureSources = (bundle: unknown) =>
    apiRequest<Record<string, unknown>>("/api/investments/exposure/sources", {
        method: "PUT",
        body: JSON.stringify(bundle),
    });

export type ClassificationOrigin = "import" | "manual";
export interface HoldingClassification {
    issuerId: string;
    issuerName: string;
    sector: string | null;
    issuerCountryCode: string | null;
    origin: ClassificationOrigin;
    sourceLabel: string;
    updatedAt: string;
}
export interface ClassifiableHolding {
    investmentId: InvestmentId;
    name: string;
    symbol: string | null;
    assetClass: string;
    /** A fund holdings document overrides a whole-fund classification. */
    hasFundDocument: boolean;
    classification: HoldingClassification | null;
}
export interface PortfolioExposureClassifications {
    items: ClassifiableHolding[];
    issuers: Array<{ issuerId: string; issuerName: string }>;
    sectors: string[];
}
export interface ClassificationChanges {
    set: Array<{
        investmentId: InvestmentId;
        issuerName: string;
        sector?: string;
        issuerCountryCode?: string;
    }>;
    clear: InvestmentId[];
}

export const getPortfolioExposureClassifications = () =>
    apiRequest<PortfolioExposureClassifications>(
        "/api/investments/exposure/classifications",
        { schema: PortfolioExposureClassificationsSchema },
    );
export const savePortfolioExposureClassifications = (
    changes: ClassificationChanges,
) =>
    apiRequest<PortfolioExposureClassifications>(
        "/api/investments/exposure/classifications",
        {
            method: "PUT",
            body: JSON.stringify(changes),
            schema: PortfolioExposureClassificationsSchema,
        },
    );
