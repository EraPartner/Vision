// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { screen, act, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http } from "msw";
import { renderWithApp } from "@/test/renderWithApp";
import { server } from "@/test/msw/server";
import { ok, err, INVESTMENT_STUB } from "@/test/msw/handlers";
import PortfolioOverviewPage from "@/pages/portfolio/PortfolioOverviewPage";

const API_BASE = "http://localhost:3002";

describe("PortfolioOverviewPage (integration)", () => {
    it("renders page heading", async () => {
        renderWithApp(<PortfolioOverviewPage />);
        expect(
            await screen.findByRole("heading", { name: /portfolio overview/i }),
        ).toBeInTheDocument();
    });

    it("renders empty state when no investments exist", async () => {
        renderWithApp(<PortfolioOverviewPage />);
        expect(
            await screen.findByRole("heading", { name: /no investments yet/i }),
        ).toBeInTheDocument();
    });

    it("shows Add Investment button", async () => {
        renderWithApp(<PortfolioOverviewPage />);
        // Multiple AddInvestmentDialog instances render when investments = []
        const buttons = await screen.findAllByRole("button", {
            name: /add investment/i,
        });
        expect(buttons.length).toBeGreaterThan(0);
    });

    it("shows Refresh Prices button", async () => {
        renderWithApp(<PortfolioOverviewPage />);
        expect(
            await screen.findByRole("button", { name: /refresh prices/i }),
        ).toBeInTheDocument();
    });

    it("shows Manage Widgets button", async () => {
        renderWithApp(<PortfolioOverviewPage />);
        expect(
            await screen.findByRole("button", { name: /widgets/i }),
        ).toBeInTheDocument();
    });

    it("opens Choose Asset Type dialog when Add Investment is clicked", async () => {
        const user = userEvent.setup();
        renderWithApp(<PortfolioOverviewPage />);

        const buttons = await screen.findAllByRole("button", {
            name: /add investment/i,
        });
        await user.click(buttons[0]);

        expect(await screen.findByRole("dialog")).toBeInTheDocument();
        expect(
            await screen.findByRole("heading", { name: /choose asset type/i }),
        ).toBeInTheDocument();
    });

    it("closes Choose Asset Type dialog when Escape is pressed", async () => {
        const user = userEvent.setup();
        renderWithApp(<PortfolioOverviewPage />);

        const buttons = await screen.findAllByRole("button", {
            name: /add investment/i,
        });
        await user.click(buttons[0]);

        await screen.findByRole("dialog");
        await user.keyboard("{Escape}");

        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });

    it("opens Manage Widgets dialog when Widgets button is clicked", async () => {
        const user = userEvent.setup();
        renderWithApp(<PortfolioOverviewPage />);

        await user.click(
            await screen.findByRole("button", { name: /widgets/i }),
        );

        expect(await screen.findByRole("dialog")).toBeInTheDocument();
        expect(
            await screen.findByRole("heading", { name: /manage widgets/i }),
        ).toBeInTheDocument();
    });

    it("closes Manage Widgets dialog via Escape", async () => {
        const user = userEvent.setup();
        renderWithApp(<PortfolioOverviewPage />);

        await user.click(
            await screen.findByRole("button", { name: /widgets/i }),
        );
        await screen.findByRole("dialog");

        await user.keyboard("{Escape}");

        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });

    it("Choose Asset Type dialog shows Stock asset class button", async () => {
        const user = userEvent.setup();
        renderWithApp(<PortfolioOverviewPage />);

        const buttons = await screen.findAllByRole("button", {
            name: /add investment/i,
        });
        await user.click(buttons[0]);

        await screen.findByRole("dialog");

        // portfolio.assetClass.stock = "Stock"
        expect(screen.getByText(/^stock$/i)).toBeInTheDocument();
    });

    it("Choose Asset Type dialog shows ETF asset class button", async () => {
        const user = userEvent.setup();
        renderWithApp(<PortfolioOverviewPage />);

        const buttons = await screen.findAllByRole("button", {
            name: /add investment/i,
        });
        await user.click(buttons[0]);

        await screen.findByRole("dialog");

        // portfolio.assetClass.etf = "ETF"
        expect(screen.getByText(/^etf$/i)).toBeInTheDocument();
    });

    it("clicking Stock in Choose Asset Type advances to details form", async () => {
        const user = userEvent.setup();
        renderWithApp(<PortfolioOverviewPage />);

        const buttons = await screen.findAllByRole("button", {
            name: /add investment/i,
        });
        await user.click(buttons[0]);

        await screen.findByRole("dialog");

        // Click the "Stock" asset type button (rendered as <button> by AssetTypeSelector)
        await user.click(screen.getByText(/^stock$/i));

        // After selecting asset type, dialog title changes to "Add Stock" (addInv.assetTitle)
        // and a "Back" button appears (addInv.back = "Back")
        expect(
            await screen.findByRole("button", { name: /^back$/i }),
        ).toBeInTheDocument();
    });

    it("shows empty state description text when no investments exist", async () => {
        renderWithApp(<PortfolioOverviewPage />);
        // portfolio.noInvestmentsDesc = "Add your first investment to start tracking stocks, ETFs, crypto..."
        expect(
            await screen.findByText(
                /add your first investment to start tracking/i,
            ),
        ).toBeInTheDocument();
    });

    it("shows Cryptocurrency asset type in Choose Asset Type dialog", async () => {
        const user = userEvent.setup();
        renderWithApp(<PortfolioOverviewPage />);

        const buttons = await screen.findAllByRole("button", {
            name: /add investment/i,
        });
        await user.click(buttons[0]);

        await screen.findByRole("dialog");

        // portfolio.assetClass.crypto = "Cryptocurrency" — may appear in label + description
        const matches = screen.getAllByText(/cryptocurrency/i);
        expect(matches.length).toBeGreaterThan(0);
    });

    it("renders empty state without crashing when investments API fails", async () => {
        server.use(
            http.get(`${API_BASE}/api/investments`, () =>
                err(500, "Server error"),
            ),
        );
        renderWithApp(<PortfolioOverviewPage />);
        expect(
            await screen.findByRole("heading", { name: /portfolio overview/i }),
        ).toBeInTheDocument();
        expect(
            await screen.findByRole("heading", { name: /no investments yet/i }),
        ).toBeInTheDocument();
    });

    it("still shows investment list when portfolio summary API fails", async () => {
        server.use(
            http.get(`${API_BASE}/api/investments`, () =>
                ok({
                    items: [INVESTMENT_STUB],
                    total: 1,
                    limit: 500,
                    offset: 0,
                    links: [],
                }),
            ),
            http.get(`${API_BASE}/api/investments/transactions`, () =>
                ok({ items: [], total: 0, limit: 1000, offset: 0, links: [] }),
            ),
            http.get(`${API_BASE}/api/info/portfolio-summary`, () =>
                err(500, "Server error"),
            ),
        );
        renderWithApp(<PortfolioOverviewPage />);
        expect(await screen.findByText(/msci world etf/i)).toBeInTheDocument();
        expect(
            screen.getByRole("combobox", {
                name: "Filter investments by broker",
            }),
        ).toBeDisabled();
        expect(
            await screen.findByText("Broker subtotals are unavailable."),
        ).toBeVisible();
        const investmentsCard = screen
            .getByRole("heading", { name: "All Investments" })
            .closest(".glass-thin") as HTMLElement;
        expect(
            within(investmentsCard).queryByText("Holdings"),
        ).not.toBeInTheDocument();
    });

    it("keeps the broker filter disabled while the summary is pending", async () => {
        let releaseSummary!: () => void;
        const pending = new Promise<void>((resolve) => {
            releaseSummary = resolve;
        });
        server.use(
            http.get(`${API_BASE}/api/investments`, () =>
                ok({
                    items: [INVESTMENT_STUB],
                    total: 1,
                    limit: 500,
                    offset: 0,
                    links: [],
                }),
            ),
            http.get(`${API_BASE}/api/info/portfolio-summary`, async () => {
                await pending;
                return err(500, "Server error");
            }),
        );

        renderWithApp(<PortfolioOverviewPage />);
        const filter = await screen.findByRole("combobox", {
            name: "Filter investments by broker",
        });
        expect(filter).toBeDisabled();
        expect(screen.getByText("Calculating broker subtotals…")).toBeVisible();

        releaseSummary();
        expect(
            await screen.findByText("Broker subtotals are unavailable."),
        ).toBeVisible();
    });

    it("shows the live-price as-of caption with the portfolio total", async () => {
        server.use(
            http.get(`${API_BASE}/api/investments`, () =>
                ok({
                    items: [INVESTMENT_STUB],
                    total: 1,
                    limit: 500,
                    offset: 0,
                    links: [],
                }),
            ),
        );

        renderWithApp(<PortfolioOverviewPage />);

        expect(await screen.findByText(/prices as of/i)).toBeInTheDocument();
    });

    it("filters instruments by exact server broker partitions and shows matching subtotals", async () => {
        const user = userEvent.setup();
        server.use(
            http.get(`${API_BASE}/api/investments`, () =>
                ok({
                    items: [
                        {
                            ...INVESTMENT_STUB,
                            id: 1,
                            name: "Fund A",
                            oversold: true,
                        },
                        { ...INVESTMENT_STUB, id: 2, name: "Fund B" },
                    ],
                    total: 2,
                    limit: 500,
                    offset: 0,
                    links: [],
                }),
            ),
            http.get(`${API_BASE}/api/investments/transactions`, () =>
                ok({ items: [], total: 0, limit: 1000, offset: 0, links: [] }),
            ),
            http.get(`${API_BASE}/api/accounts`, () =>
                ok({
                    items: [
                        { id: 10, name: "Broker A", display_name: "Broker A" },
                        { id: 20, name: "Broker B", display_name: "Broker B" },
                    ],
                    total: 2,
                    links: [],
                }),
            ),
            http.get(`${API_BASE}/api/info/portfolio-summary`, () =>
                ok({
                    currency: "EUR",
                    computed_at: "2026-09-08T00:00:00Z",
                    totals: {
                        totalPortfolioValue: 1200,
                        totalGainLoss: 120,
                        totalGain: 120,
                        totalInvested: 1080,
                        totalRealizedGain: 0,
                        totalUnrealizedGain: 120,
                        totalIncome: 0,
                        totalFees: 0,
                        totalTaxes: 0,
                        totalAssetGain: 120,
                        totalFxGain: 0,
                        totalReturnPct: 11.11,
                        usedFallbackRate: false,
                    },
                    summaries: [
                        {
                            id: 1,
                            name: "Fund A",
                            currency: "EUR",
                            originalCurrency: "EUR",
                            totalBuyCost: 630,
                            currentValue: 700,
                            gainLoss: 70,
                            gainLossPercent: 11.11,
                            fullyAssigned: true,
                            oversold: true,
                            byAccount: [
                                {
                                    account_id: 10,
                                    assignment: "account",
                                    contribution_kind: "position",
                                    oversold: false,
                                    currentValue: 700,
                                    totalInvested: 630,
                                    realizedGain: 0,
                                    unrealizedGain: 70,
                                    gainLoss: 70,
                                },
                                {
                                    account_id: 20,
                                    assignment: "account",
                                    contribution_kind: "position",
                                    oversold: true,
                                    currentValue: 0,
                                    totalInvested: 0,
                                    realizedGain: 0,
                                    unrealizedGain: 0,
                                    gainLoss: 0,
                                },
                            ],
                        },
                        {
                            id: 2,
                            name: "Fund B",
                            currency: "EUR",
                            originalCurrency: "EUR",
                            totalBuyCost: 450,
                            currentValue: 500,
                            gainLoss: 50,
                            gainLossPercent: 11.11,
                            fullyAssigned: true,
                            oversold: false,
                            byAccount: [
                                {
                                    account_id: 20,
                                    assignment: "account",
                                    contribution_kind: "position",
                                    oversold: false,
                                    currentValue: 450,
                                    totalInvested: 410,
                                    realizedGain: 0,
                                    unrealizedGain: 40,
                                    gainLoss: 40,
                                },
                                {
                                    account_id: null,
                                    assignment: "unassigned",
                                    contribution_kind: "non_position",
                                    oversold: false,
                                    currentValue: 50,
                                    totalInvested: 40,
                                    realizedGain: 0,
                                    unrealizedGain: 10,
                                    gainLoss: 10,
                                },
                                {
                                    account_id: 30,
                                    assignment: "account",
                                    contribution_kind: "non_position",
                                    oversold: false,
                                    currentValue: 25,
                                    totalInvested: 20,
                                    realizedGain: 5,
                                    unrealizedGain: 0,
                                    gainLoss: 5,
                                },
                            ],
                        },
                    ],
                    byAccount: [],
                }),
            ),
        );
        renderWithApp(<PortfolioOverviewPage />);

        expect(await screen.findByText("Fund A")).toBeInTheDocument();
        expect(screen.getByText("Fund B")).toBeInTheDocument();
        expect(screen.getByText("Oversold broker")).toBeInTheDocument();
        await user.click(
            screen.getByRole("combobox", {
                name: "Filter investments by broker",
            }),
        );
        await user.click(
            await screen.findByRole("option", { name: "Broker A" }),
        );

        expect(screen.getByText("Fund A")).toBeInTheDocument();
        expect(screen.queryByText("Fund B")).not.toBeInTheDocument();
        expect(screen.queryByText("Oversold broker")).not.toBeInTheDocument();
        const investmentsCard = screen
            .getByRole("heading", { name: "All Investments" })
            .closest(".glass-thin") as HTMLElement;
        expect(
            within(investmentsCard).getByText(/Holdings/).parentElement,
        ).toHaveTextContent(/700,00/);
        expect(
            within(investmentsCard).getByText(/Profit\/loss/).parentElement,
        ).toHaveTextContent(/\+70,00/);

        await user.click(
            screen.getByRole("combobox", {
                name: "Filter investments by broker",
            }),
        );
        await user.click(
            await screen.findByRole("option", { name: "Unassigned" }),
        );
        expect(screen.queryByText("Fund A")).not.toBeInTheDocument();
        expect(screen.getByText("Fund B")).toBeInTheDocument();
        expect(
            within(investmentsCard).getByText(/Holdings/).parentElement,
        ).toHaveTextContent(/50,00/);
        expect(
            within(investmentsCard).getByText(/Profit\/loss/).parentElement,
        ).toHaveTextContent(/\+10,00/);

        await user.click(
            screen.getByRole("combobox", {
                name: "Filter investments by broker",
            }),
        );
        await user.click(await screen.findByRole("option", { name: "#30" }));
        expect(screen.getByText("Fund B")).toBeInTheDocument();
        expect(
            within(investmentsCard).getByText(/Holdings/).parentElement,
        ).toHaveTextContent(/25,00/);
        expect(
            within(investmentsCard).getByText(/Profit\/loss/).parentElement,
        ).toHaveTextContent(/\+5,00/);
    });

    it("disables Refresh Prices button when offline", async () => {
        renderWithApp(<PortfolioOverviewPage />);
        const refreshBtn = await screen.findByRole("button", {
            name: /refresh prices/i,
        });

        await act(async () => {
            window.dispatchEvent(new Event("offline"));
        });

        expect(refreshBtn).toBeDisabled();
    });

    // ─── Edge cases ────────────────────────────────────────────────────────

    it("does not crash when investments endpoint returns 404", async () => {
        const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
        server.use(
            http.get(`${API_BASE}/api/investments`, () =>
                err(404, "Not found"),
            ),
        );
        const { container } = renderWithApp(<PortfolioOverviewPage />);
        await new Promise((r) => setTimeout(r, 200));
        expect(container.firstChild).toBeTruthy();
        errSpy.mockRestore();
    });
});
