// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http } from "msw";
import { renderWithApp } from "@/test/renderWithApp";
import { server } from "@/test/msw/server";
import { ok, err } from "@/test/msw/handlers";
import MarketLookupPage from "@/pages/research/MarketLookupPage";

const API_BASE = "http://localhost:3002";

/** Minimal valid Quote fixture */
const appleQuote = {
    symbol: "AAPL",
    name: "Apple Inc.",
    price: 189.5,
    change: 1.23,
    changePercent: 0.65,
    currency: "USD",
    exchange: "NASDAQ",
    type: "Equity",
    open: 188.1,
    dayHigh: 190.2,
    dayLow: 187.5,
    prevClose: 188.27,
    volume: 52_000_000,
    avgVolume: 55_000_000,
    high52w: 199.62,
    low52w: 124.17,
    marketCap: 2_900_000_000_000,
    pe: 29.4,
    forwardPE: 27.1,
    dividendYield: 0.0053,
    eps: 6.45,
    beta: 1.23,
    priceToBook: 45.1,
    analystConsensus: null,
    recentAnalystActions: [],
};

describe("MarketLookupPage (integration)", () => {
    it("renders page heading", async () => {
        renderWithApp(<MarketLookupPage />);
        // marketLookup.title = "Market Lookup"
        expect(
            await screen.findByRole("heading", { name: /market lookup/i }),
        ).toBeInTheDocument();
    });

    it("renders without crashing on initial load", async () => {
        renderWithApp(<MarketLookupPage />);
        await screen.findByRole("heading", { name: /market lookup/i });
    });

    it("shows search input with placeholder", async () => {
        renderWithApp(<MarketLookupPage />);
        // market.searchPlaceholder = "Search ticker, company, ETF, index..."
        expect(
            await screen.findByPlaceholderText(/search ticker/i),
        ).toBeInTheDocument();
    });

    it("shows empty state prompt when no symbol is selected", async () => {
        renderWithApp(<MarketLookupPage />);
        // market.searchTicker = "Search for a ticker"
        expect(
            await screen.findByRole("heading", { name: /search for a ticker/i }),
        ).toBeInTheDocument();
    });

    it("shows search results dropdown when user types a query", async () => {
        const user = userEvent.setup({ delay: null });

        server.use(
            http.get(`${API_BASE}/api/market/search`, () =>
                ok({
                    items: [
                        { symbol: "AAPL", name: "Apple Inc.", type: "Equity", exchange: "NASDAQ" },
                    ],
                }),
            ),
        );

        renderWithApp(<MarketLookupPage />);
        const input = await screen.findByPlaceholderText(/search ticker/i);
        await user.type(input, "AAPL");

        // Dropdown result shows the symbol
        expect(await screen.findByText("AAPL", {}, { timeout: 5000 })).toBeInTheDocument();
    });

    it("selects a symbol from dropdown and requests quote", async () => {
        const user = userEvent.setup({ delay: null });
        let quoteFetched = false;

        server.use(
            http.get(`${API_BASE}/api/market/search`, () =>
                ok({
                    items: [
                        { symbol: "AAPL", name: "Apple Inc.", type: "Equity", exchange: "NASDAQ" },
                    ],
                }),
            ),
            http.get(`${API_BASE}/api/market/quote`, () => {
                quoteFetched = true;
                return ok({ quotes: [appleQuote] });
            }),
            http.get(`${API_BASE}/api/market/chart`, () =>
                ok({ symbol: "AAPL", currency: "USD", points: [] }),
            ),
            http.get(`${API_BASE}/api/market/news`, () => ok({ articles: [] })),
        );

        renderWithApp(<MarketLookupPage />);
        const input = await screen.findByPlaceholderText(/search ticker/i);
        await user.type(input, "AAPL");

        // Click first dropdown result
        const resultBtn = await screen.findByRole("button", { name: /apple inc/i }, { timeout: 5000 });
        await user.click(resultBtn);

        expect(quoteFetched).toBe(true);
    });

    it("shows quote card with symbol name after selecting a result", async () => {
        const user = userEvent.setup({ delay: null });

        server.use(
            http.get(`${API_BASE}/api/market/search`, () =>
                ok({
                    items: [
                        { symbol: "AAPL", name: "Apple Inc.", type: "Equity", exchange: "NASDAQ" },
                    ],
                }),
            ),
            http.get(`${API_BASE}/api/market/quote`, () =>
                ok({ quotes: [appleQuote] }),
            ),
            http.get(`${API_BASE}/api/market/chart`, () =>
                ok({ symbol: "AAPL", currency: "USD", points: [] }),
            ),
            http.get(`${API_BASE}/api/market/news`, () => ok({ articles: [] })),
        );

        renderWithApp(<MarketLookupPage />);
        const input = await screen.findByPlaceholderText(/search ticker/i);
        await user.type(input, "AAPL");

        const resultBtn = await screen.findByRole("button", { name: /apple inc/i }, { timeout: 5000 });
        await user.click(resultBtn);

        // Quote card shows symbol and company name
        expect(await screen.findByText("Apple Inc.")).toBeInTheDocument();
    });

    it("shows quote card when symbol is supplied via URL query param", async () => {
        server.use(
            http.get(`${API_BASE}/api/market/quote`, () => ok({ quotes: [appleQuote] })),
            http.get(`${API_BASE}/api/market/chart`, () =>
                ok({ symbol: "AAPL", currency: "USD", points: [] }),
            ),
            http.get(`${API_BASE}/api/market/news`, () => ok({ articles: [] })),
        );

        renderWithApp(<MarketLookupPage />, { initialEntries: ["/?symbol=AAPL"] });

        // Company name from quote data appears
        expect(await screen.findByText("Apple Inc.")).toBeInTheDocument();
    });

    it("shows Price Chart section when a symbol is loaded", async () => {
        server.use(
            http.get(`${API_BASE}/api/market/quote`, () => ok({ quotes: [appleQuote] })),
            http.get(`${API_BASE}/api/market/chart`, () =>
                ok({ symbol: "AAPL", currency: "USD", points: [] }),
            ),
            http.get(`${API_BASE}/api/market/news`, () => ok({ articles: [] })),
        );

        renderWithApp(<MarketLookupPage />, { initialEntries: ["/?symbol=AAPL"] });

        // market.priceChart = "Price Chart"
        expect(await screen.findByText(/price chart/i)).toBeInTheDocument();
    });

    it("shows Latest News section when a symbol is loaded", async () => {
        server.use(
            http.get(`${API_BASE}/api/market/quote`, () => ok({ quotes: [appleQuote] })),
            http.get(`${API_BASE}/api/market/chart`, () =>
                ok({ symbol: "AAPL", currency: "USD", points: [] }),
            ),
            http.get(`${API_BASE}/api/market/news`, () => ok({ articles: [] })),
        );

        renderWithApp(<MarketLookupPage />, { initialEntries: ["/?symbol=AAPL"] });

        // market.latestNews = "Latest News"
        expect(await screen.findByText(/latest news/i)).toBeInTheDocument();
    });

    it("shows No news message when articles are empty", async () => {
        server.use(
            http.get(`${API_BASE}/api/market/quote`, () => ok({ quotes: [appleQuote] })),
            http.get(`${API_BASE}/api/market/chart`, () =>
                ok({ symbol: "AAPL", currency: "USD", points: [] }),
            ),
            http.get(`${API_BASE}/api/market/news`, () => ok({ articles: [] })),
        );

        renderWithApp(<MarketLookupPage />, { initialEntries: ["/?symbol=AAPL"] });

        // market.noNews = "No news available"
        expect(await screen.findByText(/no news available/i)).toBeInTheDocument();
    });

    it("shows time range buttons when quote is loaded", async () => {
        server.use(
            http.get(`${API_BASE}/api/market/quote`, () => ok({ quotes: [appleQuote] })),
            http.get(`${API_BASE}/api/market/chart`, () =>
                ok({ symbol: "AAPL", currency: "USD", points: [] }),
            ),
            http.get(`${API_BASE}/api/market/news`, () => ok({ articles: [] })),
        );

        renderWithApp(<MarketLookupPage />, { initialEntries: ["/?symbol=AAPL"] });

        // Range buttons: 1D, 5D, 1M, etc.
        expect(await screen.findByRole("button", { name: /^1d$/i })).toBeInTheDocument();
        expect(await screen.findByRole("button", { name: /^1y$/i })).toBeInTheDocument();
    });

    it("shows no-quote message when quote API fails for URL-supplied symbol", async () => {
        server.use(
            http.get(`${API_BASE}/api/market/quote`, () => err(500, "Server error")),
            http.get(`${API_BASE}/api/market/chart`, () =>
                ok({ symbol: "AAPL", currency: "USD", points: [] }),
            ),
            http.get(`${API_BASE}/api/market/news`, () => ok({ articles: [] })),
        );

        renderWithApp(<MarketLookupPage />, { initialEntries: ["/?symbol=AAPL"] });

        // market.noQuote = "No quote data available for {symbol}"
        expect(await screen.findByText(/no quote data available for aapl/i)).toBeInTheDocument();
    });

    it("renders without crashing when search API fails", async () => {
        const user = userEvent.setup({ delay: null });

        server.use(
            http.get(`${API_BASE}/api/market/search`, () => err(500, "Server error")),
        );

        renderWithApp(<MarketLookupPage />);
        const input = await screen.findByPlaceholderText(/search ticker/i);
        await user.type(input, "FAIL");

        // Page still renders heading — no crash despite search API failure
        expect(screen.getByRole("heading", { name: /market lookup/i })).toBeInTheDocument();
    });

    // ─── Edge cases ────────────────────────────────────────────────────────

    it("renders without crashing when quote API returns 404 for unknown symbol", async () => {
        server.use(
            http.get(`${API_BASE}/api/market/quote`, () => err(404, "Symbol not found")),
        );
        renderWithApp(<MarketLookupPage />, { initialEntries: ["/?symbol=NOTREAL"] });
        // Heading still renders despite the 404
        expect(
            await screen.findByRole("heading", { name: /market lookup/i }),
        ).toBeInTheDocument();
    });

    it("renders without crashing when news API fails (5xx)", async () => {
        const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
        server.use(
            http.get(`${API_BASE}/api/market/news`, () => err(503, "news unavailable")),
        );
        renderWithApp(<MarketLookupPage />, { initialEntries: ["/?symbol=AAPL"] });
        expect(
            await screen.findByRole("heading", { name: /market lookup/i }),
        ).toBeInTheDocument();
        errSpy.mockRestore();
    });
});
