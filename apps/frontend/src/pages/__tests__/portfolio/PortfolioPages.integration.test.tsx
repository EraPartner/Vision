// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { screen, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http } from "msw";
import { toast } from "sonner";
import { renderWithApp } from "@/test/renderWithApp";
import { server } from "@/test/msw/server";
import { err, ok } from "@/test/msw/handlers";
import StocksPage from "@/pages/portfolio/StocksPage";
import CryptoPage from "@/pages/portfolio/CryptoPage";
import MetalsPage from "@/pages/portfolio/MetalsPage";
import RealEstatePage from "@/pages/portfolio/RealEstatePage";
import SavingsPage from "@/pages/portfolio/SavingsPage";
import PerformancePage from "@/pages/portfolio/PerformancePage";
import NetWorthPage from "@/pages/portfolio/net-worth/NetWorthPage";
import ExchangeRatesPage from "@/pages/admin/ExchangeRatesPage";
import WatchlistPage from "@/pages/research/WatchlistPage";
import PortfolioTaxPage from "@/pages/portfolio/tax/PortfolioTaxPage";
import MarketLookupPage from "@/pages/research/MarketLookupPage";
import { AddPortfolioTxnDialog } from "@/features/portfolio/AddPortfolioTxnDialog";
import { InvestmentDetailDialog } from "@/features/portfolio/InvestmentDetailDialog";
import type { InvestmentSummary } from "@/types/portfolio";

const API_BASE = "http://localhost:3002";

const PORTFOLIO_INVESTMENT: InvestmentSummary = {
    id: 1,
    name: "Test Fund",
    symbol: "IWDA",
    assetClass: "etf",
    asset_class: "etf",
    currency: "EUR",
    is_active: true,
    created_at: "2025-01-01T00:00:00.000Z",
    updated_at: "2025-01-01T00:00:00.000Z",
    totalUnits: 10,
    totalInvested: 1000,
    totalFees: 5,
    totalTaxes: 0,
    totalDividends: 0,
    totalIncome: 0,
    currentValue: 1100,
    avgCostBasis: 100,
    realizedGain: 0,
    unrealizedGain: 100,
    totalGain: 100,
    gainLoss: 100,
    gainLossPercent: 10,
    accruedInterest: 0,
    projectedAnnualInterest: 0,
    totalAppreciation: 0,
    totalBuyCost: 1005,
    totalSellProceeds: 0,
    transactions: [],
};

describe("Portfolio pages (integration)", () => {
    // ─── StocksPage ───────────────────────────────────────────────────────────
    it("StocksPage renders heading", async () => {
        renderWithApp(<StocksPage />);
        expect(
            await screen.findByRole("heading", { name: /stocks & etfs/i }),
        ).toBeInTheDocument();
    });

    it("StocksPage shows empty state when no stocks exist", async () => {
        renderWithApp(<StocksPage />);
        // Default MSW returns { items: [] } — EmptyState h3
        expect(
            await screen.findByRole("heading", { name: /no stocks or etfs/i }),
        ).toBeInTheDocument();
    });

    it("StocksPage shows Add Investment button", async () => {
        renderWithApp(<StocksPage />);
        // Multiple AddInvestmentDialog instances when investments = []
        const buttons = await screen.findAllByRole("button", { name: /add investment/i });
        expect(buttons.length).toBeGreaterThan(0);
    });

    // ─── CryptoPage ───────────────────────────────────────────────────────────
    it("CryptoPage renders heading", async () => {
        renderWithApp(<CryptoPage />);
        expect(
            await screen.findByRole("heading", { name: /cryptocurrency/i }),
        ).toBeInTheDocument();
    });

    it("CryptoPage shows empty state when no crypto holdings", async () => {
        renderWithApp(<CryptoPage />);
        // Default MSW returns { items: [] } → EmptyState with crypto.noCrypto
        expect(
            await screen.findByRole("heading", { name: /no crypto assets/i }),
        ).toBeInTheDocument();
    });

    it("CryptoPage shows Add Investment button", async () => {
        renderWithApp(<CryptoPage />);
        const buttons = await screen.findAllByRole("button", { name: /add investment/i });
        expect(buttons.length).toBeGreaterThan(0);
    });

    // ─── MetalsPage ───────────────────────────────────────────────────────────
    it("MetalsPage renders heading", async () => {
        renderWithApp(<MetalsPage />);
        expect(
            await screen.findByRole("heading", { name: /metals/i }),
        ).toBeInTheDocument();
    });

    it("MetalsPage shows empty state when no metal investments", async () => {
        renderWithApp(<MetalsPage />);
        // metals.noMetals = "No metal investments yet"
        expect(
            await screen.findByRole("heading", { name: /no metal investments yet/i }),
        ).toBeInTheDocument();
    });

    it("MetalsPage shows Add Investment button", async () => {
        renderWithApp(<MetalsPage />);
        const buttons = await screen.findAllByRole("button", { name: /add investment/i });
        expect(buttons.length).toBeGreaterThan(0);
    });

    // ─── RealEstatePage ───────────────────────────────────────────────────────
    it("RealEstatePage renders heading", async () => {
        renderWithApp(<RealEstatePage />);
        expect(
            await screen.findByRole("heading", { name: /real estate/i }),
        ).toBeInTheDocument();
    });

    it("RealEstatePage shows empty state when no properties", async () => {
        renderWithApp(<RealEstatePage />);
        // realestate.noProperties = "No properties"
        expect(
            await screen.findByRole("heading", { name: /no properties/i }),
        ).toBeInTheDocument();
    });

    it("RealEstatePage shows Add Investment button", async () => {
        renderWithApp(<RealEstatePage />);
        const buttons = await screen.findAllByRole("button", { name: /add investment/i });
        expect(buttons.length).toBeGreaterThan(0);
    });

    // ─── SavingsPage ──────────────────────────────────────────────────────────
    it("SavingsPage renders heading", async () => {
        renderWithApp(<SavingsPage />);
        expect(
            await screen.findByRole("heading", { name: /savings & bonds/i }),
        ).toBeInTheDocument();
    });

    it("SavingsPage shows empty state when no accounts", async () => {
        renderWithApp(<SavingsPage />);
        // savings.noAccounts = "No savings accounts or bonds"
        expect(
            await screen.findByRole("heading", { name: /no savings accounts or bonds/i }),
        ).toBeInTheDocument();
    });

    it("SavingsPage shows Add Investment button", async () => {
        renderWithApp(<SavingsPage />);
        const buttons = await screen.findAllByRole("button", { name: /add investment/i });
        expect(buttons.length).toBeGreaterThan(0);
    });

    // ─── PerformancePage ──────────────────────────────────────────────────────
    it("PerformancePage renders heading", async () => {
        renderWithApp(<PerformancePage />);
        await screen.findByRole("heading", { name: /performance/i });
    });

    it("PerformancePage shows empty state when no snapshots", async () => {
        renderWithApp(<PerformancePage />);
        // Default MSW returns { snapshots: [] } → PerformanceEmptyState renders
        // performance.emptyTitle = "No performance history yet"
        expect(
            await screen.findByText(/no performance history yet/i),
        ).toBeInTheDocument();
    });

    it("PerformancePage shows Refresh Prices button in empty state", async () => {
        renderWithApp(<PerformancePage />);
        // portfolio.refreshPrices = "Refresh Prices"
        expect(
            await screen.findByRole("button", { name: /refresh prices/i }),
        ).toBeInTheDocument();
    });

    // ─── NetWorthPage ─────────────────────────────────────────────────────────
    it("NetWorthPage renders heading", async () => {
        renderWithApp(<NetWorthPage />);
        expect(
            await screen.findByRole("heading", { name: /net worth/i, level: 1 }),
        ).toBeInTheDocument();
    });

    it("NetWorthPage shows empty state when no snapshots exist", async () => {
        renderWithApp(<NetWorthPage />);
        // Default MSW returns snapshots: [] — networth.emptyTitle = "No net worth history yet"
        expect(
            await screen.findByText(/no net worth history yet/i),
        ).toBeInTheDocument();
    });

    it("NetWorthPage shows Refresh Prices button in empty state", async () => {
        renderWithApp(<NetWorthPage />);
        // portfolio.refreshPrices = "Refresh Prices"
        expect(
            await screen.findByRole("button", { name: /refresh prices/i }),
        ).toBeInTheDocument();
    });

    it("NetWorthPage shows error state when net-worth API fails", async () => {
        const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
        server.use(
            http.get(`${API_BASE}/api/info/net-worth`, () =>
                err(500, "net worth unavailable"),
            ),
        );

        renderWithApp(<NetWorthPage />);

        // networth.unableToLoad = "Unable to load net worth"
        expect(
            await screen.findByText(/unable to load net worth/i, {}, { timeout: 5000 }),
        ).toBeInTheDocument();

        consoleSpy.mockRestore();
    });

    // ─── ExchangeRatesPage ────────────────────────────────────────────────────
    it("ExchangeRatesPage renders heading", async () => {
        renderWithApp(<ExchangeRatesPage />);
        expect(
            await screen.findByRole("heading", { name: /exchange rates/i }),
        ).toBeInTheDocument();
    });

    it("ExchangeRatesPage shows no-rates message when rates are empty", async () => {
        renderWithApp(<ExchangeRatesPage />);
        // Default MSW returns rates: [] → exchangeRates.noRates
        expect(
            await screen.findByText(/no exchange rates stored yet/i),
        ).toBeInTheDocument();
    });

    it("ExchangeRatesPage shows Refresh button", async () => {
        renderWithApp(<ExchangeRatesPage />);
        // exchangeRates.refresh = "Refresh"
        expect(
            await screen.findByRole("button", { name: /refresh/i }),
        ).toBeInTheDocument();
    });

    it("ExchangeRatesPage shows error state when API fails", async () => {
        const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
        server.use(
            http.get(`${API_BASE}/api/info/exchange-rates`, () =>
                err(500, "exchange rates unavailable"),
            ),
        );

        renderWithApp(<ExchangeRatesPage />);

        expect(
            await screen.findByText(/failed to load exchange rates/i, {}, { timeout: 5000 }),
        ).toBeInTheDocument();

        consoleSpy.mockRestore();
    });

    // ─── WatchlistPage ────────────────────────────────────────────────────────
    it("WatchlistPage renders heading", async () => {
        renderWithApp(<WatchlistPage />);
        expect(
            await screen.findByRole("heading", { name: /watchlist/i }),
        ).toBeInTheDocument();
    });

    it("WatchlistPage shows Add to Watchlist button", async () => {
        renderWithApp(<WatchlistPage />);
        // Multiple instances when watchlist = [] — header + empty state action
        const buttons = await screen.findAllByRole("button", { name: /add to watchlist/i });
        expect(buttons.length).toBeGreaterThan(0);
    });

    it("WatchlistPage shows empty state when watchlist is empty", async () => {
        renderWithApp(<WatchlistPage />);
        // Default MSW returns { items: [] } — EmptyState h3 first line of watchlist.empty
        expect(
            await screen.findByRole("heading", { name: /no prospective investments yet/i }),
        ).toBeInTheDocument();
    });

    it("WatchlistPage opens Add to Watchlist dialog when header button is clicked", async () => {
        const user = userEvent.setup();
        renderWithApp(<WatchlistPage />);

        // Header button is the first Add to Watchlist button rendered
        const buttons = await screen.findAllByRole("button", { name: /add to watchlist/i });
        await user.click(buttons[0]);

        // addWatchlist.title = "Add to Watchlist"
        expect(await screen.findByRole("dialog")).toBeInTheDocument();
        expect(
            await screen.findByRole("heading", { name: /^add to watchlist$/i }),
        ).toBeInTheDocument();
    });

    // ─── PortfolioTaxPage ─────────────────────────────────────────────────────
    it("PortfolioTaxPage renders heading", async () => {
        renderWithApp(<PortfolioTaxPage />);
        expect(
            await screen.findByRole("heading", { name: /investment tax & fees/i }),
        ).toBeInTheDocument();
    });

    it("PortfolioTaxPage shows empty state when no investment data", async () => {
        renderWithApp(<PortfolioTaxPage />);
        // Default MSW returns investments: [] → tax.noData = "No tax data"
        expect(
            await screen.findByRole("heading", { name: /no tax data/i }),
        ).toBeInTheDocument();
    });

    it("PortfolioTaxPage shows Set up tax profile button", async () => {
        renderWithApp(<PortfolioTaxPage />);
        // tax.profile.setup = "Set up tax profile" (shown when no profile)
        expect(
            await screen.findByRole("button", { name: /set up tax profile/i }),
        ).toBeInTheDocument();
    });

    it("PortfolioTaxPage shows Widgets button", async () => {
        renderWithApp(<PortfolioTaxPage />);
        // widgets.button = "Widgets"
        expect(
            await screen.findByRole("button", { name: /widgets/i }),
        ).toBeInTheDocument();
    });

    it("PortfolioTaxPage opens Manage Widgets dialog when Widgets button clicked", async () => {
        const user = userEvent.setup();
        renderWithApp(<PortfolioTaxPage />);

        const widgetsBtn = await screen.findByRole("button", { name: /widgets/i });
        await user.click(widgetsBtn);

        expect(await screen.findByRole("dialog")).toBeInTheDocument();
        expect(
            await screen.findByRole("heading", { name: /manage widgets/i }),
        ).toBeInTheDocument();
    });

    it("PortfolioTaxPage shows Manual Adjustments button", async () => {
        renderWithApp(<PortfolioTaxPage />);
        // tax.manualAdjustments = "Manual Adjustments"
        expect(
            await screen.findByRole("button", { name: /manual adjustments/i }),
        ).toBeInTheDocument();
    });

    it("PortfolioTaxPage opens Manual Adjustments dialog when button is clicked", async () => {
        const user = userEvent.setup();
        renderWithApp(<PortfolioTaxPage />);

        const adjustmentsBtn = await screen.findByRole("button", { name: /manual adjustments/i });
        await user.click(adjustmentsBtn);

        // tax.manualAdjustmentsTitle = "Manual tax and fee adjustments ({year})"
        expect(await screen.findByRole("dialog")).toBeInTheDocument();
        expect(
            await screen.findByRole("heading", { name: /manual tax and fee adjustments/i }),
        ).toBeInTheDocument();
    });

    // ─── MarketLookupPage ─────────────────────────────────────────────────────
    it("MarketLookupPage renders heading", async () => {
        renderWithApp(<MarketLookupPage />);
        expect(
            await screen.findByRole("heading", { name: /market lookup/i }),
        ).toBeInTheDocument();
    });

    it("MarketLookupPage shows search input", async () => {
        renderWithApp(<MarketLookupPage />);
        // Input with market.searchPlaceholder
        expect(
            await screen.findByPlaceholderText(/search ticker/i),
        ).toBeInTheDocument();
    });

    it("MarketLookupPage shows search hint when no symbol selected", async () => {
        renderWithApp(<MarketLookupPage />);
        // market.searchTicker = "Search for a ticker"
        expect(
            await screen.findByRole("heading", { name: /search for a ticker/i }),
        ).toBeInTheDocument();
    });

    // ─── Empty state descriptions ─────────────────────────────────────────────
    it("StocksPage shows empty state description text", async () => {
        renderWithApp(<StocksPage />);
        // stocks.noStocksDesc = "Track your stock and ETF investments with weighted average cost basis..."
        expect(
            await screen.findByText(/track your stock and etf investments/i),
        ).toBeInTheDocument();
    });

    it("CryptoPage shows empty state description text", async () => {
        renderWithApp(<CryptoPage />);
        // crypto.noCryptoDesc = "Track your crypto with live prices, weighted average cost..."
        expect(
            await screen.findByText(/track your crypto with live prices/i),
        ).toBeInTheDocument();
    });

    it("MetalsPage shows empty state description text", async () => {
        renderWithApp(<MetalsPage />);
        // metals.noMetalsDesc = "Add your first metal position (gold, silver, platinum, rhodium, etc.)..."
        expect(
            await screen.findByText(/add your first metal position/i),
        ).toBeInTheDocument();
    });

    it("RealEstatePage shows empty state description text", async () => {
        renderWithApp(<RealEstatePage />);
        // realestate.noPropertiesDesc = "Track real estate with purchase price, appreciation, rental income..."
        expect(
            await screen.findByText(/track real estate with purchase price/i),
        ).toBeInTheDocument();
    });

    it("SavingsPage shows empty state description text", async () => {
        renderWithApp(<SavingsPage />);
        // savings.noAccountsDesc = "Track fixed-income investments with interest rate calculations..."
        expect(
            await screen.findByText(/track fixed-income investments/i),
        ).toBeInTheDocument();
    });

    it("PerformancePage shows empty state description text", async () => {
        renderWithApp(<PerformancePage />);
        // performance.emptyDescription = "No performance snapshots yet. Refresh investment prices to generate the first snapshot."
        expect(
            await screen.findByText(/no performance snapshots yet/i),
        ).toBeInTheDocument();
    });

    // ─── ExchangeRatesPage additional ─────────────────────────────────────────
    it("ExchangeRatesPage shows subtitle text", async () => {
        renderWithApp(<ExchangeRatesPage />);
        // exchangeRates.subtitle = "Latest ECB rates -- fallback updated automatically on each successful fetch"
        expect(
            await screen.findByText(/latest ecb rates/i),
        ).toBeInTheDocument();
    });

    it("ExchangeRatesPage shows Fallback Currencies card heading", async () => {
        renderWithApp(<ExchangeRatesPage />);
        // exchangeRates.fallbackCurrencies = "Fallback Currencies" — always in summary Card
        expect(
            await screen.findByText(/fallback currencies/i),
        ).toBeInTheDocument();
    });

    // ─── WatchlistPage additional ─────────────────────────────────────────────
    it("WatchlistPage shows subtitle text", async () => {
        renderWithApp(<WatchlistPage />);
        // watchlist.subtitle = "Track prospective investments with target buy prices"
        expect(
            await screen.findByText(/track prospective investments with target buy prices/i),
        ).toBeInTheDocument();
    });

    it("WatchlistPage closes Add to Watchlist dialog when Escape is pressed", async () => {
        const user = userEvent.setup();
        renderWithApp(<WatchlistPage />);

        const buttons = await screen.findAllByRole("button", { name: /add to watchlist/i });
        await user.click(buttons[0]);
        expect(await screen.findByRole("dialog")).toBeInTheDocument();

        await user.keyboard("{Escape}");
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });

    // ─── PortfolioTaxPage additional ──────────────────────────────────────────
    it("PortfolioTaxPage shows subtitle text", async () => {
        renderWithApp(<PortfolioTaxPage />);
        // tax.portfolioDesc = "Overview of taxes paid and fees incurred across your portfolio."
        expect(
            await screen.findByText(/overview of taxes paid and fees incurred/i),
        ).toBeInTheDocument();
    });

    it("PortfolioTaxPage shows empty state description text", async () => {
        renderWithApp(<PortfolioTaxPage />);
        // tax.noDataDesc = "Add investments and transactions to see your tax overview."
        expect(
            await screen.findByText(/add investments and transactions to see your tax overview/i),
        ).toBeInTheDocument();
    });

    it("PortfolioTaxPage closes Manual Adjustments dialog via Escape key", async () => {
        const user = userEvent.setup();
        renderWithApp(<PortfolioTaxPage />);

        const adjustmentsBtn = await screen.findByRole("button", { name: /manual adjustments/i });
        await user.click(adjustmentsBtn);
        await screen.findByRole("dialog");

        await user.keyboard("{Escape}");
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });

    it("PortfolioTaxPage closes Manage Widgets dialog via Escape key", async () => {
        const user = userEvent.setup();
        renderWithApp(<PortfolioTaxPage />);

        const widgetsBtn = await screen.findByRole("button", { name: /widgets/i });
        await user.click(widgetsBtn);
        await screen.findByRole("dialog");

        await user.keyboard("{Escape}");
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });

    // ─── Error paths: investments API 500 → graceful empty-state render ──────────
    // These tests verify that a backend 500 never crashes the page UI.

    it("StocksPage renders heading gracefully when investments API returns 500", async () => {
        const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
        server.use(
            http.get(`${API_BASE}/api/investments`, () => err(500, "db error")),
        );
        renderWithApp(<StocksPage />);
        expect(
            await screen.findByRole("heading", { name: /stocks & etfs/i }, { timeout: 5000 }),
        ).toBeInTheDocument();
        consoleSpy.mockRestore();
    });

    it("CryptoPage renders heading gracefully when investments API returns 500", async () => {
        const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
        server.use(
            http.get(`${API_BASE}/api/investments`, () => err(500, "db error")),
        );
        renderWithApp(<CryptoPage />);
        expect(
            await screen.findByRole("heading", { name: /cryptocurrency/i }, { timeout: 5000 }),
        ).toBeInTheDocument();
        consoleSpy.mockRestore();
    });

    it("MetalsPage renders heading gracefully when investments API returns 500", async () => {
        const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
        server.use(
            http.get(`${API_BASE}/api/investments`, () => err(500, "db error")),
        );
        renderWithApp(<MetalsPage />);
        expect(
            await screen.findByRole("heading", { name: /metals/i }, { timeout: 5000 }),
        ).toBeInTheDocument();
        consoleSpy.mockRestore();
    });

    it("RealEstatePage renders heading gracefully when investments API returns 500", async () => {
        const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
        server.use(
            http.get(`${API_BASE}/api/investments`, () => err(500, "db error")),
        );
        renderWithApp(<RealEstatePage />);
        expect(
            await screen.findByRole("heading", { name: /real estate/i }, { timeout: 5000 }),
        ).toBeInTheDocument();
        consoleSpy.mockRestore();
    });

    it("SavingsPage renders heading gracefully when investments API returns 500", async () => {
        const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
        server.use(
            http.get(`${API_BASE}/api/investments`, () => err(500, "db error")),
        );
        renderWithApp(<SavingsPage />);
        expect(
            await screen.findByRole("heading", { name: /savings & bonds/i }, { timeout: 5000 }),
        ).toBeInTheDocument();
        consoleSpy.mockRestore();
    });

    it("PerformancePage renders gracefully when portfolio-performance API returns 500", async () => {
        const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
        server.use(
            http.get(`${API_BASE}/api/info/portfolio-performance`, () => err(500, "db error")),
        );
        renderWithApp(<PerformancePage />);
        expect(
            await screen.findByRole("heading", { name: /performance/i }, { timeout: 5000 }),
        ).toBeInTheDocument();
        consoleSpy.mockRestore();
    });

    it("WatchlistPage renders heading gracefully when watchlist API returns 500", async () => {
        const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
        server.use(
            http.get(`${API_BASE}/api/watchlist`, () => err(500, "db error")),
        );
        renderWithApp(<WatchlistPage />);
        expect(
            await screen.findByRole("heading", { name: /watchlist/i }, { timeout: 5000 }),
        ).toBeInTheDocument();
        consoleSpy.mockRestore();
    });

    it("PortfolioTaxPage renders heading gracefully when investments API returns 500", async () => {
        const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
        server.use(
            http.get(`${API_BASE}/api/investments`, () => err(500, "db error")),
        );
        renderWithApp(<PortfolioTaxPage />);
        expect(
            await screen.findByRole("heading", { name: /investment tax & fees/i }, { timeout: 5000 }),
        ).toBeInTheDocument();
        consoleSpy.mockRestore();
    });

    // ─── Add Investment mutation tests ────────────────────────────────────────
    // CryptoPage uses allowedAssetClasses=['crypto'] (single class) → dialog skips
    // type selector and opens directly to the details form step.

    it("CryptoPage Add Investment dialog opens directly to details step", async () => {
        const user = userEvent.setup();
        renderWithApp(<CryptoPage />);

        const addBtns = await screen.findAllByRole("button", { name: /add investment/i });
        await user.click(addBtns[0]);

        // With a single allowed asset class, dialog skips the type selector
        const dialog = await screen.findByRole("dialog");
        expect(within(dialog).getByLabelText(/name \*/i)).toBeInTheDocument();
    });

    it("CryptoPage Add Investment POST success shows success toast", async () => {
        const toastSpy = vi.spyOn(toast, "success");
        server.use(
            http.post(`${API_BASE}/api/investments`, () =>
                ok({ id: 1, name: "Bitcoin", asset_class: "crypto", currency: "EUR",
                     price_provider: "binance", created_at: "2025-01-01T00:00:00.000Z" }),
            ),
        );

        const user = userEvent.setup();
        renderWithApp(<CryptoPage />);

        const addBtns = await screen.findAllByRole("button", { name: /add investment/i });
        await user.click(addBtns[0]);

        const nameInput = await screen.findByLabelText(/name \*/i);
        await user.type(nameInput, "Bitcoin");

        // "Add initial purchase" defaults ON and now requires an amount —
        // these tests create a bare investment, so switch it off.
        await user.click(screen.getByRole("switch"));

        const createBtn = screen.getByRole("button", { name: /^add$/i });
        await user.click(createBtn);

        await vi.waitFor(() => {
            expect(toastSpy).toHaveBeenCalledWith(
                expect.stringMatching(/bitcoin/i),
            );
        }, { timeout: 3000 });

        toastSpy.mockRestore();
    });

    it("CryptoPage Add Investment POST failure shows error toast", async () => {
        const toastSpy = vi.spyOn(toast, "error");
        server.use(
            http.post(`${API_BASE}/api/investments`, () => err(500, "insert failed")),
        );

        const user = userEvent.setup();
        renderWithApp(<CryptoPage />);

        const addBtns = await screen.findAllByRole("button", { name: /add investment/i });
        await user.click(addBtns[0]);

        const nameInput = await screen.findByLabelText(/name \*/i);
        await user.type(nameInput, "Bitcoin");

        // "Add initial purchase" defaults ON and now requires an amount —
        // these tests create a bare investment, so switch it off.
        await user.click(screen.getByRole("switch"));

        const createBtn = screen.getByRole("button", { name: /^add$/i });
        await user.click(createBtn);

        // useInvestmentMutations onError fires: toast.error(t('portfolio.createInvestmentFailedTitle'), ...)
        await vi.waitFor(() => {
            expect(toastSpy).toHaveBeenCalledWith(
                expect.stringMatching(/failed to create investment/i),
                expect.anything(),
            );
        }, { timeout: 5000 });

        toastSpy.mockRestore();
    });

    it("CryptoPage Add Investment blocks submit when initial purchase is on without amount", async () => {
        // Regression: this used to create the investment and silently drop the
        // buy behind a success toast; now nothing is POSTed until the initial
        // purchase is filled in (or toggled off).
        const toastSpy = vi.spyOn(toast, "error");
        let postCalls = 0;
        server.use(
            http.post(`${API_BASE}/api/investments`, () => {
                postCalls += 1;
                return ok({ id: 1, name: "Bitcoin", asset_class: "crypto", currency: "EUR",
                     price_provider: "binance", created_at: "2025-01-01T00:00:00.000Z" });
            }),
        );

        const user = userEvent.setup();
        renderWithApp(<CryptoPage />);

        const addBtns = await screen.findAllByRole("button", { name: /add investment/i });
        await user.click(addBtns[0]);

        const nameInput = await screen.findByLabelText(/name \*/i);
        await user.type(nameInput, "Bitcoin");

        await user.click(screen.getByRole("button", { name: /^add$/i }));

        await vi.waitFor(() => {
            expect(toastSpy).toHaveBeenCalled();
        }, { timeout: 3000 });
        expect(postCalls).toBe(0);

        toastSpy.mockRestore();
    });

    it("StocksPage Add Investment type selector shows Stock and ETF options", async () => {
        const user = userEvent.setup();
        renderWithApp(<StocksPage />);

        const addBtns = await screen.findAllByRole("button", { name: /add investment/i });
        await user.click(addBtns[0]);

        // StocksPage has 2 allowed types → type selector appears first
        // addInv.chooseType = "Choose Asset Type"
        await screen.findByRole("heading", { name: /choose asset type/i });

        // Both asset class buttons should be visible (accessible name starts with label, followed by description)
        expect(screen.getByRole("button", { name: /^stock/i })).toBeInTheDocument();
        expect(screen.getByRole("button", { name: /^etf/i })).toBeInTheDocument();
    });

    it("StocksPage Add Investment type selector → Stock → advances to details step", async () => {
        const user = userEvent.setup();
        renderWithApp(<StocksPage />);

        const addBtns = await screen.findAllByRole("button", { name: /add investment/i });
        await user.click(addBtns[0]);

        await screen.findByRole("heading", { name: /choose asset type/i });
        await user.click(screen.getByRole("button", { name: /^stock/i }));

        // After selecting type, dialog advances to details — Name * input appears
        expect(await screen.findByLabelText(/name \*/i)).toBeInTheDocument();
    });

    // ─── WatchlistPage mutation tests ─────────────────────────────────────────

    it("WatchlistPage truncates long company names while exposing the full title", async () => {
        const mockItem = {
            id: 1, name: "A very long watchlist company name", symbol: "LONG",
            asset_class: "stock" as const, target_price: 150,
            currency: "EUR", notes: null, price_provider_id: null,
        };

        server.use(
            http.get(`${API_BASE}/api/watchlist`, () =>
                ok({ items: [mockItem], total: 1, limit: 50, offset: 0 }),
            ),
        );

        renderWithApp(<WatchlistPage />);

        expect(await screen.findByTitle(mockItem.name)).toHaveClass("truncate");
    });

    it("WatchlistPage remove item shows success toast after DELETE", async () => {
        const toastSpy = vi.spyOn(toast, "success");
        const mockItem = {
            id: 1, name: "Apple Watch", symbol: "AAPL",
            asset_class: "stock" as const, target_price: 150,
            currency: "EUR", notes: null, price_provider_id: null,
        };

        server.use(
            http.get(`${API_BASE}/api/watchlist`, () =>
                ok({ items: [mockItem], total: 1, limit: 50, offset: 0 }),
            ),
            http.delete(`${API_BASE}/api/watchlist/1`, () => ok(null)),
        );

        const user = userEvent.setup();
        renderWithApp(<WatchlistPage />);

        // Wait for item to render
        await screen.findByText("Apple Watch");

        // Trash button is the only icon-only button (no text content) on the page
        const allBtns = screen.getAllByRole("button");
        const trashBtn = allBtns.find((btn) => !btn.textContent?.trim())!;
        await user.click(trashBtn);

        // Removal is destructive and has no undo, so it confirms first
        // (useConfirmDialog) — watchlist.removeConfirm = "Remove".
        await user.click(
            await screen.findByRole("button", { name: /^remove$/i }),
        );

        // watchlist.removedSuccess = "Removed from watchlist"
        await vi.waitFor(() => {
            expect(toastSpy).toHaveBeenCalledWith(
                expect.stringMatching(/removed from watchlist/i),
            );
        }, { timeout: 3000 });

        toastSpy.mockRestore();
    });

    it("WatchlistPage Add to Watchlist POST failure shows error toast", async () => {
        const toastSpy = vi.spyOn(toast, "error");
        server.use(
            // Market search returns a result so the dialog can proceed past the guard
            http.get(`${API_BASE}/api/market/search`, () =>
                ok({ items: [{ symbol: "AAPL", name: "Apple Inc.", type: "Equity", exchange: "NASDAQ" }] }),
            ),
            http.post(`${API_BASE}/api/watchlist`, () => err(500, "insert failed")),
        );

        const user = userEvent.setup();
        renderWithApp(<WatchlistPage />);

        const addBtns = await screen.findAllByRole("button", { name: /add to watchlist/i });
        await user.click(addBtns[0]);

        const dialog = await screen.findByRole("dialog");

        // Type in search box — debounce fires after 300ms, MSW responds, results appear
        const searchInput = within(dialog).getByPlaceholderText(/search by name or symbol/i);
        await user.type(searchInput, "AAPL");

        // Wait for debounced search result to appear (default findBy timeout covers 300ms debounce)
        const appleResult = await screen.findByText("Apple Inc.", {}, { timeout: 2000 });
        await user.click(appleResult);

        // Fill in target price — required by the submit guard
        const targetPriceInput = await screen.findByPlaceholderText(/enter target price/i);
        await user.type(targetPriceInput, "150");

        // Submit — now both selectedAsset and targetPrice are set
        const submitBtn = within(screen.getByRole("dialog")).getByRole("button", { name: /add to watchlist/i });
        await user.click(submitBtn);

        // addWatchlist.error = "Error" / addWatchlist.failed = "Failed to add to watchlist"
        await vi.waitFor(() => {
            expect(toastSpy).toHaveBeenCalledWith(
                expect.stringMatching(/error/i),
                expect.anything(),
            );
        }, { timeout: 5000 });

        toastSpy.mockRestore();
    });

    // ─── AddPortfolioTxnDialog ────────────────────────────────────────────────
    describe("AddPortfolioTxnDialog", () => {
        it("renders 'Add Transaction' trigger button", async () => {
            renderWithApp(<AddPortfolioTxnDialog investment={PORTFOLIO_INVESTMENT} />);
            // form.addTransaction.title = "Add Transaction"
            expect(await screen.findByRole("button", { name: /add transaction/i })).toBeInTheDocument();
        });

        it("clicking trigger opens dialog with investment title", async () => {
            const user = userEvent.setup();
            renderWithApp(<AddPortfolioTxnDialog investment={PORTFOLIO_INVESTMENT} />);
            await user.click(await screen.findByRole("button", { name: /add transaction/i }));
            // addPortTxn.title = "Record Transaction -- {symbol}"
            expect(await screen.findByRole("heading", { name: /record transaction.*iwda/i })).toBeInTheDocument();
        });

        it("Cancel button closes dialog", async () => {
            const user = userEvent.setup();
            renderWithApp(<AddPortfolioTxnDialog investment={PORTFOLIO_INVESTMENT} />);
            await user.click(await screen.findByRole("button", { name: /add transaction/i }));
            await screen.findByRole("dialog");
            // addPortTxn.cancel = "Cancel"
            await user.click(await screen.findByRole("button", { name: /^cancel$/i }));
            await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
        });

        it("submitting calls POST /api/investments/:id/transactions", async () => {
            let posted = false;
            server.use(
                http.post(`${API_BASE}/api/investments/:investmentId/transactions`, () => {
                    posted = true;
                    return ok({
                        id: 99,
                        investment_id: 1,
                        type: "buy",
                        date: "2025-01-15",
                        amount: 1000,
                        units: 10,
                        price_per_unit: 100,
                        currency: "EUR",
                        is_recurring: false,
                        created_at: "2025-01-15T10:00:00.000Z",
                        updated_at: "2025-01-15T10:00:00.000Z",
                    });
                }),
            );

            const user = userEvent.setup();
            renderWithApp(<AddPortfolioTxnDialog investment={PORTFOLIO_INVESTMENT} />);
            await user.click(await screen.findByRole("button", { name: /add transaction/i }));
            await screen.findByRole("dialog");

            // ETF (unit-based): fill units + price per unit (any 2 of 3 satisfies validation)
            const unitsInput = screen.getByLabelText(/units \/ shares/i);
            const priceInput = screen.getByLabelText(/price per unit/i);
            await user.clear(unitsInput);
            await user.type(unitsInput, "10");
            await user.clear(priceInput);
            await user.type(priceInput, "100");

            // addPortTxn.record = "Record"
            await user.click(screen.getByRole("button", { name: /^record$/i }));
            await waitFor(() => expect(posted).toBe(true), { timeout: 3000 });
        });
    });

    // ─── InvestmentDetailDialog ───────────────────────────────────────────────
    describe("InvestmentDetailDialog", () => {
        it("renders 'Details' trigger button", async () => {
            renderWithApp(<InvestmentDetailDialog investment={PORTFOLIO_INVESTMENT} />);
            // invDetail.trigger = "Details"
            expect(await screen.findByRole("button", { name: /^details$/i })).toBeInTheDocument();
        });

        it("clicking trigger opens dialog", async () => {
            const user = userEvent.setup();
            renderWithApp(<InvestmentDetailDialog investment={PORTFOLIO_INVESTMENT} />);
            await user.click(await screen.findByRole("button", { name: /^details$/i }));
            expect(await screen.findByRole("dialog")).toBeInTheDocument();
        });

        it("Performance tab is active by default and shows Current Value", async () => {
            const user = userEvent.setup();
            renderWithApp(<InvestmentDetailDialog investment={PORTFOLIO_INVESTMENT} />);
            await user.click(await screen.findByRole("button", { name: /^details$/i }));
            await screen.findByRole("dialog");
            // invDetail.currentValue = "Current Value"
            expect(await screen.findByText(/current value/i)).toBeInTheDocument();
        });

        it("Transactions tab shows no-transactions empty state", async () => {
            const user = userEvent.setup();
            renderWithApp(<InvestmentDetailDialog investment={PORTFOLIO_INVESTMENT} />);
            await user.click(await screen.findByRole("button", { name: /^details$/i }));
            await screen.findByRole("dialog");
            // invDetail.tab.transactions = "Transactions ({n})" — n=0
            const txnTab = await screen.findByRole("tab", { name: /transactions/i });
            await user.click(txnTab);
            // invDetail.noTransactions = "No transactions recorded yet"
            expect(await screen.findByText(/no transactions recorded yet/i)).toBeInTheDocument();
        });

        it("Transactions tab label reflects transaction count", async () => {
            const investmentWithTx = {
                ...PORTFOLIO_INVESTMENT,
                transactions: [{
                    id: 1,
                    investment_id: 1,
                    type: "buy" as const,
                    date: "2025-01-15",
                    amount: 1000,
                    units: 10,
                    price_per_unit: 100,
                    currency: "EUR",
                    is_recurring: false,
                    created_at: "2025-01-15T10:00:00.000Z",
                    updated_at: "2025-01-15T10:00:00.000Z",
                }],
            };
            const user = userEvent.setup();
            renderWithApp(<InvestmentDetailDialog investment={investmentWithTx} />);
            await user.click(await screen.findByRole("button", { name: /^details$/i }));
            await screen.findByRole("dialog");
            // invDetail.tab.transactions = "Transactions ({n})" → "Transactions (1)"
            expect(await screen.findByRole("tab", { name: /transactions \(1\)/i })).toBeInTheDocument();
        });
    });

    // ─── Edge cases ────────────────────────────────────────────────────────────

    describe("Page-level edge cases", () => {
        it("StocksPage does not crash on 4xx investments endpoint", async () => {
            const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
            server.use(
                http.get(`${API_BASE}/api/investments`, () => err(404, "Not found")),
            );
            const { container } = renderWithApp(<StocksPage />);
            await new Promise((r) => setTimeout(r, 200));
            expect(container.firstChild).toBeTruthy();
            errSpy.mockRestore();
        });

        it("PerformancePage does not crash on 4xx performance endpoint", async () => {
            const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
            server.use(
                http.get(`${API_BASE}/api/info/portfolio-performance`, () =>
                    err(404, "Not found"),
                ),
            );
            const { container } = renderWithApp(<PerformancePage />);
            await new Promise((r) => setTimeout(r, 200));
            expect(container.firstChild).toBeTruthy();
            errSpy.mockRestore();
        });

        it("NetWorthPage does not crash on 4xx net-worth endpoint", async () => {
            const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
            server.use(
                http.get(`${API_BASE}/api/info/net-worth`, () => err(404, "Not found")),
            );
            const { container } = renderWithApp(<NetWorthPage />);
            await new Promise((r) => setTimeout(r, 200));
            expect(container.firstChild).toBeTruthy();
            errSpy.mockRestore();
        });

        it("WatchlistPage does not crash on 4xx watchlist endpoint", async () => {
            const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
            server.use(
                http.get(`${API_BASE}/api/watchlist`, () => err(404, "Not found")),
            );
            const { container } = renderWithApp(<WatchlistPage />);
            await new Promise((r) => setTimeout(r, 200));
            expect(container.firstChild).toBeTruthy();
            errSpy.mockRestore();
        });

        it("ExchangeRatesPage does not crash on 4xx exchange-rates endpoint", async () => {
            const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
            server.use(
                http.get(`${API_BASE}/api/info/exchange-rates`, () => err(404, "Not found")),
            );
            const { container } = renderWithApp(<ExchangeRatesPage />);
            await new Promise((r) => setTimeout(r, 200));
            expect(container.firstChild).toBeTruthy();
            errSpy.mockRestore();
        });

        it("WatchlistPage does not crash on 5xx watchlist endpoint", async () => {
            const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
            server.use(
                http.get(`${API_BASE}/api/watchlist`, () => err(500, "Server error")),
            );
            const { container } = renderWithApp(<WatchlistPage />);
            await new Promise((r) => setTimeout(r, 200));
            expect(container.firstChild).toBeTruthy();
            errSpy.mockRestore();
        });

        it("WatchlistPage delete mutation invalidates watchlist list (stale refetch)", async () => {
            let getCalls = 0;
            const item = {
                id: 1,
                symbol: "AAPL",
                name: "Apple",
                asset_class: "stock",
                currency: "USD",
                target_price: 200,
                notes: null,
                price_provider_id: "AAPL",
                created_at: "2025-01-01T00:00:00Z",
                updated_at: "2025-01-01T00:00:00Z",
            };
            server.use(
                http.get(`${API_BASE}/api/watchlist`, () => {
                    getCalls += 1;
                    return ok({ items: [item], total: 1, limit: 50, offset: 0 });
                }),
                http.delete(`${API_BASE}/api/watchlist/:id`, () =>
                    ok({ message: "deleted" }),
                ),
            );

            const user = userEvent.setup();
            renderWithApp(<WatchlistPage />);
            await screen.findByRole("heading", { name: /watchlist/i });
            // Wait for at least 1 GET call
            await waitFor(() => expect(getCalls).toBeGreaterThan(0));
            const before = getCalls;

            // Click delete on the watchlist item
            const trashBtn = await screen.findByRole("button", { name: /remove from watchlist/i });
            await user.click(trashBtn);
            await waitFor(() => expect(getCalls).toBeGreaterThan(before));
        });

        it("PortfolioTaxPage does not crash on 5xx investments endpoint", async () => {
            const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
            server.use(
                http.get(`${API_BASE}/api/investments`, () => err(500, "Server error")),
            );
            const { container } = renderWithApp(<PortfolioTaxPage />);
            await new Promise((r) => setTimeout(r, 200));
            expect(container.firstChild).toBeTruthy();
            errSpy.mockRestore();
        });

        it("CryptoPage create investment invalidates investments list (stale refetch)", async () => {
            let getCalls = 0;
            server.use(
                http.get(`${API_BASE}/api/investments`, () => {
                    getCalls += 1;
                    return ok({ items: [], total: 0, limit: 200, offset: 0, links: [] });
                }),
                http.post(`${API_BASE}/api/investments`, () =>
                    ok({
                        id: 99,
                        name: "Bitcoin",
                        asset_class: "crypto",
                        currency: "EUR",
                        price_provider: "binance",
                        created_at: "2025-01-01T00:00:00.000Z",
                    }),
                ),
            );

            const user = userEvent.setup();
            renderWithApp(<CryptoPage />);
            await screen.findAllByRole("heading", { name: /crypto/i });
            await waitFor(() => expect(getCalls).toBeGreaterThan(0));
            const before = getCalls;

            const addBtns = await screen.findAllByRole("button", { name: /add investment/i });
            await user.click(addBtns[0]);

            const nameInput = await screen.findByLabelText(/name \*/i);
            await user.type(nameInput, "Bitcoin");

            await user.click(screen.getByRole("button", { name: /^add$/i }));

            await waitFor(() => expect(getCalls).toBeGreaterThan(before), { timeout: 4000 });
        });

        it("StocksPage create investment invalidates investments list (stale refetch)", async () => {
            let getCalls = 0;
            server.use(
                http.get(`${API_BASE}/api/investments`, () => {
                    getCalls += 1;
                    return ok({ items: [], total: 0, limit: 200, offset: 0, links: [] });
                }),
                http.post(`${API_BASE}/api/investments`, () =>
                    ok({
                        id: 100,
                        name: "Apple",
                        asset_class: "stock",
                        currency: "USD",
                        price_provider: "alphavantage",
                        created_at: "2025-01-01T00:00:00.000Z",
                    }),
                ),
            );

            const user = userEvent.setup();
            renderWithApp(<StocksPage />);
            await screen.findAllByRole("heading", { name: /stocks/i });
            await waitFor(() => expect(getCalls).toBeGreaterThan(0));
            const before = getCalls;

            const addBtns = await screen.findAllByRole("button", { name: /add investment/i });
            await user.click(addBtns[0]);

            // StocksPage: type selector first → pick Stock
            await screen.findByRole("heading", { name: /choose asset type/i });
            await user.click(screen.getByRole("button", { name: /^stock/i }));

            const nameInput = await screen.findByLabelText(/name \*/i);
            await user.type(nameInput, "Apple");

            // "Add initial purchase" defaults ON and now requires an amount —
            // these tests create a bare investment, so switch it off.
            await user.click(screen.getByRole("switch"));

            await user.click(screen.getByRole("button", { name: /^add$/i }));

            await waitFor(() => expect(getCalls).toBeGreaterThan(before), { timeout: 4000 });
        });
    });
});
