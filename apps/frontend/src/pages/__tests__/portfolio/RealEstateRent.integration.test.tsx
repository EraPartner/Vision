// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http } from "msw";
import { renderWithApp } from "@/test/renderWithApp";
import { server } from "@/test/msw/server";
import {
    ok,
    assetGroupTotalsStub,
    INVESTMENT_STUB,
    PORTFOLIO_SUMMARY_ITEM_STUB,
    PORTFOLIO_SUMMARY_STUB,
} from "@/test/msw/handlers";
import RealEstatePage from "@/pages/portfolio/RealEstatePage";
const base = "http://localhost:3002/api";

/**
 * The server converts each property's latest rent (GET
 * /api/info/portfolio-summary `monthlyRent`) and totals the page group; the
 * page only derives the yield percentage from those figures.
 */
function propertySummary(monthlyRent: number | null) {
    return {
        ...PORTFOLIO_SUMMARY_STUB,
        summaries: [
            {
                ...PORTFOLIO_SUMMARY_ITEM_STUB,
                name: "Synthetic property",
                asset_class: "real_estate",
                assetClass: "real_estate",
                originalCurrency: "USD",
                currency: "EUR",
                currentValue: 100000,
                totalBuyCost: 100000,
                monthlyRent,
            },
        ],
        byAssetGroup: assetGroupTotalsStub({
            real_estate: {
                holdingCount: 1,
                totalPortfolioValue: 100000,
                totalInvested: 100000,
                estimatedMonthlyRent: monthlyRent ?? 0,
                monthlyRentRateMissing: monthlyRent === null,
            },
        }),
    };
}

function serveInvestment() {
    server.use(
        http.get(`${base}/investments`, () =>
            ok({
                items: [
                    {
                        ...INVESTMENT_STUB,
                        asset_class: "real_estate",
                        currency: "USD",
                        name: "Synthetic property",
                    },
                ],
                total: 1,
                limit: 500,
                offset: 0,
                links: [],
            }),
        ),
    );
}

function expectRentAndYield(monthly: string, annual: string) {
    const income = screen.getAllByText(/^rental income$/i);
    expect(income).toHaveLength(2);
    for (const label of income)
        expect(
            label.tagName === "DT"
                ? label.parentElement
                : label.parentElement?.parentElement,
        ).toHaveTextContent(monthly);
    const yields = screen.getAllByText(/^yield$/i);
    expect(yields).toHaveLength(2);
    for (const label of yields)
        expect(
            label.tagName === "DT"
                ? label.parentElement
                : label.parentElement?.parentElement,
        ).toHaveTextContent(annual);
}

describe("real-estate rent from the server summary", () => {
    it.each([
        // 400 × 12 / 100 000 = 4.8 %; 800 × 12 / 100 000 = 9.6 %.
        [400, "400,00", "4,8"],
        [800, "800,00", "9,6"],
    ])(
        "renders aggregate and property rent %s with its yield",
        async (rent, monthly, annual) => {
            serveInvestment();
            server.use(
                http.get(`${base}/info/portfolio-summary`, () =>
                    ok(propertySummary(rent)),
                ),
            );
            renderWithApp(<RealEstatePage />);
            await screen.findByText("Synthetic property");
            expectRentAndYield(monthly, annual);
        },
    );

    it("shows the missing-rate error and recovers when a retry returns converted rent", async () => {
        serveInvestment();
        let rent: number | null = null;
        let requests = 0;
        server.use(
            http.get(`${base}/info/portfolio-summary`, () => {
                requests++;
                return ok(propertySummary(rent));
            }),
        );
        const user = userEvent.setup();
        renderWithApp(<RealEstatePage />);
        const retry = await screen.findByRole("button", { name: /retry/i });
        expect(
            screen.queryByText("Synthetic property"),
        ).not.toBeInTheDocument();
        const before = requests;
        rent = 400;
        await user.click(retry);
        await screen.findByText("Synthetic property");
        await waitFor(() => expect(requests).toBeGreaterThan(before));
        expectRentAndYield("400,00", "4,8");
    });
});
