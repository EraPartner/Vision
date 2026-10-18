// @vitest-environment jsdom
import { expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http } from "msw";
import { server } from "@/test/msw/server";
import { ok, aggOk } from "@/test/msw/handlers";
import { renderWithApp } from "@/test/renderWithApp";
import DashboardPage from "../DashboardPage";

it("requests widget data only after its consumer is made visible", async () => {
    let transactions = 0;
    let monthly = 0;
    let count = 0;
    server.use(
        http.get("http://localhost:3002/api/settings/widget_visibility", () =>
            ok({
                key: "widget_visibility",
                expected: { exists: false },
                value: {
                    dashboard: Object.fromEntries(
                        [
                            "hero",
                            "attention",
                            "netWorth",
                            "upcoming",
                            "accounts",
                            "statCards",
                            "bankBalances",
                            "monthlyTrends",
                            "categoryPie",
                            "cashflowComparison",
                            "recentTransactions",
                        ].map((id) => [id, false]),
                    ),
                },
            }),
        ),
        http.get("http://localhost:3002/api/transactions", () => {
            transactions++;
            return ok({ items: [], total: 0, limit: 50, offset: 0, links: [] });
        }),
        http.get(
            "http://localhost:3002/api/aggregations/monthly-summary",
            () => {
                monthly++;
                return aggOk({
                    months: [],
                    summary: {
                        total_spending: 0,
                        total_income: 0,
                        net_amount: 0,
                        transaction_count: 0,
                        period_start: "",
                        period_end: "",
                    },
                });
            },
        ),
        http.get("http://localhost:3002/api/info/transaction-count", () => {
            count++;
            return ok({ count: 0 });
        }),
    );
    const user = userEvent.setup();
    renderWithApp(<DashboardPage />);
    await user.click(
        await screen.findByRole("button", { name: /more actions/i }),
    );
    await user.click(
        await screen.findByRole("menuitem", { name: /customize/i }),
    );
    expect(transactions).toBe(0);
    expect(monthly).toBe(0);
    expect(count).toBe(0);
    await user.click(
        await screen.findByRole("switch", { name: /recent transactions/i }),
    );
    await user.keyboard("{Escape}");
    await screen.findByText(/no transactions yet/i);
    expect(transactions).toBe(1);
    expect(monthly).toBe(0);
    expect(count).toBe(0);
    await user.click(screen.getByRole("button", { name: /more actions/i }));
    await user.click(
        await screen.findByRole("menuitem", { name: /customize/i }),
    );
    await user.click(
        await screen.findByRole("switch", { name: /summary cards/i }),
    );
    await waitFor(() => {
        expect(monthly).toBe(1);
        expect(count).toBe(1);
    });
});
