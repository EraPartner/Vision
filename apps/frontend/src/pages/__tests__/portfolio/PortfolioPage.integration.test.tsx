// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { screen, act, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http } from "msw";
import { renderWithApp } from "@/test/renderWithApp";
import { server } from "@/test/msw/server";
import { ok, err, INVESTMENT_STUB } from "@/test/msw/handlers";
import PortfolioPage from "@/pages/portfolio/PortfolioPage";
import type { PortfolioSummaryResponse } from "@/lib/api/info";

const API_BASE = "http://localhost:3002";

const CANONICAL_INVESTMENT = {
    ...INVESTMENT_STUB,
    assetClass: "etf",
    originalCurrency: "EUR",
    totalUnits: 0,
    totalInvested: 0,
    totalBuyCost: 0,
    totalSellProceeds: 0,
    currentPrice: 95.5,
    currentValue: 0,
    totalFees: 0,
    totalTaxes: 0,
    totalDividends: 0,
    totalIncome: 0,
    avgCostBasis: 0,
    realizedGain: 0,
    unrealizedGain: 0,
    totalGain: 0,
    gainLoss: 0,
    gainLossPercent: 0,
    assetGain: 0,
    fxGain: 0,
    nativeCurrentValue: 0,
    usedFallbackRate: false,
    accruedInterest: 0,
    projectedAnnualInterest: 0,
    totalAppreciation: 0,
    fullyAssigned: true,
    oversold: false,
    byAccount: [],
};

const TOTALS = {
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
};

function snapshot(date: string, invested: number, value: number, extra = {}) {
    return {
        date,
        invested,
        value,
        stocks_etfs_value: value,
        crypto_value: 0,
        metals_value: 0,
        stocks_etfs_invested: invested,
        crypto_invested: 0,
        metals_invested: 0,
        inflation_adjusted_value: value * 0.98,
        gain_loss: value - invested,
        return_pct: invested > 0 ? ((value - invested) / invested) * 100 : 0,
        is_provisional: false,
        ...extra,
    };
}

const PERFORMANCE = {
    currency: "EUR",
    start_date: "2026-07-01",
    end_date: "2026-08-01",
    snapshots: [
        snapshot("2026-07-01", 1000, 1050),
        snapshot("2026-08-01", 1080, 1200, { is_provisional: true }),
    ],
    metrics: {
        currentValue: 1200,
        totalInvested: 1080,
        totalGainLoss: 120,
        totalReturnPct: 11.11,
        annualizedReturn: 8.5,
        realReturnPct: 9.1,
        cumulativeInflation: 2.2,
    },
    heatmap: {
        years: [2026],
        data: { 2026: [1.2, -0.5, 2.1, null, null, null, null, null, null, null, null, null] },
        maxAbsPct: 2.1,
    },
    breakdownSummary: [
        {
            id: 1,
            name: "Fund A",
            symbol: "IWDA",
            assetClass: "stocks_etfs",
            currency: "EUR",
            currentValue: 1200,
            totalInvested: 1080,
            gainLoss: 120,
            gainLossPercent: 11.11,
        },
    ],
    totals: TOTALS,
};

/** Two holdings across two brokers; Fund B also has unassigned and #30 rows. */
function useTwoHoldings(options: {
    performance?: unknown;
    cashFees?: PortfolioSummaryResponse["brokerageCashFees"];
} = {}) {
    server.use(
        http.get(`${API_BASE}/api/investments/exposure`, () =>
            err(503, "Exposure unavailable"),
        ),
        http.get(`${API_BASE}/api/investments`, () =>
            ok({
                items: [
                    { ...INVESTMENT_STUB, id: 1, name: "Fund A", oversold: true },
                    { ...INVESTMENT_STUB, id: 2, name: "Fund B", symbol: "VWCE" },
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
        http.get(`${API_BASE}/api/info/portfolio-performance`, () =>
            ok(options.performance ?? PERFORMANCE),
        ),
        http.get(`${API_BASE}/api/info/portfolio-performance/by-broker`, () =>
            ok({
                currency: "EUR",
                startDate: "2026-07-01",
                endDate: "2026-08-01",
                dates: [],
                series: [],
                rows: [],
            }),
        ),
        http.get(`${API_BASE}/api/info/portfolio-summary`, () =>
            ok({
                currency: "EUR",
                computed_at: "2026-09-08T00:00:00Z",
                totals: TOTALS,
                brokerageCashFees: options.cashFees,
                summaries: [
                    {
                        ...CANONICAL_INVESTMENT,
                        id: 1,
                        name: "Fund A",
                        totalBuyCost: 630,
                        currentValue: 700,
                        gainLoss: 70,
                        gainLossPercent: 11.11,
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
                        ...CANONICAL_INVESTMENT,
                        id: 2,
                        name: "Fund B",
                        symbol: "VWCE",
                        totalBuyCost: 450,
                        currentValue: 500,
                        gainLoss: 50,
                        gainLossPercent: 12.5,
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
}

async function findHoldingsCard() {
    const heading = await screen.findByRole("heading", { name: "Holdings" });
    return heading.closest(".glass-thin") as HTMLElement;
}

describe("PortfolioPage (integration)", () => {
    // ─── Header ────────────────────────────────────────────────────────────
    it("renders the page heading", async () => {
        renderWithApp(<PortfolioPage />);
        expect(
            await screen.findByRole("heading", { name: /^portfolio$/i, level: 1 }),
        ).toBeInTheDocument();
    });

    it("renders the empty state and an Add investment action when there are no investments", async () => {
        renderWithApp(<PortfolioPage />);
        expect(
            await screen.findByRole("heading", { name: /no investments yet/i }),
        ).toBeInTheDocument();
        expect(
            screen.getByText(/add your first investment to start tracking/i),
        ).toBeInTheDocument();
        const buttons = screen.getAllByRole("button", { name: /add investment/i });
        expect(buttons.length).toBeGreaterThan(0);
    });

    it("opens the Choose asset type dialog from Add investment and closes it with Escape", async () => {
        const user = userEvent.setup();
        renderWithApp(<PortfolioPage />);
        const [button] = await screen.findAllByRole("button", {
            name: /add investment/i,
        });
        await user.click(button);
        expect(
            await screen.findByRole("heading", { name: /choose asset type/i }),
        ).toBeInTheDocument();
        expect(screen.getByText(/^stock$/i)).toBeInTheDocument();
        expect(screen.getByText(/^etf$/i)).toBeInTheDocument();
        await user.click(screen.getByText(/^stock$/i));
        expect(
            await screen.findByRole("button", { name: /^back$/i }),
        ).toBeInTheDocument();
        await user.keyboard("{Escape}");
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });

    it("exposes Refresh prices as a header icon button that is disabled offline", async () => {
        renderWithApp(<PortfolioPage />);
        const refresh = await screen.findByRole("button", {
            name: /refresh prices/i,
        });
        expect(refresh).toBeEnabled();
        await act(async () => {
            window.dispatchEvent(new Event("offline"));
        });
        expect(refresh).toBeDisabled();
        // React Query pauses every later fetch while the window is offline.
        await act(async () => {
            window.dispatchEvent(new Event("online"));
        });
        expect(refresh).toBeEnabled();
    });

    it("offers Export PDF, Customize and Import portfolio history from the More actions menu", async () => {
        const user = userEvent.setup();
        renderWithApp(<PortfolioPage />);
        await user.click(
            await screen.findByRole("button", { name: /more actions/i }),
        );
        expect(
            await screen.findByRole("menuitem", { name: /export pdf/i }),
        ).toBeInTheDocument();
        expect(
            screen.getByRole("menuitem", { name: /import portfolio history/i }),
        ).toBeInTheDocument();
        await user.click(screen.getByRole("menuitem", { name: /customize/i }));
        expect(
            await screen.findByRole("heading", { name: /customize this page/i }),
        ).toBeInTheDocument();
        expect(screen.getByText("Holdings")).toBeInTheDocument();
        expect(screen.getByText("Archived investments")).toBeInTheDocument();
        await user.keyboard("{Escape}");
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

        await user.click(screen.getByRole("button", { name: /more actions/i }));
        await user.click(
            await screen.findByRole("menuitem", { name: /export pdf/i }),
        );
        expect(
            await screen.findByRole("heading", { name: /export pdf report/i }),
        ).toBeInTheDocument();
    });

    // ─── Error and loading states ─────────────────────────────────────────
    it("shows the page error instead of an empty portfolio when the investments API fails", async () => {
        server.use(
            http.get(`${API_BASE}/api/investments`, () =>
                err(500, "Server error"),
            ),
        );
        renderWithApp(<PortfolioPage />);
        expect(
            await screen.findByRole("heading", { name: /^portfolio$/i, level: 1 }),
        ).toBeInTheDocument();
        expect(await screen.findByText("Server error")).toBeVisible();
        expect(
            screen.queryByRole("heading", { name: /no investments yet/i }),
        ).not.toBeInTheDocument();
    });

    it("shows a canonical summary error without invented holdings when the summary API fails", async () => {
        server.use(
            http.get(`${API_BASE}/api/investments`, () =>
                ok({ items: [INVESTMENT_STUB], total: 1, limit: 500, offset: 0, links: [] }),
            ),
            http.get(`${API_BASE}/api/info/portfolio-summary`, () =>
                err(500, "Server error"),
            ),
        );
        renderWithApp(<PortfolioPage />);
        expect(await screen.findByText("Server error")).toBeVisible();
        expect(screen.queryByText(/msci world etf/i)).not.toBeInTheDocument();
        expect(
            screen.queryByRole("heading", { name: /no investments yet/i }),
        ).not.toBeInTheDocument();
    });

    it("shows loading instead of a false empty portfolio while the summary is pending", async () => {
        let releaseSummary!: () => void;
        const pending = new Promise<void>((resolve) => {
            releaseSummary = resolve;
        });
        let requested = false;
        server.use(
            http.get(`${API_BASE}/api/investments`, () =>
                ok({ items: [INVESTMENT_STUB], total: 1, limit: 500, offset: 0, links: [] }),
            ),
            http.get(`${API_BASE}/api/info/portfolio-summary`, async () => {
                requested = true;
                await pending;
                return err(500, "Server error");
            }),
        );
        renderWithApp(<PortfolioPage />);
        await waitFor(() => expect(requested).toBe(true));
        expect(
            screen.queryByRole("combobox", { name: "Filter investments by broker" }),
        ).not.toBeInTheDocument();
        expect(
            screen.queryByRole("heading", { name: /no investments yet/i }),
        ).not.toBeInTheDocument();
        releaseSummary();
        expect(await screen.findByText("Server error")).toBeVisible();
    });

    it("does not crash when the investments endpoint returns 404", async () => {
        const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
        server.use(
            http.get(`${API_BASE}/api/investments`, () => err(404, "Not found")),
        );
        const { container } = renderWithApp(<PortfolioPage />);
        await new Promise((r) => setTimeout(r, 200));
        expect(container.firstChild).toBeTruthy();
        errSpy.mockRestore();
    });

    it("keeps the holdings when the performance endpoint fails", async () => {
        const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
        useTwoHoldings();
        server.use(
            http.get(`${API_BASE}/api/info/portfolio-performance`, () =>
                err(404, "Not found"),
            ),
        );
        renderWithApp(<PortfolioPage />);
        const holdings = await findHoldingsCard();
        expect(within(holdings).getByText("Fund A")).toBeInTheDocument();
        expect(await screen.findByText(/couldn't load/i)).toBeInTheDocument();
        errSpy.mockRestore();
    }, 20_000);

    // ─── Hero ─────────────────────────────────────────────────────────────
    it("shows the investment count and live-price caption in the subtitle", async () => {
        server.use(
            http.get(`${API_BASE}/api/investments`, () =>
                ok({ items: [INVESTMENT_STUB], total: 1, limit: 500, offset: 0, links: [] }),
            ),
            http.get(`${API_BASE}/api/info/portfolio-summary`, () =>
                ok({
                    currency: "EUR",
                    computed_at: "2025-01-15T10:00:00Z",
                    totals: {},
                    byAccount: [],
                    summaries: [CANONICAL_INVESTMENT],
                }),
            ),
        );
        renderWithApp(<PortfolioPage />);
        expect(
            await screen.findByText(/1 investment · Prices as of/i),
        ).toBeInTheDocument();
    });

    it("renders the hero value, the all-time gain, the period picker and the provisional note", async () => {
        useTwoHoldings();
        renderWithApp(<PortfolioPage />);
        const hero = (
            await screen.findByText("Value", { selector: ".eyebrow" })
        ).closest(".premium-frame") as HTMLElement;
        expect(hero).toHaveTextContent(/1[.\s]?200,00/);
        expect(hero).toHaveTextContent(/\+120,00/);
        expect(hero).toHaveTextContent(/\+11,1\s?%/);
        expect(hero).toHaveTextContent(/all time/);
        expect(
            within(hero).getByRole("radio", { name: "All time" }),
        ).toHaveAttribute("aria-checked", "true");
        expect(await within(hero).findByRole("note")).toHaveTextContent(
            "Today's value may still change",
        );
    }, 20_000);

    it("hydrates the period and FX-neutral state from the URL and recomputes the period gain", async () => {
        const user = userEvent.setup();
        const requestedPeriods: string[] = [];
        useTwoHoldings({
            performance: {
                ...PERFORMANCE,
                snapshots: [
                    snapshot("2026-07-01", 1000, 1050, { value_fx_neutral: 1040 }),
                    snapshot("2026-08-01", 1080, 1200, { value_fx_neutral: 1180 }),
                ],
            },
        });
        server.use(
            http.get(`${API_BASE}/api/info/portfolio-performance`, ({ request }) => {
                requestedPeriods.push(
                    new URL(request.url).searchParams.get("period") ?? "",
                );
                return ok({
                    ...PERFORMANCE,
                    snapshots: [
                        snapshot("2026-07-01", 1000, 1050, { value_fx_neutral: 1040 }),
                        snapshot("2026-08-01", 1080, 1200, { value_fx_neutral: 1180 }),
                    ],
                });
            }),
        );
        renderWithApp(<PortfolioPage />, {
            initialEntries: ["/portfolio?period=3m&fx_neutral=true"],
        });
        const picker = await screen.findByRole("radiogroup", { name: "Period" });
        expect(
            within(picker).getByRole("radio", { name: "3 months" }),
        ).toHaveAttribute("aria-checked", "true");
        await waitFor(() => expect(requestedPeriods).toContain("3m"));
        // Period gain = (1200 − 1050) − (1080 − 1000) = +70 on a 1 080 base.
        const hero = picker.closest(".premium-frame") as HTMLElement;
        expect(hero).toHaveTextContent(/\+70,00/);
        expect(hero).toHaveTextContent(/in the last 3 months/);
        expect(
            await screen.findByRole("switch", { name: /without currency effects/i }),
        ).toBeChecked();

        await user.click(within(picker).getByRole("radio", { name: "1 year" }));
        await waitFor(() => expect(requestedPeriods).toContain("1y"));
        expect(hero).toHaveTextContent(/in the last 1 year/);
    }, 20_000);

    it("shows the no-history state with a Refresh prices action when there are holdings but no snapshots", async () => {
        useTwoHoldings({
            performance: { ...PERFORMANCE, snapshots: [], metrics: null },
        });
        renderWithApp(<PortfolioPage />);
        expect(
            await screen.findByRole("heading", { name: /no performance history yet/i }),
        ).toBeInTheDocument();
        expect(
            screen.getByText(/refresh investment prices to create the first snapshot/i),
        ).toBeInTheDocument();
        const refreshButtons = screen.getAllByRole("button", { name: /refresh prices/i });
        expect(refreshButtons.length).toBeGreaterThanOrEqual(2);
        expect(screen.queryByText("Portfolio value over time")).not.toBeInTheDocument();
    }, 20_000);

    // ─── Return figures ───────────────────────────────────────────────────
    it("presents the four return figures with their explanations", async () => {
        const user = userEvent.setup();
        useTwoHoldings();
        renderWithApp(<PortfolioPage />);
        const figures = within(
            (await screen.findByText("Per year")).closest(".glass-thin") as HTMLElement,
        );
        const figure = (label: string) =>
            figures.getByText(label).closest("div")!.parentElement as HTMLElement;
        const totalReturn = figure("Investment return");
        expect(totalReturn).toHaveTextContent(/\+11,1\s?%/);
        expect(totalReturn).toHaveTextContent(/\+120,00/);
        const perYear = figure("Per year");
        expect(perYear).toHaveTextContent(/\+8,5\s?%/);
        expect(perYear).toHaveTextContent(/since/i);
        const afterInflation = figure("After inflation");
        expect(afterInflation).toHaveTextContent(/\+9,1\s?%/);
        expect(afterInflation).toHaveTextContent(/Cumulative inflation: 2,2\s?%/);
        const realized = figure("Realized");
        expect(realized).toHaveTextContent("—");
        expect(realized).toHaveTextContent("No sales yet");

        await user.click(screen.getByRole("button", { name: "About Investment return" }));
        expect(
            await screen.findByText(/separate broker account fees appear in the breakdown below/i),
        ).toBeInTheDocument();
    }, 20_000);

    it("shows a dash and the missing-inflation reason when there is no inflation data", async () => {
        useTwoHoldings({
            performance: {
                ...PERFORMANCE,
                metrics: { ...PERFORMANCE.metrics, cumulativeInflation: 0 },
            },
        });
        renderWithApp(<PortfolioPage />);
        const figures = within(
            (await screen.findByText("Per year")).closest(".glass-thin") as HTMLElement,
        );
        const afterInflation = figures.getByText("After inflation").closest("div")!
            .parentElement as HTMLElement;
        expect(afterInflation).toHaveTextContent("—");
        expect(afterInflation).toHaveTextContent("Inflation data missing");
    }, 20_000);

    // ─── Holdings ─────────────────────────────────────────────────────────
    it("lists holdings as rows with class, symbol, value, return and the oversold badge, sorted by value", async () => {
        useTwoHoldings();
        renderWithApp(<PortfolioPage />);
        const holdings = await findHoldingsCard();
        const rows = within(holdings).getAllByRole("button", { name: /^Details: / });
        expect(rows.map((row) => row.getAttribute("aria-label"))).toEqual([
            "Details: Fund A",
            "Details: Fund B",
        ]);
        expect(rows[1]).toHaveTextContent("ETF · VWCE");
        expect(rows[0]).toHaveTextContent(/700,00/);
        expect(rows[0]).toHaveTextContent(/\+70,00 € \(\+11,1\s?%\)/);
        expect(within(holdings).getByText("Oversold broker")).toBeInTheDocument();
        expect(holdings).toHaveTextContent(/Holdings\s*1[.\s]?200,00/);
        expect(holdings).toHaveTextContent(/Profit or loss\s*\+120,00/);
    }, 20_000);

    it("sorts holdings by return from the segmented control", async () => {
        const user = userEvent.setup();
        useTwoHoldings();
        renderWithApp(<PortfolioPage />);
        const holdings = await findHoldingsCard();
        await user.click(within(holdings).getByRole("radio", { name: "Return" }));
        const rows = within(holdings).getAllByRole("button", { name: /^Details: / });
        expect(rows.map((row) => row.getAttribute("aria-label"))).toEqual([
            "Details: Fund B",
            "Details: Fund A",
        ]);
    }, 20_000);

    it("filters holdings by exact server broker partitions and shows matching subtotals", async () => {
        const user = userEvent.setup();
        useTwoHoldings();
        renderWithApp(<PortfolioPage />);
        const holdings = await findHoldingsCard();
        const listed = within(holdings);
        expect(listed.getByText("Fund A")).toBeInTheDocument();
        expect(listed.getByText("Fund B")).toBeInTheDocument();

        await user.click(
            screen.getByRole("combobox", { name: "Filter investments by broker" }),
        );
        await user.click(await screen.findByRole("option", { name: "Broker A" }));
        expect(listed.getByText("Fund A")).toBeInTheDocument();
        expect(listed.queryByText("Fund B")).not.toBeInTheDocument();
        expect(listed.queryByText("Oversold broker")).not.toBeInTheDocument();
        expect(holdings).toHaveTextContent(/Holdings\s*700,00/);
        expect(holdings).toHaveTextContent(/Profit or loss\s*\+70,00/);

        await user.click(
            screen.getByRole("combobox", { name: "Filter investments by broker" }),
        );
        await user.click(await screen.findByRole("option", { name: "Unassigned" }));
        expect(listed.queryByText("Fund A")).not.toBeInTheDocument();
        expect(listed.getByText("Fund B")).toBeInTheDocument();
        expect(holdings).toHaveTextContent(/Holdings\s*50,00/);
        expect(holdings).toHaveTextContent(/Profit or loss\s*\+10,00/);

        await user.click(
            screen.getByRole("combobox", { name: "Filter investments by broker" }),
        );
        await user.click(await screen.findByRole("option", { name: "#30" }));
        expect(listed.getByText("Fund B")).toBeInTheDocument();
        expect(holdings).toHaveTextContent(/Holdings\s*25,00/);
        expect(holdings).toHaveTextContent(/Profit or loss\s*\+5,00/);
    }, 20_000);

    it("opens the investment details from the row and from the row menu", async () => {
        const user = userEvent.setup();
        useTwoHoldings();
        renderWithApp(<PortfolioPage />);
        const holdings = await findHoldingsCard();
        await user.click(within(holdings).getByRole("button", { name: "Details: Fund A" }));
        const dialog = await screen.findByRole("dialog");
        expect(within(dialog).getAllByText("Fund A").length).toBeGreaterThan(0);
        await user.keyboard("{Escape}");
        await waitFor(() =>
            expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
        );

        await user.click(within(holdings).getByRole("button", { name: "Actions for Fund B" }));
        await user.click(await screen.findByRole("menuitem", { name: "Details" }));
        const second = await screen.findByRole("dialog");
        expect(within(second).getAllByText("Fund B").length).toBeGreaterThan(0);
    }, 20_000);

    it("opens Add transaction for a holding from the row menu", async () => {
        const user = userEvent.setup();
        useTwoHoldings();
        renderWithApp(<PortfolioPage />);
        const holdings = await findHoldingsCard();
        await user.click(within(holdings).getByRole("button", { name: "Actions for Fund A" }));
        await user.click(await screen.findByRole("menuitem", { name: "Add transaction" }));
        const dialog = await screen.findByRole("dialog");
        // addPortTxn.title names the holding's symbol (IWDA for the stub).
        expect(within(dialog).getByRole("heading", { name: /IWDA/ })).toBeInTheDocument();
    }, 20_000);

    it("archives a holding after confirmation", async () => {
        const user = userEvent.setup();
        const patches: Array<{ id: string; body: unknown }> = [];
        useTwoHoldings();
        server.use(
            http.patch(`${API_BASE}/api/investments/:id`, async ({ params, request }) => {
                patches.push({ id: String(params.id), body: await request.json() });
                return ok({ ...INVESTMENT_STUB, id: Number(params.id), is_active: false });
            }),
        );
        renderWithApp(<PortfolioPage />);
        const holdings = await findHoldingsCard();
        await user.click(within(holdings).getByRole("button", { name: "Actions for Fund A" }));
        await user.click(await screen.findByRole("menuitem", { name: "Archive investment" }));
        const confirmDialog = await screen.findByRole("alertdialog");
        expect(confirmDialog).toHaveTextContent(/Archive "Fund A"\?/);
        await user.click(within(confirmDialog).getByRole("button", { name: "Archive investment" }));
        await waitFor(() =>
            expect(patches).toEqual([{ id: "1", body: { is_active: false } }]),
        );
    }, 20_000);

    it("deletes a holding after a destructive confirmation", async () => {
        const user = userEvent.setup();
        const deleted: string[] = [];
        useTwoHoldings();
        server.use(
            http.delete(`${API_BASE}/api/investments/:id`, ({ params }) => {
                deleted.push(String(params.id));
                return new Response(null, { status: 204 });
            }),
        );
        renderWithApp(<PortfolioPage />);
        const holdings = await findHoldingsCard();
        await user.click(within(holdings).getByRole("button", { name: "Actions for Fund B" }));
        await user.click(await screen.findByRole("menuitem", { name: "Delete investment" }));
        const confirmDialog = await screen.findByRole("alertdialog");
        expect(confirmDialog).toHaveTextContent(/Delete "Fund B"\?/);
        await user.click(within(confirmDialog).getByRole("button", { name: "Delete" }));
        await waitFor(() => expect(deleted).toEqual(["2"]));
    }, 20_000);

    // ─── Allocation, breakdown, charts, archived ──────────────────────────
    it("renders the allocation bar legend with amounts and shares plus the Rebalance link", async () => {
        useTwoHoldings();
        renderWithApp(<PortfolioPage />);
        const card = (await screen.findByRole("heading", { name: "Asset allocation" })).closest(
            ".glass-thin",
        ) as HTMLElement;
        expect(within(card).getByRole("img", { name: /allocation by asset class/i })).toBeInTheDocument();
        expect(card).toHaveTextContent(/Stocks & ETFs/);
        expect(card).toHaveTextContent(/1[.\s]?200,00/);
        expect(card).toHaveTextContent(/100\s?%/);
        expect(within(card).getByRole("link", { name: "Rebalance" })).toHaveAttribute(
            "href",
            "/portfolio/rebalance",
        );
    }, 20_000);

    it("shows account fees and gain after fees without changing investment return", async () => {
        useTwoHoldings({ cashFees: {
            total: 10,
            gainAfterFees: 110,
            usedFallbackRate: false,
            byAccount: [{ account_id: 10, total: 10 }],
        } });
        renderWithApp(<PortfolioPage />);
        const card = (await screen.findByRole("heading", { name: "Gains, income and costs" })).closest(
            ".glass-thin",
        ) as HTMLElement;
        expect(card).toHaveTextContent(/Broker account fees\s*-10,00/);
        expect(card).toHaveTextContent(/Gain after account fees\s*\+110,00/);
        const figures = within(
            (await screen.findByText("Per year")).closest(".glass-thin") as HTMLElement,
        );
        const investmentReturn = figures.getByText("Investment return").closest("div")!
            .parentElement as HTMLElement;
        expect(investmentReturn).toHaveTextContent(/\+120,00/);
        expect(card).toHaveTextContent(/Unrealized gains\s*\+120,00/);
    }, 20_000);

    it("keeps the gains, income and costs breakdown and the period charts", async () => {
        useTwoHoldings();
        renderWithApp(<PortfolioPage />);
        const card = (await screen.findByRole("heading", { name: "Gains, income and costs" })).closest(
            ".glass-thin",
        ) as HTMLElement;
        expect(card).toHaveTextContent(/Total invested\s*1[.\s]?080,00/);
        expect(card).toHaveTextContent(/Unrealized gains\s*\+120,00/);
        expect(card).toHaveTextContent(/Total fees/);
        expect(within(card).queryByText("Broker account fees")).not.toBeInTheDocument();
        expect(
            await screen.findByRole("heading", { name: "Portfolio value over time" }),
        ).toBeInTheDocument();
        expect(screen.getByText(/Value before and after inflation \(All time\)/)).toBeInTheDocument();
        expect(screen.getByRole("heading", { name: "Relative performance" })).toBeInTheDocument();
        expect(screen.getByRole("heading", { name: "Monthly returns" })).toBeInTheDocument();
    }, 20_000);

    it("lists archived investments and restores one", async () => {
        const user = userEvent.setup();
        const patches: Array<{ id: string; body: unknown }> = [];
        useTwoHoldings();
        server.use(
            http.get(`${API_BASE}/api/investments`, () =>
                ok({
                    items: [
                        { ...INVESTMENT_STUB, id: 1, name: "Fund A" },
                        { ...INVESTMENT_STUB, id: 2, name: "Fund B", symbol: "VWCE" },
                        { ...INVESTMENT_STUB, id: 3, name: "Old Fund", is_active: false },
                    ],
                    total: 3,
                    limit: 500,
                    offset: 0,
                    links: [],
                }),
            ),
            http.patch(`${API_BASE}/api/investments/:id`, async ({ params, request }) => {
                patches.push({ id: String(params.id), body: await request.json() });
                return ok({ ...INVESTMENT_STUB, id: Number(params.id) });
            }),
        );
        renderWithApp(<PortfolioPage />);
        await user.click(
            await screen.findByRole("button", { name: /archived investments/i }),
        );
        expect(await screen.findByText("Old Fund")).toBeInTheDocument();
        await user.click(screen.getByRole("button", { name: "Restore" }));
        await waitFor(() =>
            expect(patches).toEqual([{ id: "3", body: { is_active: true } }]),
        );
    }, 20_000);
});
