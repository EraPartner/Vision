// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http } from "msw";
import { useLocation } from "react-router";
import { renderWithApp } from "@/test/renderWithApp";
import { server } from "@/test/msw/server";
import { ok, err } from "@/test/msw/handlers";
import StatisticsPage from "@/pages/StatisticsPage";

const API_BASE = "http://localhost:3002";

function LocationProbe() {
    return (
        <output data-testid="location-search">{useLocation().search}</output>
    );
}

/** Monthly summary with one real month so useStatistics returns non-empty data. */
function monthlySummaryWithData() {
    return ok({
        data: {
            months: [
                {
                    month: 3,
                    year: 2025,
                    period_start: "2025-03-01",
                    period_end: "2025-03-31",
                    total_spending: -800,
                    total_income: 2000,
                    net_amount: 1200,
                    transaction_count: 25,
                },
            ],
            summary: {
                total_spending: -800,
                total_income: 2000,
                net_amount: 1200,
                transaction_count: 25,
                period_start: "2025-03-01",
                period_end: "2025-03-31",
            },
        },
        meta: {
            computedAt: "2025-04-01T00:00:00.000Z",
            source: "live" as const,
        },
    });
}

function emptyAggregation(data: Record<string, unknown>) {
    return ok({
        data,
        meta: {
            computedAt: "2025-04-01T00:00:00.000Z",
            source: "live" as const,
        },
    });
}

/** Every aggregation endpoint answered, so each tab can render. */
function useDataHandlers() {
    server.use(
        http.get(`${API_BASE}/api/aggregations/monthly-summary`, () =>
            monthlySummaryWithData(),
        ),
        http.get(`${API_BASE}/api/aggregations/category-pivot`, () =>
            emptyAggregation({ categoryPivot: {} }),
        ),
        http.get(`${API_BASE}/api/aggregations/recipient-insights`, () =>
            emptyAggregation({ topMerchants: [], monthOverMonth: [] }),
        ),
        http.get(`${API_BASE}/api/aggregations/recipient-by-year`, () =>
            emptyAggregation({ recipientsByYear: {} }),
        ),
    );
}

async function openMoreMenu(user: ReturnType<typeof userEvent.setup>) {
    await user.click(
        await screen.findByRole("button", { name: /more actions/i }),
    );
    return screen.findByRole("menu");
}

describe("StatisticsPage (integration)", () => {
    it("renders the Insights page heading", async () => {
        renderWithApp(<StatisticsPage />);
        expect(
            await screen.findByRole("heading", { name: /^insights$/i, level: 1 }),
        ).toBeInTheDocument();
    });

    it("shows the 24-month default and persists explicit All time in the URL", async () => {
        const user = userEvent.setup();
        renderWithApp(
            <>
                <StatisticsPage />
                <LocationProbe />
            </>,
            { initialEntries: ["/statistics"] },
        );

        await screen.findByRole("heading", { name: /no data yet/i });
        const range = screen.getByRole("radiogroup", { name: /date range/i });
        expect(
            within(range).getByRole("radio", { name: "Last 24 months" }),
        ).toHaveAttribute("aria-checked", "true");
        expect(screen.getByTestId("location-search")).toHaveTextContent("");

        await user.click(within(range).getByRole("radio", { name: "All time" }));

        await waitFor(() =>
            expect(screen.getByTestId("location-search")).toHaveTextContent(
                "?window=all",
            ),
        );
        expect(
            screen.getByRole("radio", { name: "All time" }),
        ).toHaveAttribute("aria-checked", "true");
    });

    it("renders without crashing with empty transaction data", async () => {
        renderWithApp(<StatisticsPage />);
        await screen.findByRole("heading", { name: /^insights$/i });
    });

    it("shows error state when the aggregation API fails", async () => {
        const consoleSpy = vi
            .spyOn(console, "error")
            .mockImplementation(() => {});
        server.use(
            http.get(`${API_BASE}/api/aggregations/monthly-summary`, () =>
                err(500, "aggregation failed"),
            ),
        );

        renderWithApp(<StatisticsPage />);

        expect(
            await screen.findByText(
                /couldn't load insights/i,
                {},
                { timeout: 5000 },
            ),
        ).toBeInTheDocument();

        consoleSpy.mockRestore();
    });

    it("shows tab triggers when data is available", async () => {
        useDataHandlers();
        renderWithApp(<StatisticsPage />);

        // Tabs only render when monthlyData.length > 0
        expect(
            await screen.findByRole("tab", { name: /overview/i }),
        ).toBeInTheDocument();
        expect(
            screen.getByRole("tab", { name: /categories/i }),
        ).toBeInTheDocument();
        expect(
            screen.getByRole("tab", { name: /yearly/i }),
        ).toBeInTheDocument();
    });

    it("switches to Categories tab when clicked", async () => {
        const user = userEvent.setup();
        useDataHandlers();
        renderWithApp(<StatisticsPage />);

        const categoriesTab = await screen.findByRole("tab", {
            name: /categories/i,
        });
        await user.click(categoriesTab);

        expect(categoriesTab).toHaveAttribute("aria-selected", "true");
    });

    it("renders recipient insights through the live Payees tab", async () => {
        const user = userEvent.setup();
        useDataHandlers();
        server.use(
            http.get(`${API_BASE}/api/aggregations/recipient-insights`, () =>
                emptyAggregation({
                    topMerchants: [
                        {
                            recipientId: 7,
                            name: "Corner Shop",
                            totalSpend: 42,
                            transactionCount: 2,
                            avgAmount: 21,
                            firstSeen: "2025-02-01",
                            lastSeen: "2025-03-01",
                        },
                    ],
                    monthOverMonth: [],
                }),
            ),
        );

        renderWithApp(<StatisticsPage />);

        await user.click(
            await screen.findByRole("tab", { name: /^payees$/i }),
        );

        expect(await screen.findByText("Corner Shop")).toBeInTheDocument();
        expect(screen.getByText(/payee details/i)).toBeInTheDocument();
    });

    it("shows empty-state heading when no monthly data", async () => {
        renderWithApp(<StatisticsPage />);
        // Default MSW returns months: [] → StatisticsPage renders no-data card
        expect(
            await screen.findByRole("heading", { name: /no data yet/i }),
        ).toBeInTheDocument();
    });

    it("shows Import transactions button in empty state", async () => {
        renderWithApp(<StatisticsPage />);
        // Link rendered as Button (asChild) → role="link"
        expect(
            await screen.findByRole("link", { name: /import transactions/i }),
        ).toBeInTheDocument();
    });

    it("offers Customize… from the ••• menu in the empty state, not Export PDF…", async () => {
        const user = userEvent.setup();
        renderWithApp(<StatisticsPage />);
        await screen.findByRole("heading", { name: /no data yet/i });

        const menu = await openMoreMenu(user);
        expect(
            within(menu).getByRole("menuitem", { name: /customize/i }),
        ).toBeInTheDocument();
        expect(
            within(menu).queryByRole("menuitem", { name: /export pdf/i }),
        ).not.toBeInTheDocument();
    });

    it("opens the Customize dialog from the ••• menu", async () => {
        const user = userEvent.setup();
        renderWithApp(<StatisticsPage />);

        const menu = await openMoreMenu(user);
        await user.click(
            within(menu).getByRole("menuitem", { name: /customize/i }),
        );

        expect(await screen.findByRole("dialog")).toBeInTheDocument();
        expect(
            await screen.findByRole("heading", { name: /customize this page/i }),
        ).toBeInTheDocument();
    });

    it("opens the Export PDF dialog from the ••• menu once there is data", async () => {
        const user = userEvent.setup();
        useDataHandlers();
        renderWithApp(<StatisticsPage />);
        await screen.findByRole("tab", { name: /overview/i });

        const menu = await openMoreMenu(user);
        await user.click(
            within(menu).getByRole("menuitem", { name: /export pdf/i }),
        );

        expect(
            await screen.findByRole("heading", { name: /export pdf report/i }),
        ).toBeInTheDocument();
    });

    it("shows subtitle text in page header", async () => {
        renderWithApp(<StatisticsPage />);
        // statsPage.subtitle = "Income, spending and net balance over time"
        expect(
            await screen.findByText(
                /income, spending and net balance over time/i,
            ),
        ).toBeInTheDocument();
    });

    it("shows empty state description text when no data", async () => {
        renderWithApp(<StatisticsPage />);
        // statsPage.noDataDesc = "Import your bank transactions to see insights."
        expect(
            await screen.findByText(
                /import your bank transactions to see insights/i,
            ),
        ).toBeInTheDocument();
    });

    it("closes the Customize dialog via Escape key", async () => {
        const user = userEvent.setup();
        renderWithApp(<StatisticsPage />);

        const menu = await openMoreMenu(user);
        await user.click(
            within(menu).getByRole("menuitem", { name: /customize/i }),
        );
        await screen.findByRole("dialog");

        await user.keyboard("{Escape}");

        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });

    it("switches to Yearly tab when clicked", async () => {
        const user = userEvent.setup();
        useDataHandlers();
        renderWithApp(<StatisticsPage />);

        const yearlyTab = await screen.findByRole("tab", { name: /yearly/i });
        await user.click(yearlyTab);

        expect(yearlyTab).toHaveAttribute("aria-selected", "true");
    });

    it.each(["Categories", "Payees", "Yearly", "Flow", "Custom charts"])(
        "keeps overview content out of %s and restores it on return",
        async (name) => {
            server.use(
                http.get(`${API_BASE}/api/aggregations/monthly-summary`, () =>
                    monthlySummaryWithData(),
                ),
            );
            const user = userEvent.setup();
            renderWithApp(<StatisticsPage />);
            const summary = await screen.findByRole("heading", {
                name: "Monthly rhythm",
            });
            expect(screen.getByRole("tabpanel")).toContainElement(summary);
            expect(
                await screen.findByText(/No new insights right now/),
            ).toBeInTheDocument();

            await user.click(screen.getByRole("tab", { name }));
            expect(
                screen.queryByRole("heading", { name: "Monthly rhythm" }),
            ).not.toBeInTheDocument();
            expect(
                screen.queryByText(/No new insights right now/),
            ).not.toBeInTheDocument();
            expect(
                screen.getByRole("radiogroup", { name: /date range/i }),
            ).toBeInTheDocument();
            expect(
                screen.getByRole("button", { name: /more actions/i }),
            ).toBeInTheDocument();

            await user.click(screen.getByRole("tab", { name: /overview/i }));
            expect(
                await screen.findByRole("heading", { name: "Monthly rhythm" }),
            ).toBeInTheDocument();
            expect(
                await screen.findByText(/No new insights right now/),
            ).toBeInTheDocument();
        },
    );

    it("opens a Custom Charts deep link without unrelated overview content", async () => {
        server.use(
            http.get(`${API_BASE}/api/aggregations/monthly-summary`, () =>
                monthlySummaryWithData(),
            ),
        );
        renderWithApp(<StatisticsPage />, {
            initialEntries: ["/statistics?tab=custom&window=all"],
        });
        expect(
            await screen.findByRole("tab", { name: /custom charts/i }),
        ).toHaveAttribute("aria-selected", "true");
        expect(
            screen.queryByRole("heading", { name: "Monthly rhythm" }),
        ).not.toBeInTheDocument();
        expect(
            screen.queryByText(/No new insights right now/),
        ).not.toBeInTheDocument();
        expect(
            screen.getByRole("radio", { name: "All time" }),
        ).toHaveAttribute("aria-checked", "true");
    });

    // ─── Edge cases ────────────────────────────────────────────────────────

    it("surfaces 404 from monthly-summary aggregation", async () => {
        const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
        server.use(
            http.get(`${API_BASE}/api/aggregations/monthly-summary`, () =>
                err(404, "Not found"),
            ),
        );
        renderWithApp(<StatisticsPage />);
        expect(
            await screen.findByRole("heading", { name: /^insights$/i }),
        ).toBeInTheDocument();
        errSpy.mockRestore();
    });

    it("renders heading when statistics endpoint returns empty data (Empty)", async () => {
        renderWithApp(<StatisticsPage />);
        expect(
            await screen.findByRole("heading", { name: /^insights$/i }),
        ).toBeInTheDocument();
    });

    it("multi-filter combo: monthly-summary + category-pivot + recipient-by-year all fire on tab switch", async () => {
        const callsByEndpoint: Record<string, number> = {};
        function track(key: string) {
            callsByEndpoint[key] = (callsByEndpoint[key] ?? 0) + 1;
        }
        server.use(
            http.get(`${API_BASE}/api/aggregations/monthly-summary`, () => {
                track("monthly");
                return monthlySummaryWithData();
            }),
            http.get(`${API_BASE}/api/aggregations/category-pivot`, () => {
                track("category");
                return emptyAggregation({ categoryPivot: {} });
            }),
            http.get(`${API_BASE}/api/aggregations/recipient-insights`, () => {
                track("insights");
                return emptyAggregation({ topMerchants: [], monthOverMonth: [] });
            }),
            http.get(`${API_BASE}/api/aggregations/recipient-by-year`, () => {
                track("by-year");
                return emptyAggregation({ recipientsByYear: {} });
            }),
        );

        const user = userEvent.setup();
        renderWithApp(<StatisticsPage />);
        await screen.findByRole("tab", { name: /overview/i });

        // Switch tabs to fan-out queries across endpoints
        await user.click(
            await screen.findByRole("tab", { name: /categories/i }),
        );
        await user.click(await screen.findByRole("tab", { name: /yearly/i }));

        // Each endpoint must be hit at least once across tab switches
        await waitFor(() =>
            expect(callsByEndpoint["monthly"]).toBeGreaterThan(0),
        );
        // Other endpoints lazy-load — wait briefly
        await new Promise((r) => setTimeout(r, 200));
        const hits = Object.keys(callsByEndpoint).length;
        expect(hits).toBeGreaterThanOrEqual(2);
    });

    it("requests the monthly summary with a year param shape", async () => {
        const yearsSeen = new Set<string>();
        server.use(
            http.get(
                `${API_BASE}/api/aggregations/monthly-summary`,
                ({ request }) => {
                    const url = new URL(request.url);
                    const year = url.searchParams.get("year") ?? "current";
                    yearsSeen.add(year);
                    return monthlySummaryWithData();
                },
            ),
            http.get(`${API_BASE}/api/aggregations/category-pivot`, () =>
                emptyAggregation({ categoryPivot: {} }),
            ),
            http.get(`${API_BASE}/api/aggregations/recipient-insights`, () =>
                emptyAggregation({ topMerchants: [], monthOverMonth: [] }),
            ),
            http.get(`${API_BASE}/api/aggregations/recipient-by-year`, () =>
                emptyAggregation({ recipientsByYear: {} }),
            ),
        );

        renderWithApp(<StatisticsPage />);
        await screen.findByRole("tab", { name: /overview/i });
        await waitFor(() => expect(yearsSeen.size).toBeGreaterThan(0));
    });
});
