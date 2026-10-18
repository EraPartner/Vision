// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http } from "msw";
import { renderWithApp } from "@/test/renderWithApp";
import { server } from "@/test/msw/server";
import {
    ok,
    INVESTMENT_STUB,
    PORTFOLIO_SUMMARY_ITEM_STUB,
    PORTFOLIO_SUMMARY_STUB,
    PORTFOLIO_TRANSACTION_STUB,
} from "@/test/msw/handlers";
import RealEstatePage from "@/pages/portfolio/RealEstatePage";
const base = "http://localhost:3002/api";
function property(originalCurrency: string, rentCurrency: string) {
    server.use(
        http.get(`${base}/investments`, () =>
            ok({
                items: [
                    {
                        ...INVESTMENT_STUB,
                        asset_class: "real_estate",
                        currency: originalCurrency,
                        name: "Synthetic property",
                    },
                ],
                total: 1,
                limit: 500,
                offset: 0,
                links: [],
            }),
        ),
        http.get(`${base}/info/portfolio-summary`, () =>
            ok({
                ...PORTFOLIO_SUMMARY_STUB,
                summaries: [
                    {
                        ...PORTFOLIO_SUMMARY_ITEM_STUB,
                        name: "Synthetic property",
                        asset_class: "real_estate",
                        assetClass: "real_estate",
                        originalCurrency,
                        currency: "EUR",
                        currentValue: 100000,
                        totalBuyCost: 100000,
                    },
                ],
            }),
        ),
        http.get(`${base}/investments/1/transactions`, () =>
            ok({
                items: [
                    {
                        ...PORTFOLIO_TRANSACTION_STUB,
                        type: "rent_income",
                        amount: 800,
                        currency: rentCurrency,
                    },
                ],
                total: 1,
                limit: 1000,
                offset: 0,
                links: [],
            }),
        ),
    );
}
function rates(available: boolean) {
    return ok({
        total_rates: 0,
        rates: [],
        fallback_rates: available ? { USD: 0.5, GBP: 1.2 } : {},
        source: "fallback",
        is_stale: true,
        last_fetched_at: null,
    });
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
describe("real-estate rent booking currency", () => {
    it.each([
        ["USD", "USD", "400,00", "4,8"],
        ["EUR", "EUR", "800,00", "9,6"],
        ["GBP", "USD", "400,00", "4,8"],
    ])(
        "renders aggregate and property rent/yield for property %s and rent %s",
        async (original, rent, monthly, annual) => {
            property(original!, rent!);
            server.use(
                http.get(`${base}/info/exchange-rates`, () => rates(true)),
            );
            renderWithApp(<RealEstatePage />);
            await screen.findByText("Synthetic property");
            expectRentAndYield(monthly!, annual!);
        },
    );
    it("retries missing FX rates and replaces the error with converted rent and yield", async () => {
        property("GBP", "USD");
        let available = false;
        let requests = 0;
        server.use(
            http.get(`${base}/info/exchange-rates`, () => {
                requests++;
                return rates(available);
            }),
        );
        const user = userEvent.setup();
        renderWithApp(<RealEstatePage />);
        const retry = await screen.findByRole("button", { name: /retry/i });
        expect(
            screen.queryByText("Synthetic property"),
        ).not.toBeInTheDocument();
        const before = requests;
        available = true;
        await user.click(retry);
        await screen.findByText("Synthetic property");
        await waitFor(() => expect(requests).toBeGreaterThan(before));
        expectRentAndYield("400,00", "4,8");
    });
});
