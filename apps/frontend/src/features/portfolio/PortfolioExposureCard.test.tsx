// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { PortfolioExposureCard } from "./PortfolioExposureCard";

vi.mock("@/stores/hydration/LanguageHydration", async (importOriginal) => {
    const actual =
        await importOriginal<
            typeof import("@/stores/hydration/LanguageHydration")
        >();
    const { default: en } = await import("@/locales/en");
    return {
        ...actual,
        useLanguage: () => ({
            language: "en" as const,
            setLanguage: vi.fn(),
            t: (key: string, values?: Record<string, unknown>) => {
                let text: string = en[key] ?? key;
                for (const [name, value] of Object.entries(values ?? {}))
                    text = text.replace(`{${name}}`, String(value));
                return text;
            },
        }),
    };
});

vi.mock("@/hooks/portfolio/usePortfolioExposure", () => ({
    portfolioExposureQueryKey: () => ["portfolio-exposure"],
    usePortfolioExposureQuery: () => ({
        isLoading: false,
        isError: false,
        data: {
            totalValue: 100,
            uncoveredValue: 100,
            uncoveredWeightPercent: 100,
            coveredCashValue: 0,
            coveredCashWeightPercent: 0,
            warnings: [{ code: "STALE_FUND_SOURCE" }],
            fundSources: [
                {
                    investmentId: 1,
                    investmentName: "Unsupported Fund",
                    asOfDate: "2026-07-01",
                    evaluatedAt: "2026-09-14",
                    ageDays: 75,
                    maximumAgeDays: 30,
                    stale: true,
                    coverageStatus: "partial",
                },
            ],
            issuer: {
                rows: [],
                classifiedValue: 0,
                classifiedWeightPercent: 0,
                unclassifiedValue: 0,
                unclassifiedWeightPercent: 0,
            },
            sector: {
                rows: [],
                classifiedValue: 0,
                classifiedWeightPercent: 0,
                unclassifiedValue: 0,
                unclassifiedWeightPercent: 0,
            },
            issuerCountry: {
                rows: [],
                classifiedValue: 0,
                classifiedWeightPercent: 0,
                unclassifiedValue: 0,
                unclassifiedWeightPercent: 0,
            },
        },
    }),
}));

describe("PortfolioExposureCard", () => {
    it("shows stale source details even without classified contributions", () => {
        render(
            <QueryClientProvider client={new QueryClient()}>
                <PortfolioExposureCard currency="EUR" />
            </QueryClientProvider>,
        );

        expect(screen.getByText(/Unsupported Fund/)).toHaveTextContent(
            "Holdings as of 2026-07-01; age 75 days; maximum 30 · Stale source",
        );
        expect(
            screen.getByText("No holdings are classified for this dimension."),
        ).toBeVisible();
    });
});
