// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import { renderWithApp } from "@/test/renderWithApp";
import PerformanceBreakdown from "../PerformanceBreakdown";

describe("PerformanceBreakdown", () => {
    it("uses readable asset labels when a holding has no ticker", async () => {
        renderWithApp(
            <PerformanceBreakdown
                heatmapData={{ years: [], data: {}, maxAbsPct: 0 }}
                breakdownSummary={[
                    {
                        id: 1,
                        name: "Apartment",
                        symbol: "",
                        assetClass: "real_estate",
                        currency: "EUR",
                        currentValue: 100,
                        totalInvested: 90,
                        gainLoss: 10,
                        gainLossPercent: 11,
                    },
                    {
                        id: 2,
                        name: "Savings account",
                        symbol: "",
                        assetClass: "savings",
                        currency: "EUR",
                        currentValue: 100,
                        totalInvested: 100,
                        gainLoss: 0,
                        gainLossPercent: 0,
                    },
                    {
                        id: 3,
                        name: "Fund",
                        symbol: "IWDA",
                        assetClass: "etf",
                        currency: "EUR",
                        currentValue: 100,
                        totalInvested: 100,
                        gainLoss: 0,
                        gainLossPercent: 0,
                    },
                ]}
            />,
        );
        expect(
            (await screen.findAllByText("Real estate")).length,
        ).toBeGreaterThan(0);
        expect(screen.queryByText("real_estate")).not.toBeInTheDocument();
        expect(screen.queryByText("savings")).not.toBeInTheDocument();
        expect(screen.getAllByText("IWDA")).toHaveLength(2);
    });
});
