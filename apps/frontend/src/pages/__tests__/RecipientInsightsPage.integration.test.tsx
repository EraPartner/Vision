// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import { http } from "msw";
import { renderWithApp } from "@/test/renderWithApp";
import { server } from "@/test/msw/server";
import { err, ok } from "@/test/msw/handlers";
import RecipientInsightsPage from "@/pages/RecipientInsightsPage";

const API_BASE = "http://localhost:3002";

describe("RecipientInsightsPage (integration)", () => {
    it("renders page heading", async () => {
        renderWithApp(<RecipientInsightsPage />);
        expect(
            await screen.findByRole("heading", { name: /recipient insights/i }),
        ).toBeInTheDocument();
    });

    it("renders Recipient Details table section after data loads", async () => {
        renderWithApp(<RecipientInsightsPage />);
        // VirtualDataTable title rendered as h3 heading; use role to avoid matching
        // the empty-state message "No recipient details available."
        expect(
            await screen.findByRole("heading", { name: /^recipient details$/i }),
        ).toBeInTheDocument();
    });

    it("renders Top 10 Recipients by Spend card heading", async () => {
        renderWithApp(<RecipientInsightsPage />);
        // CardTitle rendered inside Card — findByText covers it
        expect(
            await screen.findByText(/top 10 recipients by spend/i),
        ).toBeInTheDocument();
    });

    it("renders Top Recipient KPI card label", async () => {
        renderWithApp(<RecipientInsightsPage />);
        expect(
            await screen.findByText(/top recipient/i),
        ).toBeInTheDocument();
    });

    it("renders Top 10 Total KPI card label", async () => {
        renderWithApp(<RecipientInsightsPage />);
        expect(
            await screen.findByText(/top 10 total/i),
        ).toBeInTheDocument();
    });

    it("renders Avg Transaction KPI card label", async () => {
        renderWithApp(<RecipientInsightsPage />);
        expect(
            await screen.findByText(/avg transaction/i),
        ).toBeInTheDocument();
    });

    it("shows error message when recipient insights API fails", async () => {
        const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
        server.use(
            http.get(`${API_BASE}/api/aggregations/recipient-insights`, () =>
                err(500, "insights unavailable"),
            ),
        );

        renderWithApp(<RecipientInsightsPage />);

        expect(
            await screen.findByText(/failed to load recipient insights/i, {}, { timeout: 5000 }),
        ).toBeInTheDocument();

        consoleSpy.mockRestore();
    });

    it("still renders heading in error state", async () => {
        const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
        server.use(
            http.get(`${API_BASE}/api/aggregations/recipient-insights`, () =>
                err(500, "insights unavailable"),
            ),
        );

        renderWithApp(<RecipientInsightsPage />);

        expect(
            await screen.findByRole("heading", { name: /recipient insights/i }, { timeout: 5000 }),
        ).toBeInTheDocument();

        consoleSpy.mockRestore();
    });

    it("shows empty recipient details message when no merchants", async () => {
        renderWithApp(<RecipientInsightsPage />);
        // Default MSW returns topMerchants: [] → insights.detailsEmpty = "No recipient details available."
        expect(
            await screen.findByText(/no recipient details available/i),
        ).toBeInTheDocument();
    });

    it("shows subtitle text", async () => {
        renderWithApp(<RecipientInsightsPage />);
        // insights.subtitle = "Understand where your money goes by recipient"
        expect(
            await screen.findByText(/understand where your money goes/i),
        ).toBeInTheDocument();
    });

    it("shows Top 10 Recipients by Spend description", async () => {
        renderWithApp(<RecipientInsightsPage />);
        // insights.topBySpendDesc = "Total spending per recipient across all time"
        expect(
            await screen.findByText(/total spending per recipient across all time/i),
        ).toBeInTheDocument();
    });

    it("shows details subtitle text", async () => {
        renderWithApp(<RecipientInsightsPage />);
        // insights.detailsSubtitle = "Spending frequency and average transaction size"
        expect(
            await screen.findByText(/spending frequency and average transaction size/i),
        ).toBeInTheDocument();
    });

    it("shows Month-over-Month Changes section when spending increases exist", async () => {
        server.use(
            http.get(`${API_BASE}/api/aggregations/recipient-insights`, () =>
                ok({
                    data: {
                        topMerchants: [
                            {
                                recipientId: 1,
                                name: "Amazon",
                                totalSpend: 500,
                                transactionCount: 5,
                                avgAmount: 100,
                                firstSeen: "2025-01-01",
                                lastSeen: "2025-03-01",
                            },
                        ],
                        monthOverMonth: [
                            { recipientId: 1, name: "Amazon", changePercent: 25.5, previousSpend: 400, currentSpend: 500 },
                        ],
                    },
                    meta: { computedAt: "2025-01-01T00:00:00.000Z", source: "live" as const },
                }),
            ),
        );

        renderWithApp(<RecipientInsightsPage />);

        // insights.momChanges = "Month-over-Month Changes"
        expect(await screen.findByText(/month-over-month changes/i)).toBeInTheDocument();
        // insights.spentMoreAt = "You spent {n}% more at {name} this month"
        expect(await screen.findByText(/you spent.*more at amazon/i)).toBeInTheDocument();
    });

    it("shows Month-over-Month Changes section when spending decreases exist", async () => {
        server.use(
            http.get(`${API_BASE}/api/aggregations/recipient-insights`, () =>
                ok({
                    data: {
                        topMerchants: [
                            {
                                recipientId: 1,
                                name: "Netflix",
                                totalSpend: 120,
                                transactionCount: 2,
                                avgAmount: 60,
                                firstSeen: "2025-01-01",
                                lastSeen: "2025-03-01",
                            },
                        ],
                        monthOverMonth: [
                            { recipientId: 1, name: "Netflix", changePercent: -15.0, previousSpend: 100, currentSpend: 85 },
                        ],
                    },
                    meta: { computedAt: "2025-01-01T00:00:00.000Z", source: "live" as const },
                }),
            ),
        );

        renderWithApp(<RecipientInsightsPage />);

        // insights.spentLessAt = "You spent {n}% less at {name} this month"
        expect(await screen.findByText(/you spent.*less at netflix/i)).toBeInTheDocument();
    });

    // ─── Edge cases ────────────────────────────────────────────────────────

    it("does not crash when recipient-insights endpoint returns 4xx", async () => {
        const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
        server.use(
            http.get(`${API_BASE}/api/aggregations/recipient-insights`, () =>
                err(404, "Not found"),
            ),
        );
        const { container } = renderWithApp(<RecipientInsightsPage />);
        await new Promise((r) => setTimeout(r, 200));
        expect(container.firstChild).toBeTruthy();
        errSpy.mockRestore();
    });
});
