// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithApp } from "@/test/renderWithApp";
import { CategoryPivotTable } from "@/features/statistics/CategoryPivotTable";
import type { StatisticsData } from "@/hooks/useStatistics";

function buildPeriods(count: number): string[] {
    return Array.from({ length: count }, (_, index) => {
        const year = 2010 + Math.floor(index / 12);
        const month = String((index % 12) + 1).padStart(2, "0");
        return `${year}-${month}`;
    });
}

function buildLongHistoryData(periods: string[]): StatisticsData {
    const months = Object.fromEntries(periods.map((period) => [period, 1]));
    const category = (categoryName: string, categoryId: number) => ({
        categoryName,
        categoryId,
        months,
        incomeMonths: {},
        expenseMonths: months,
        netMonths: Object.fromEntries(periods.map((period) => [period, -1])),
        total: periods.length,
        incomeTotal: 0,
        expenseTotal: periods.length,
        netTotal: -periods.length,
    });

    return {
        monthlyData: [],
        categoryPivot: [
            category("FOOD:GROCERIES", 5),
            category("FOOD:DINING", 6),
        ],
        topRecipients: [],
        topRecipientsByYear: {},
        yearlyComparison: [],
        allPeriods: periods,
        allYears: Array.from(new Set(periods.map(Number.parseFloat))),
        totalIncome: 0,
        totalSpending: periods.length * 2,
        averageMonthlySpending: 2,
        averageMonthlyIncome: 0,
    };
}

function renderLongHistory(periodCount = 120) {
    const periods = buildPeriods(periodCount);
    const data = buildLongHistoryData(periods);
    const result = renderWithApp(
        <CategoryPivotTable
            data={data}
            graphKey="pivot"
            isFiltered={false}
            onToggle={vi.fn()}
            exclusionsApply={false}
        />,
    );
    return { ...result, data, periods };
}

describe("CategoryPivotTable period windowing", () => {
    it("bounds mounted period columns while totals still cover the full history", async () => {
        const { container, data } = renderLongHistory();
        const table = await screen.findByRole("table", {
            name: "Category Pivot Table",
        });

        expect(within(table).getAllByRole("columnheader")).toHaveLength(14);
        expect(container.querySelectorAll("[data-pivot-period]")).toHaveLength(
            60,
        );
        expect(
            container.querySelector('[data-pivot-period="2019-12"]'),
        ).toBeInTheDocument();
        expect(
            container.querySelector('[data-pivot-period="2010-01"]'),
        ).not.toBeInTheDocument();

        const groupTotal = screen.getByRole("link", {
            name: "View transactions: FOOD",
        });
        expect(groupTotal).toHaveTextContent(
            String(data.allPeriods.length * 2),
        );
    });

    it("makes every period reachable with keyboard-operable paging controls", async () => {
        const user = userEvent.setup();
        const { container } = renderLongHistory();
        const previous = await screen.findByRole("button", {
            name: "Previous",
        });
        const next = screen.getByRole("button", { name: "Next" });

        expect(previous).toBeEnabled();
        expect(next).toBeDisabled();

        previous.focus();
        for (let page = 0; page < 9; page += 1) {
            await user.keyboard("{Enter}");
        }

        expect(previous).toBeDisabled();
        expect(next).toBeEnabled();
        expect(
            container.querySelector('[data-pivot-period="2010-01"]'),
        ).toBeInTheDocument();
        expect(
            screen.getByRole("link", { name: "View transactions: Jan 10" }),
        ).toHaveAttribute(
            "href",
            expect.stringContaining("start_date=2010-01-01"),
        );

        next.focus();
        await user.keyboard("{Enter}");
        expect(
            container.querySelector('[data-pivot-period="2011-01"]'),
        ).toBeInTheDocument();
    });

    it("keeps the category column sticky in every rendered row", async () => {
        const { container } = renderLongHistory();
        await screen.findByRole("table", { name: "Category Pivot Table" });
        const rows = screen.getAllByRole("row");

        for (const row of rows) {
            const labelCell = row.querySelector("th, td");
            expect(labelCell).toHaveClass("sticky", "left-0");
        }
        expect(container.querySelectorAll("tbody tr")).toHaveLength(3);
    });
});
