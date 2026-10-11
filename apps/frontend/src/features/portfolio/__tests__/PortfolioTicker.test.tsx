// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import { renderWithApp } from "@/test/renderWithApp";
import { apiClient } from "@/lib/api";
import { PortfolioTicker } from "@/features/portfolio/PortfolioTicker";
import type { InvestmentSummary } from "@/types/portfolio";

describe("PortfolioTicker", () => {
    beforeEach(() => vi.clearAllMocks());
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
    it("does not request ambiguous symbols from manual or other providers", () => {
        const quotes = vi
            .spyOn(apiClient, "getMarketQuotes")
            .mockResolvedValue([]);
        const { container } = renderWithApp(
            <PortfolioTicker
                items={
                    [
                        {
                            id: 1,
                            name: "Bitcoin",
                            symbol: "BTC",
                            price_provider: "manual",
                        },
                        {
                            id: 2,
                            name: "Ethereum",
                            symbol: "ETH",
                            price_provider: "binance",
                            price_provider_id: "ETHUSDT",
                        },
                    ] as InvestmentSummary[]
                }
            />,
        );
        expect(quotes).not.toHaveBeenCalled();
        expect(container).toBeEmptyDOMElement();
    });

    it("matches only the configured Yahoo pair, never the ambiguous base symbol", async () => {
        const quotes = vi
            .spyOn(apiClient, "getMarketQuotes")
            .mockResolvedValue([
                {
                    symbol: "BTC",
                    name: "Unrelated fund",
                    price: 36.36,
                    changePercent: 1,
                    currency: "USD",
                },
                {
                    symbol: "BTC-USD",
                    name: "Bitcoin USD",
                    price: 80000,
                    changePercent: 2,
                    currency: "USD",
                },
            ]);
        renderWithApp(
            <PortfolioTicker
                items={
                    [
                        {
                            id: 1,
                            name: "Bitcoin",
                            symbol: "BTC",
                            price_provider: "yahoo",
                            price_provider_id: "BTC-USD",
                        },
                    ] as InvestmentSummary[]
                }
            />,
        );
        expect(
            await screen.findByRole("button", { name: "Bitcoin" }),
        ).toBeInTheDocument();
        expect(quotes).toHaveBeenCalledWith("BTC-USD", { detail: "basic" });
        expect(screen.queryByText(/36[,.]36/)).not.toBeInTheDocument();
        expect(screen.getAllByText(/80[.,]000/)).toHaveLength(2);
    });

    it("does not substitute a returned base quote when the configured pair is missing", async () => {
        const quotes = vi
            .spyOn(apiClient, "getMarketQuotes")
            .mockResolvedValue([
                {
                    symbol: "AAPL",
                    name: "Apple",
                    price: 200,
                    changePercent: 1,
                    currency: "USD",
                },
                {
                    symbol: "ETH",
                    name: "Unrelated fund",
                    price: 23.61,
                    changePercent: 1,
                    currency: "USD",
                },
            ]);
        renderWithApp(
            <PortfolioTicker
                items={
                    [
                        {
                            id: 2,
                            name: "Apple",
                            symbol: "AAPL",
                            price_provider: "yahoo",
                        },
                        {
                            id: 1,
                            name: "Ethereum",
                            symbol: "ETH",
                            price_provider: "yahoo",
                            price_provider_id: "ETH-USD",
                        },
                    ] as InvestmentSummary[]
                }
            />,
        );
        await screen.findByRole("button", { name: "Apple" });
        expect(quotes).toHaveBeenCalledWith("AAPL,ETH-USD", {
            detail: "basic",
        });
        expect(screen.queryByText(/23[,.]61/)).not.toBeInTheDocument();
    });
});
