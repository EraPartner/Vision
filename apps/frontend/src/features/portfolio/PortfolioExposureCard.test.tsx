// @vitest-environment jsdom
import { useSettingsStore } from "@/stores/settingsStore";
import { describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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
            uncoveredValue: 99.94,
            uncoveredWeightPercent: 99.94,
            coveredCashValue: 0.06,
            coveredCashWeightPercent: 0.06,
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
    it("uses the selected number format for exposure percentages", () => {
        const { container } = render(
            <QueryClientProvider client={new QueryClient()}>
                <PortfolioExposureCard currency="EUR" />
            </QueryClientProvider>,
        );
        expect(screen.getByText("99,94%")).toBeInTheDocument();
        // CSS needs an invariant decimal separator even when visible labels use commas.
        expect(container.querySelector('[style="width: 99.94%;"]')).not.toBeNull();
        expect(screen.getByText("0,06%")).toBeInTheDocument();
        act(() =>
            useSettingsStore
                .getState()
                .updateAppSettings({ numberFormat: "us" }),
        );
        expect(screen.getByText("99.94%")).toBeInTheDocument();
        expect(screen.getByText("0.06%")).toBeInTheDocument();
    });

    it("keeps stale-source warnings visible and source details expandable", async () => {
        render(
            <QueryClientProvider client={new QueryClient()}>
                <PortfolioExposureCard currency="EUR" />
            </QueryClientProvider>,
        );

        expect(
            screen.getByText("Stale source: Unsupported Fund"),
        ).toBeVisible();
        const source = screen.getByText(/Holdings as of 2026-07-01/);
        expect(source).not.toBeVisible();
        await userEvent.click(screen.getByText("Sources and import"));
        expect(source).toBeVisible();
        expect(source).toHaveTextContent("age 75 days; maximum 30");
        expect(
            screen.getByText("No holdings are classified for this dimension."),
        ).toBeVisible();
    });
    it("announces the selected dimension and allows changing it", async () => {
        render(
            <QueryClientProvider client={new QueryClient()}>
                <PortfolioExposureCard currency="EUR" />
            </QueryClientProvider>,
        );
        const issuer = screen.getByRole("button", {
            name: "Issuer",
        });
        const sector = screen.getByRole("button", {
            name: "Sector",
        });
        expect(issuer).toHaveAttribute("aria-pressed", "true");
        await userEvent.click(sector);
        expect(issuer).toHaveAttribute("aria-pressed", "false");
        expect(sector).toHaveAttribute("aria-pressed", "true");
    });
    it("rejects oversized source bundles without replacing the current coverage", async () => {
        render(
            <QueryClientProvider client={new QueryClient()}>
                <PortfolioExposureCard currency="EUR" />
            </QueryClientProvider>,
        );
        await userEvent.click(screen.getByText("Sources and import"));
        const file = new File([new Uint8Array(1_000_001)], "sources.json", {
            type: "application/json",
        });
        await userEvent.upload(
            screen.getByLabelText("Import exposure sources"),
            file,
        );
        expect(screen.getByRole("alert")).toBeVisible();
        expect(
            screen.getByText("No holdings are classified for this dimension."),
        ).toBeVisible();
    });
});
