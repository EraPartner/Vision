// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import { renderWithApp } from "@/test/renderWithApp";
import { apiClient } from "@/lib/api";
import { PortfolioTicker } from "@/features/portfolio/PortfolioTicker";
import type { InvestmentSummary } from "@/types/portfolio";

describe("PortfolioTicker", () => {
    it("keeps the duplicated marquee track inert and free of focusable controls", async () => {
        vi.spyOn(apiClient, "getMarketQuotes").mockResolvedValue([
            {
                symbol: "AAPL",
                name: "Apple Inc.",
                price: 200,
                change: 2,
                changePercent: 1,
                currency: "USD",
            },
        ]);

        const { container } = renderWithApp(
            <PortfolioTicker
                items={[
                    {
                        id: 1,
                        name: "Apple Inc.",
                        symbol: "AAPL",
                        price_provider: "yahoo",
                        show_in_ticker: true,
                    } as InvestmentSummary,
                ]}
            />,
        );

        expect(
            await screen.findByRole("button", { name: "Apple Inc." }),
        ).toBeInTheDocument();
        const duplicate = container.querySelector(
            '[aria-hidden="true"][inert]',
        );
        expect(duplicate).toBeInTheDocument();
        expect(
            duplicate?.querySelector(
                "button, a, input, select, textarea, [tabindex]",
            ),
        ).toBeNull();
    });
});
