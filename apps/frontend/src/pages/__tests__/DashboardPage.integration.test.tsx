// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http } from "msw";
import { renderWithApp } from "@/test/renderWithApp";
import { server } from "@/test/msw/server";
import { aggOk, err, ok, TRANSACTION_STUB } from "@/test/msw/handlers";
import DashboardPage from "@/pages/DashboardPage";

const API_BASE = "http://localhost:3002";

/** Opens Customize… from the header's more-actions menu. */
async function openCustomize(user: ReturnType<typeof userEvent.setup>) {
    await user.click(await screen.findByRole("button", { name: /more actions/i }));
    await user.click(await screen.findByRole("menuitem", { name: /customize/i }));
    return screen.findByRole("dialog");
}

/**
 * The summary cards are off by default since the hero took over last month's
 * totals; switch them on through Customize… (the widget-visibility cache is
 * module-level, so the switch is read before toggling to stay idempotent).
 */
async function enableSummaryCards(user: ReturnType<typeof userEvent.setup>) {
    await openCustomize(user);
    const toggle = await screen.findByRole("switch", { name: /summary cards/i });
    if (toggle.getAttribute("aria-checked") !== "true") await user.click(toggle);
    await user.keyboard("{Escape}");
}

describe("DashboardPage (integration)", () => {
    it("renders page heading", async () => {
        renderWithApp(<DashboardPage />);
        // Heading is time-sensitive: "Good morning", "Good afternoon", or "Good evening"
        expect(
            await screen.findByRole("heading", {
                name: /good\s+(morning|afternoon|evening)/i,
            }),
        ).toBeInTheDocument();
    });

    it("plays the arrival animation only on the first dashboard visit", async () => {
        window.sessionStorage.clear();
        const first = renderWithApp(<DashboardPage />);
        await screen.findByRole("heading", {
            name: /good\s+(morning|afternoon|evening)/i,
        });
        expect(
            first.container.querySelector(".animate-stagger"),
        ).toBeInTheDocument();

        first.unmount();
        const returning = renderWithApp(<DashboardPage />);
        await screen.findByRole("heading", {
            name: /good\s+(morning|afternoon|evening)/i,
        });
        expect(
            returning.container.querySelector(".animate-stagger"),
        ).toBeNull();
    });

    it("renders without crashing when all data is empty", async () => {
        renderWithApp(<DashboardPage />);
        // Wait for heading to confirm full render
        await screen.findByRole("heading", {
            name: /good\s+(morning|afternoon|evening)/i,
        });
    });

    it("renders Recent Transactions section", async () => {
        renderWithApp(<DashboardPage />);
        expect(
            await screen.findByText(/recent transactions/i),
        ).toBeInTheDocument();
    });

    it("shows the more-actions menu and the Add transaction button in the header", async () => {
        renderWithApp(<DashboardPage />);
        expect(
            await screen.findByRole("button", { name: /more actions/i }),
        ).toBeInTheDocument();
        expect(
            screen.getByRole("button", { name: /add transaction/i }),
        ).toBeInTheDocument();
    });

    it("opens Manage Widgets from Customize… in the more-actions menu", async () => {
        const user = userEvent.setup();
        renderWithApp(<DashboardPage />);

        expect(await openCustomize(user)).toBeInTheDocument();
        expect(
            await screen.findByRole("heading", { name: /manage widgets/i }),
        ).toBeInTheDocument();
    });

    it("shows empty transactions message when no transactions exist", async () => {
        renderWithApp(<DashboardPage />);
        // MSW returns transactions: [] so DataTable shows emptyMessage
        expect(
            await screen.findByText(/no transactions yet/i),
        ).toBeInTheDocument();
    });

    it("shows the month-to-date hero, needs attention, net worth, upcoming and accounts", async () => {
        renderWithApp(<DashboardPage />);
        expect(
            await screen.findByText(/spent in .* so far/i),
        ).toBeInTheDocument();
        expect(screen.getByText(/nothing spent yet this month/i)).toBeInTheDocument();
        expect(
            await screen.findByText(/nothing needs attention/i),
        ).toBeInTheDocument();
        expect(screen.getByText(/^net worth$/i)).toBeInTheDocument();
        expect(
            await screen.findByText(/nothing due in the next 7 days/i),
        ).toBeInTheDocument();
        expect(await screen.findByText(/no accounts yet/i)).toBeInTheDocument();
        expect(screen.getByRole("link", { name: /all planned/i })).toHaveAttribute(
            "href",
            "/planned",
        );
        expect(screen.getByRole("link", { name: /^details$/i })).toHaveAttribute(
            "href",
            "/portfolio/net-worth",
        );
    });

    it("lists what needs attention with a link to settle each item", async () => {
        server.use(
            http.get(`${API_BASE}/api/transactions`, ({ request }) => {
                const params = new URL(request.url).searchParams;
                if (params.get("uncategorised") === "true")
                    return ok({ items: [TRANSACTION_STUB], total: 12, limit: 1, offset: 0, links: [] });
                return ok({ items: [], total: 0, limit: 50, offset: 0, links: [] });
            }),
        );
        renderWithApp(<DashboardPage />);
        const row = await screen.findByRole("link", {
            name: /12 transactions need a category/i,
        });
        expect(row).toHaveAttribute("href", "/transactions?uncategorised=true");
    });

    it("shows the Latest Month stat cards once Summary cards are switched on", async () => {
        const user = userEvent.setup();
        renderWithApp(<DashboardPage />);
        await enableSummaryCards(user);
        // dashboard.stat.lastMonthIncome = "Latest Month -- Income"
        expect(
            await screen.findByText(/latest month.*income/i),
        ).toBeInTheDocument();
        expect(
            await screen.findByText(/latest month.*spending/i),
        ).toBeInTheDocument();
    });

    it("shows the Recent transactions list with a See all link", async () => {
        renderWithApp(<DashboardPage />);
        const matches = await screen.findAllByText(/recent transactions/i);
        expect(matches.length).toBeGreaterThan(0);
        expect(screen.getByRole("link", { name: /see all/i })).toHaveAttribute(
            "href",
            "/transactions",
        );
    });

    it("shows Total Transactions stat card once Summary cards are switched on", async () => {
        const user = userEvent.setup();
        renderWithApp(<DashboardPage />);
        await enableSummaryCards(user);
        // dashboard.stat.totalTransactions = "Total Transactions"
        expect(
            await screen.findByText(/total transactions/i),
        ).toBeInTheDocument();
    });

    it("links stat cards to the exact transaction filters", async () => {
        server.use(
            http.get(`${API_BASE}/api/aggregations/monthly-summary`, () =>
                aggOk({
                    months: [
                        {
                            year: 2026,
                            month: 2,
                            total_income: 1000,
                            total_spending: -400,
                            transaction_count: 7,
                        },
                    ],
                    summary: {
                        total_spending: -400,
                        total_income: 1000,
                        net_amount: 600,
                        transaction_count: 7,
                        period_start: "2026-02-01",
                        period_end: "2026-02-28",
                    },
                }),
            ),
            http.get(`${API_BASE}/api/info/transaction-count`, () =>
                ok({ total_transactions: 77 }),
            ),
            http.get(`${API_BASE}/api/transactions`, () =>
                ok({
                    items: [
                        ...Array.from({ length: 6 }, (_, index) => ({
                            ...TRANSACTION_STUB,
                            id: index + 1,
                            category_id: index + 1,
                            category_name: `GROUP:CATEGORY ${index + 1}`,
                        })),
                        {
                            ...TRANSACTION_STUB,
                            id: 7,
                            category_id: null,
                            category_name: null,
                        },
                    ],
                    total: 7,
                    limit: 50,
                    offset: 0,
                    links: [],
                }),
            ),
        );

        const user = userEvent.setup();
        renderWithApp(<DashboardPage />);
        await enableSummaryCards(user);

        const income = await screen.findByRole("link", {
            name: /latest month.*income/i,
        });
        const incomeUrl = new URL(income.getAttribute("href")!, "http://test");
        expect(incomeUrl.pathname).toBe("/transactions");
        expect(incomeUrl.searchParams.get("start_date")).toBe("2026-02-01");
        expect(incomeUrl.searchParams.get("end_date")).toBe("2026-02-28");
        expect(incomeUrl.searchParams.get("transaction_type")).toBe("income");

        const spending = screen.getByRole("link", {
            name: /latest month.*spending/i,
        });
        const spendingUrl = new URL(
            spending.getAttribute("href")!,
            "http://test",
        );
        expect(spendingUrl.searchParams.get("start_date")).toBe("2026-02-01");
        expect(spendingUrl.searchParams.get("end_date")).toBe("2026-02-28");
        expect(spendingUrl.searchParams.get("transaction_type")).toBe(
            "expense",
        );
        expect(
            screen.getByRole("link", { name: /total transactions/i }),
        ).toHaveAttribute("href", "/transactions");
    });

    it("shows today's long date under the greeting", async () => {
        renderWithApp(<DashboardPage />);
        await screen.findByRole("heading", {
            name: /good\s+(morning|afternoon|evening)/i,
        });
        const expected = new Date().toLocaleDateString("en-US", {
            weekday: "long",
            day: "numeric",
            month: "long",
            year: "numeric",
        });
        expect(screen.getByText(expected)).toBeInTheDocument();
    });

    it("Manage Widgets dialog has Hide All button", async () => {
        const user = userEvent.setup();
        renderWithApp(<DashboardPage />);

        await openCustomize(user);

        // widgets.hideAll = "Hide All"
        expect(
            screen.getByRole("button", { name: /hide all/i }),
        ).toBeInTheDocument();
    });

    it("Manage Widgets dialog has Show All button", async () => {
        const user = userEvent.setup();
        renderWithApp(<DashboardPage />);

        await openCustomize(user);

        // widgets.showAll = "Show All"
        expect(
            screen.getByRole("button", { name: /show all/i }),
        ).toBeInTheDocument();
    });

    it("Manage Widgets dialog has Reset button", async () => {
        const user = userEvent.setup();
        renderWithApp(<DashboardPage />);

        await openCustomize(user);

        // widgets.reset = "Reset"
        expect(
            screen.getByRole("button", { name: /^reset$/i }),
        ).toBeInTheDocument();
    });

    it("closes Manage Widgets dialog via Escape key", async () => {
        const user = userEvent.setup();
        renderWithApp(<DashboardPage />);

        await openCustomize(user);

        await user.keyboard("{Escape}");

        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });

    it("Manage Widgets dialog lists at least one widget toggle", async () => {
        const user = userEvent.setup();
        renderWithApp(<DashboardPage />);

        await openCustomize(user);

        // WidgetVisibilityDialog renders widgets as Switch toggles
        const switches = screen.getAllByRole("switch");
        expect(switches.length).toBeGreaterThan(0);
    });

    it("shows full error state when stats API fails and no cached data exists", async () => {
        const consoleSpy = vi
            .spyOn(console, "error")
            .mockImplementation(() => {});
        server.use(
            http.get(`${API_BASE}/api/aggregations/monthly-summary`, () =>
                err(500, "db unavailable"),
            ),
            http.get(`${API_BASE}/api/info/transaction-count`, () =>
                err(500, "db unavailable"),
            ),
        );

        renderWithApp(<DashboardPage />);

        // partialError && !hasAnyData → renders errorLoading subtitle
        // dashboard.errorLoading = "Error loading dashboard: {msg}"
        expect(
            await screen.findByText(
                /error loading dashboard/i,
                {},
                { timeout: 5000 },
            ),
        ).toBeInTheDocument();
        expect(
            screen.getByRole("button", { name: /retry/i }),
        ).toBeInTheDocument();

        consoleSpy.mockRestore();
    });

    it("shows partial data warning when stats fail but transactions are available", async () => {
        const consoleSpy = vi
            .spyOn(console, "error")
            .mockImplementation(() => {});
        server.use(
            http.get(`${API_BASE}/api/aggregations/monthly-summary`, () =>
                err(500, "db unavailable"),
            ),
            http.get(`${API_BASE}/api/info/transaction-count`, () =>
                err(500, "db unavailable"),
            ),
            // Return one transaction so hasAnyData = true → partial warning path
            http.get(`${API_BASE}/api/transactions`, () =>
                ok({
                    items: [TRANSACTION_STUB],
                    total: 1,
                    limit: 50,
                    offset: 0,
                    links: [],
                }),
            ),
        );

        renderWithApp(<DashboardPage />);

        // partialError && hasAnyData → renders partialDataWarning banner
        // dashboard.partialDataWarning = "Some dashboard data could not be loaded..."
        expect(
            await screen.findByText(
                /some dashboard data could not be loaded/i,
                {},
                { timeout: 5000 },
            ),
        ).toBeInTheDocument();

        consoleSpy.mockRestore();
    });

    // ─── Edge cases ────────────────────────────────────────────────────────

    it("does not crash when the monthly-summary API returns 4xx", async () => {
        const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
        // (Was transaction-summary, a route Phase 9 deleted and the dashboard
        // never called. The dashboard's stat cards read monthly-summary.)
        server.use(
            http.get(`${API_BASE}/api/aggregations/monthly-summary`, () =>
                err(404, "Not found"),
            ),
        );
        const { container } = renderWithApp(<DashboardPage />);
        await new Promise((r) => setTimeout(r, 200));
        expect(container.firstChild).toBeTruthy();
        errSpy.mockRestore();
    });
});
