// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http } from "msw";
import { renderWithApp } from "@/test/renderWithApp";
import { server } from "@/test/msw/server";
import { ok } from "@/test/msw/handlers";
import { InsightsDigestPanel } from "@/features/statistics/InsightsDigestPanel";
import type { InsightsDigestResponse } from "@/lib/api/info";

const API_BASE = "http://localhost:3002";

const DIGEST: InsightsDigestResponse = {
    subscriptionCreep: {
        new: [
            {
                recipientId: 1,
                recipientName: "Netflix",
                findingType: "new",
                latestAmount: 12.99,
                currency: "EUR",
                detectedPattern: "monthly",
                intervalDays: 30,
                predictedNext: "2026-08-01",
                confidence: 90,
            },
        ],
        priceChanges: [
            {
                recipientId: 2,
                recipientName: "Spotify",
                findingType: "priceChange",
                previousAmount: 9.99,
                newAmount: 11.99,
                percentChange: 20,
                direction: "increased",
                currency: "EUR",
                confidence: 85,
            },
        ],
    },
    categoryOutliers: [
        {
            categoryId: 5,
            categoryName: "Groceries",
            monthKey: "2026-07",
            comparisonEndDay: 15,
            currentAmount: 620,
            baselineMedian: 400,
            deviation: 2.4,
            direction: "increased",
        },
    ],
    cashForecast: {
        month: "2026-07",
        currency: "EUR",
        monthEndNetCashflow: -150,
        monthEndNetCashflowLow: -400,
        monthEndNetCashflowHigh: 100,
        movedSignificantly: true,
        prominence: "alert",
        methodId: "ets",
    },
};

function stubDigest(digest: InsightsDigestResponse) {
    server.use(
        http.get(`${API_BASE}/api/info/insights-digest`, () => ok(digest)),
    );
}

describe("InsightsDigestPanel", () => {
    beforeEach(() => {
        window.localStorage.clear();
    });

    it("renders net cash flow without balance or overdraft claims", async () => {
        stubDigest(DIGEST);
        renderWithApp(<InsightsDigestPanel />);

        expect(await screen.findByText("Netflix")).toBeInTheDocument();
        expect(screen.getByText("New subscriptions")).toBeInTheDocument();
        expect(screen.getByText("Spotify")).toBeInTheDocument();
        expect(screen.getByText("Price changes")).toBeInTheDocument();
        const categoryCopy = screen.getByText("Groceries").parentElement;
        expect(categoryCopy).toBeInTheDocument();
        expect(screen.getByText("Category overspend")).toBeInTheDocument();
        expect(categoryCopy).toHaveTextContent("days 1-15");
        expect(categoryCopy).toHaveTextContent("typical for days 1-15:");
        const cashCopy = screen.getByText(/Expected month-end net cash flow:/);
        expect(cashCopy).toHaveTextContent("150");
        expect(
            screen.queryByText(/projected month-end balance/i),
        ).not.toBeInTheDocument();
        expect(screen.queryByText(/overdraft risk/i)).not.toBeInTheDocument();
        expect(
            screen.getByText(/expected net cash flow changed significantly/i),
        ).toBeInTheDocument();
        // 1 new + 1 price change + 1 outlier + 1 forecast alert.
        expect(screen.getByText("4")).toBeInTheDocument();
    });

    it("renders the exact partial-month comparison window in Dutch", async () => {
        server.use(
            http.get(`${API_BASE}/api/settings`, () =>
                ok({ app_settings: { language: "nl" } }),
            ),
        );
        stubDigest(DIGEST);
        renderWithApp(<InsightsDigestPanel />);

        expect(await screen.findByText(/dag 1 t\/m 15/)).toBeInTheDocument();
        expect(
            screen.getByText(/normaal voor dag 1 t\/m 15:/),
        ).toBeInTheDocument();
        expect(
            screen.getByText(/Verwachte nettokasstroom/),
        ).toBeInTheDocument();
    });

    it("does not count a negative net cash flow as an alert by itself", async () => {
        stubDigest({
            ...DIGEST,
            cashForecast: {
                ...DIGEST.cashForecast!,
                movedSignificantly: false,
                prominence: "standing",
            },
        });
        renderWithApp(<InsightsDigestPanel />);

        const cashCopy = await screen.findByText(
            /Expected month-end net cash flow:/,
        );
        expect(cashCopy).toHaveTextContent("150");
        expect(screen.queryByText(/overdraft risk/i)).not.toBeInTheDocument();
        expect(
            screen.queryByText(/expected net cash flow changed significantly/i),
        ).not.toBeInTheDocument();
        // The three other findings are alerts; negative net cash flow is standing.
        expect(screen.getByText("3")).toBeInTheDocument();
    });

    it("dismissing a row persists it on the server and refetches the filtered digest", async () => {
        let dismissed = false;
        let body: unknown;
        server.use(
            http.get(`${API_BASE}/api/info/insights-digest`, () =>
                ok(
                    dismissed
                        ? {
                              ...DIGEST,
                              subscriptionCreep: {
                                  ...DIGEST.subscriptionCreep,
                                  new: [],
                              },
                          }
                        : DIGEST,
                ),
            ),
            http.put(
                `${API_BASE}/api/info/insight-dismissals`,
                async ({ request }) => {
                    body = await request.json();
                    dismissed = true;
                    return ok({ id: 9 });
                },
            ),
        );
        renderWithApp(<InsightsDigestPanel />);
        const user = userEvent.setup();

        await screen.findByText("Netflix");
        // Rows render in section order: new subscription first.
        await user.click(screen.getAllByLabelText("Dismiss")[0]);

        await waitFor(() =>
            expect(screen.queryByText("Netflix")).not.toBeInTheDocument(),
        );
        // Other sections are untouched.
        expect(screen.getByText("Spotify")).toBeInTheDocument();
        expect(body).toEqual({ kind: "subscription_new", recipient_id: 1 });
    });

    it("shows the all-caught-up empty state for an empty digest", async () => {
        stubDigest({
            subscriptionCreep: { new: [], priceChanges: [] },
            categoryOutliers: [],
            cashForecast: null,
        });
        renderWithApp(<InsightsDigestPanel />);

        expect(
            await screen.findByText(
                "No new insights right now — you're all caught up",
            ),
        ).toBeInTheDocument();
    });
});
