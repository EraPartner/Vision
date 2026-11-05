// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { asInvestmentId } from "@vision/types/brands";
import { ClassifyHoldingsDialog } from "./ClassifyHoldingsDialog";
import type { PortfolioExposureClassifications } from "@/lib/api/portfolioExposure";

vi.mock("@/stores/hydration/LanguageHydration", async (importOriginal) => {
    const actual =
        await importOriginal<
            typeof import("@/stores/hydration/LanguageHydration")
        >();
    const { default: en } = await import("@/locales/en");
    const t = (key: string, values?: Record<string, unknown>) => {
        let text: string = en[key] ?? key;
        for (const [name, value] of Object.entries(values ?? {}))
            text = text.replace(`{${name}}`, String(value));
        return text;
    };
    return {
        ...actual,
        useLanguage: () => ({
            language: "en" as const,
            setLanguage: vi.fn(),
            t,
            tc: (key: string, count: number) =>
                t(`${key}.${count === 1 ? "one" : "other"}`, { count }),
        }),
    };
});

const data: PortfolioExposureClassifications = {
    items: [
        {
            investmentId: asInvestmentId(1),
            name: "Apple",
            symbol: "AAPL",
            assetClass: "stock",
            hasFundDocument: false,
            classification: {
                issuerId: "apple",
                issuerName: "Apple Inc.",
                sector: "Information Technology",
                issuerCountryCode: "US",
                origin: "import",
                sourceLabel: "Bundle",
                updatedAt: "2026-11-01T00:00:00Z",
            },
        },
        {
            investmentId: asInvestmentId(2),
            name: "Shell",
            symbol: "SHEL",
            assetClass: "stock",
            hasFundDocument: false,
            classification: null,
        },
        {
            investmentId: asInvestmentId(3),
            name: "Clean Energy ETF",
            symbol: "INRG",
            assetClass: "etf",
            hasFundDocument: false,
            classification: null,
        },
    ],
    issuers: [{ issuerId: "apple", issuerName: "Apple Inc." }],
    sectors: ["Information Technology"],
};

const api = vi.hoisted(() => ({
    getPortfolioExposureClassifications: vi.fn(),
    savePortfolioExposureClassifications: vi.fn(),
}));
vi.mock("@/lib/api", () => ({ apiClient: api }));

function renderDialog(investmentIds?: number[]) {
    api.getPortfolioExposureClassifications.mockResolvedValue(data);
    api.savePortfolioExposureClassifications.mockResolvedValue(data);
    const onOpenChange = vi.fn();
    render(
        <QueryClientProvider client={new QueryClient()}>
            <ClassifyHoldingsDialog
                open
                onOpenChange={onOpenChange}
                investmentIds={investmentIds?.map(asInvestmentId)}
            />
        </QueryClientProvider>,
    );
    return { onOpenChange };
}

describe("ClassifyHoldingsDialog", () => {
    it("applies a sector to selected holdings, clears one, and saves only the changes", async () => {
        const user = userEvent.setup();
        const { onOpenChange } = renderDialog();
        await screen.findByText("Shell (SHEL)");

        const save = screen.getByRole("button", { name: "Save" });
        expect(save).toBeDisabled();

        await user.click(
            screen.getByRole("checkbox", { name: "Select Shell (SHEL)" }),
        );
        await user.click(
            screen.getByRole("checkbox", {
                name: "Select Clean Energy ETF (INRG)",
            }),
        );
        const bulk = screen.getByRole("group", {
            name: "Change selected holdings",
        });
        expect(within(bulk).getByText("2 selected")).toBeVisible();
        await user.type(
            within(bulk).getByLabelText("Sector for selected holdings"),
            "Energy",
        );
        await user.click(
            within(bulk).getByRole("button", { name: "Apply to selected" }),
        );
        await user.click(
            screen.getByRole("button", {
                name: "Clear classification for Apple (AAPL)",
            }),
        );
        await user.click(save);

        await waitFor(() =>
            expect(
                api.savePortfolioExposureClassifications,
            ).toHaveBeenCalledWith({
                set: [
                    { investmentId: 2, issuerName: "Shell", sector: "Energy" },
                    {
                        investmentId: 3,
                        issuerName: "Clean Energy ETF",
                        sector: "Energy",
                    },
                ],
                clear: [1],
            }),
        );
        await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    });

    it("limits the sheet to one holding from the row menu and shows where its values came from", async () => {
        renderDialog([1]);
        expect(
            await screen.findByRole("heading", { name: "Classify Apple" }),
        ).toBeVisible();
        expect(screen.queryByText("Shell (SHEL)")).toBeNull();
        expect(screen.getByText("Imported")).toBeVisible();
        expect(screen.getByLabelText("Sector for Apple (AAPL)")).toHaveValue(
            "Information Technology",
        );
        expect(
            screen.getByRole("combobox", {
                name: "Issuer country for Apple (AAPL)",
            }),
        ).toHaveTextContent("United States");
    });
});
