// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http } from "msw";
import { renderWithApp } from "@/test/renderWithApp";
import { server } from "@/test/msw/server";
import { err, ok, TRANSACTION_STUB } from "@/test/msw/handlers";
import DashboardPage from "@/pages/DashboardPage";

const API_BASE = "http://localhost:3002";

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

    it("shows Widgets button in page header", async () => {
        renderWithApp(<DashboardPage />);
        expect(
            await screen.findByRole("button", { name: /widgets/i }),
        ).toBeInTheDocument();
    });

    it("opens Manage Widgets dialog when Widgets button is clicked", async () => {
        const user = userEvent.setup();
        renderWithApp(<DashboardPage />);

        const widgetsButton = await screen.findByRole("button", { name: /widgets/i });
        await user.click(widgetsButton);

        expect(await screen.findByRole("dialog")).toBeInTheDocument();
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

    it("shows Last Month Income stat card", async () => {
        renderWithApp(<DashboardPage />);
        // dashboard.stat.lastMonthIncome = "Last Month -- Income"
        expect(
            await screen.findByText(/last month.*income/i),
        ).toBeInTheDocument();
    });

    it("shows Last Month Spending stat card", async () => {
        renderWithApp(<DashboardPage />);
        // dashboard.stat.lastMonthSpending = "Last Month -- Spending"
        expect(
            await screen.findByText(/last month.*spending/i),
        ).toBeInTheDocument();
    });

    it("shows Recent Transactions DataTable heading", async () => {
        renderWithApp(<DashboardPage />);
        // dashboard.recentTransactions widget — DataTable title is "Recent Transactions"
        const matches = await screen.findAllByText(/recent transactions/i);
        expect(matches.length).toBeGreaterThan(0);
    });

    it("shows Total Transactions stat card", async () => {
        renderWithApp(<DashboardPage />);
        // dashboard.stat.totalTransactions = "Total Transactions"
        expect(
            await screen.findByText(/total transactions/i),
        ).toBeInTheDocument();
    });

    it("shows subtitle text after full page load", async () => {
        renderWithApp(<DashboardPage />);
        // Wait for full load — greeting heading appears only after API + locale
        await screen.findByRole("heading", {
            name: /good\s+(morning|afternoon|evening)/i,
        });
        // dashboard.subtitle = "Overview of your finances"
        expect(
            screen.getByText(/overview of your finances/i),
        ).toBeInTheDocument();
    });

    it("Manage Widgets dialog has Hide All button", async () => {
        const user = userEvent.setup();
        renderWithApp(<DashboardPage />);

        await user.click(await screen.findByRole("button", { name: /widgets/i }));
        await screen.findByRole("dialog");

        // widgets.hideAll = "Hide All"
        expect(screen.getByRole("button", { name: /hide all/i })).toBeInTheDocument();
    });

    it("Manage Widgets dialog has Show All button", async () => {
        const user = userEvent.setup();
        renderWithApp(<DashboardPage />);

        await user.click(await screen.findByRole("button", { name: /widgets/i }));
        await screen.findByRole("dialog");

        // widgets.showAll = "Show All"
        expect(screen.getByRole("button", { name: /show all/i })).toBeInTheDocument();
    });

    it("Manage Widgets dialog has Reset button", async () => {
        const user = userEvent.setup();
        renderWithApp(<DashboardPage />);

        await user.click(await screen.findByRole("button", { name: /widgets/i }));
        await screen.findByRole("dialog");

        // widgets.reset = "Reset"
        expect(screen.getByRole("button", { name: /^reset$/i })).toBeInTheDocument();
    });

    it("closes Manage Widgets dialog via Escape key", async () => {
        const user = userEvent.setup();
        renderWithApp(<DashboardPage />);

        await user.click(await screen.findByRole("button", { name: /widgets/i }));
        await screen.findByRole("dialog");

        await user.keyboard("{Escape}");

        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });

    it("Manage Widgets dialog lists at least one widget toggle", async () => {
        const user = userEvent.setup();
        renderWithApp(<DashboardPage />);

        await user.click(await screen.findByRole("button", { name: /widgets/i }));
        await screen.findByRole("dialog");

        // WidgetVisibilityDialog renders widgets as Switch toggles
        const switches = screen.getAllByRole("switch");
        expect(switches.length).toBeGreaterThan(0);
    });

    it("shows full error state when stats API fails and no cached data exists", async () => {
        const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
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
            await screen.findByText(/error loading dashboard/i, {}, { timeout: 5000 }),
        ).toBeInTheDocument();

        consoleSpy.mockRestore();
    });

    it("shows partial data warning when stats fail but transactions are available", async () => {
        const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
        server.use(
            http.get(`${API_BASE}/api/aggregations/monthly-summary`, () =>
                err(500, "db unavailable"),
            ),
            http.get(`${API_BASE}/api/info/transaction-count`, () =>
                err(500, "db unavailable"),
            ),
            // Return one transaction so hasAnyData = true → partial warning path
            http.get(`${API_BASE}/api/transactions`, () =>
                ok({ items: [TRANSACTION_STUB], total: 1, limit: 50, offset: 0, links: [] }),
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
            http.get(`${API_BASE}/api/aggregations/monthly-summary`, () => err(404, "Not found")),
        );
        const { container } = renderWithApp(<DashboardPage />);
        await new Promise((r) => setTimeout(r, 200));
        expect(container.firstChild).toBeTruthy();
        errSpy.mockRestore();
    });
});
