// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { screen, within } from "@testing-library/react";
import { renderWithApp } from "@/test/renderWithApp";
import { CategoryPivotTable } from "@/features/statistics/CategoryPivotTable";
import type { StatisticsData } from "@/hooks/useStatistics";

const period = "2026-01";
function category(id: number, names: string[], ids: number[], amount: number) {
    return {
        categoryName: names.join(":"),
        categoryId: id,
        categoryPathIds: ids,
        categoryPathSegments: names,
        months: { [period]: amount },
        incomeMonths: {},
        expenseMonths: { [period]: amount },
        netMonths: { [period]: -amount },
        total: amount,
        incomeTotal: 0,
        expenseTotal: amount,
        netTotal: -amount,
    };
}
const data: StatisticsData = {
    monthlyData: [],
    categoryPivot: [
        category(1, ["FOOD"], [1], 30),
        category(2, ["FOOD", "GROCERIES"], [1, 2], 20),
        category(3, ["FOOD", "GROCERIES", "ORGANIC"], [1, 2, 3], 30),
        category(
            4,
            ["FOOD", "GROCERIES", "ORGANIC", "FRUIT"],
            [1, 2, 3, 4],
            20,
        ),
    ],
    topRecipients: [],
    topRecipientsByYear: {},
    yearlyComparison: [],
    allPeriods: [period],
    allYears: [2026],
    totalIncome: 0,
    totalSpending: 100,
    averageMonthlySpending: 100,
    averageMonthlyIncome: 0,
};

describe("CategoryPivotTable ordered hierarchy", () => {
    it("shows every ancestor, aggregates each direct category once, and drills by stable IDs", async () => {
        renderWithApp(
            <CategoryPivotTable
                data={data}
                graphKey="pivot"
                isFiltered={false}
                onToggle={vi.fn()}
                exclusionsApply={false}
            />,
        );
        const table = await screen.findByRole("table", {
            name: "Category Pivot Table",
        });
        const rows = within(table).getAllByRole("row");
        expect(rows).toHaveLength(6); // header, root, depth 2/3/4, footer

        const root = screen.getByRole("link", {
            name: "View transactions: FOOD",
        });
        expect(root).toHaveTextContent("100");
        expect(root).toHaveAttribute(
            "href",
            expect.stringContaining("category_ids=1%2C2%2C3%2C4"),
        );
        const groceries = screen.getByRole("link", {
            name: "View transactions: FOOD / GROCERIES",
        });
        expect(groceries).toHaveTextContent("70");
        expect(groceries).toHaveAttribute(
            "href",
            expect.stringContaining("category_ids=2%2C3%2C4"),
        );
        expect(
            screen.getByRole("link", {
                name: "View transactions: FOOD / GROCERIES / ORGANIC",
            }),
        ).toHaveTextContent("50");
        expect(
            screen.getByRole("link", {
                name: "View transactions: FOOD / GROCERIES / ORGANIC / FRUIT",
            }),
        ).toHaveTextContent("20");
    });
});
