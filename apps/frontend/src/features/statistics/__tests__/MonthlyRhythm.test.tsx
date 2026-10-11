// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import { renderWithApp } from "@/test/renderWithApp";
import { MonthlyRhythm } from "../MonthlyRhythm";
import type { StatisticsData } from "@/hooks/useStatistics";

function month(period: string, net: number) {
    return {
        period,
        income: Math.max(net, 0) + 1000,
        spending: 1000 - Math.min(net, 0),
        net,
        transactionCount: 10,
    };
}

function data(months: ReturnType<typeof month>[]): StatisticsData {
    return {
        monthlyData: months,
        allPeriods: months.map((m) => m.period),
        allYears: [2026],
        categoryPivot: [],
        yearlyComparison: [],
        topRecipients: [],
        averageMonthlySpending: 1000,
        averageMonthlyIncome: 1500,
    } as unknown as StatisticsData;
}

describe("MonthlyRhythm", () => {
    it("labels the month in progress 'so far' and keeps it out of best/worst", async () => {
        renderWithApp(
            <MonthlyRhythm
                currentPeriod="2026-03"
                data={data([
                    month("2026-01", 200),
                    month("2026-02", -150),
                    // A huge partial month must not become the best month.
                    month("2026-03", 5000),
                ])}
            />,
        );

        expect(
            await screen.findByText(/net in mar 2026 so far/i),
        ).toBeInTheDocument();
        const best = screen.getByText("Best month").parentElement!;
        expect(best).toHaveTextContent(/200,00/);
        expect(best).toHaveTextContent(/jan 2026/i);
        const worst = screen.getByText("Worst month").parentElement!;
        expect(worst).toHaveTextContent(/150,00/);
        expect(worst).toHaveTextContent(/feb 2026/i);
    });

    it("falls back to the only month when it is the one in progress", async () => {
        renderWithApp(
            <MonthlyRhythm
                currentPeriod="2026-03"
                data={data([month("2026-03", 75)])}
            />,
        );
        const best = await screen.findByText("Best month");
        expect(best.parentElement).toHaveTextContent(/75,00/);
        expect(best.parentElement).toHaveTextContent(/so far/i);
    });

    it("snaps a scrub index past a shrunken series back to the latest month", async () => {
        const { rerender } = renderWithApp(
            <MonthlyRhythm
                currentPeriod="2026-04"
                data={data([
                    month("2026-01", 200),
                    month("2026-02", -150),
                    month("2026-03", 90),
                ])}
            />,
        );
        const strip = await screen.findByRole("group");
        const bars = strip.querySelectorAll(".flex-1");
        expect(bars).toHaveLength(3);
        fireEvent.pointerEnter(bars[2]!);
        expect(screen.getByText(/net in mar 2026/i)).toBeInTheDocument();

        // A refetch returns fewer months while the pointer still rests on the strip.
        rerender(
            <MonthlyRhythm
                currentPeriod="2026-04"
                data={data([month("2026-01", 200)])}
            />,
        );
        expect(screen.getByText(/net in jan 2026/i)).toBeInTheDocument();
    });
});
