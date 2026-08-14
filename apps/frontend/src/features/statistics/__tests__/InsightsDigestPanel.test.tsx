// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http } from "msw";
import { renderWithApp } from "@/test/renderWithApp";
import { server } from "@/test/msw/server";
import { ok } from "@/test/msw/handlers";
import { InsightsDigestPanel } from "@/features/statistics/InsightsDigestPanel";
import { DISMISSED_INSIGHTS_STORAGE_KEY } from "@/lib/insightsDismiss";
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
            currentAmount: 620,
            baselineMedian: 400,
            deviation: 2.4,
            direction: "increased",
        },
    ],
    cashForecast: {
        month: "2026-07",
        currency: "EUR",
        monthEndProjected: -150,
        minProjected: -300,
        monthEndLow: -400,
        monthEndHigh: 100,
        crossesZero: true,
        movedSignificantly: false,
        prominence: "alert",
        methodId: "ets",
    },
};

function stubDigest(digest: InsightsDigestResponse) {
    server.use(http.get(`${API_BASE}/api/info/insights-digest`, () => ok(digest)));
}

describe("InsightsDigestPanel", () => {
    beforeEach(() => {
        window.localStorage.clear();
    });

    it("renders all three sections plus the alert cash-forecast line, with the count badge", async () => {
        stubDigest(DIGEST);
        renderWithApp(<InsightsDigestPanel />);

        expect(await screen.findByText("Netflix")).toBeInTheDocument();
        expect(screen.getByText("New subscriptions")).toBeInTheDocument();
        expect(screen.getByText("Spotify")).toBeInTheDocument();
        expect(screen.getByText("Price changes")).toBeInTheDocument();
        expect(screen.getByText("Groceries")).toBeInTheDocument();
        expect(screen.getByText("Category overspend")).toBeInTheDocument();
        expect(
            screen.getByText("Overdraft risk — the projected balance may drop below zero"),
        ).toBeInTheDocument();
        // 1 new + 1 price change + 1 outlier + 1 forecast alert.
        expect(screen.getByText("4")).toBeInTheDocument();
    });

    it("dismissing a row removes it immediately and persists to localStorage", async () => {
        stubDigest(DIGEST);
        renderWithApp(<InsightsDigestPanel />);
        const user = userEvent.setup();

        await screen.findByText("Netflix");
        // Rows render in section order: new subscription first.
        await user.click(screen.getAllByLabelText("Dismiss")[0]);

        await waitFor(() => expect(screen.queryByText("Netflix")).not.toBeInTheDocument());
        // Other sections are untouched.
        expect(screen.getByText("Spotify")).toBeInTheDocument();
        const stored = JSON.parse(
            window.localStorage.getItem(DISMISSED_INSIGHTS_STORAGE_KEY) ?? "{}",
        );
        expect(stored.subscriptions).toEqual([{ recipientId: 1, findingType: "new" }]);
    });

    it("shows the all-caught-up empty state for an empty digest", async () => {
        stubDigest({
            subscriptionCreep: { new: [], priceChanges: [] },
            categoryOutliers: [],
            cashForecast: null,
        });
        renderWithApp(<InsightsDigestPanel />);

        expect(
            await screen.findByText("No new insights right now — you're all caught up."),
        ).toBeInTheDocument();
    });
});
