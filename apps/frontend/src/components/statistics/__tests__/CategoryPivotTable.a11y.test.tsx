// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useLocation } from "react-router";
import { renderWithApp } from "@/test/renderWithApp";
import { CategoryPivotTable } from "@/components/statistics/CategoryPivotTable";
import type { StatisticsData } from "@/hooks/useStatistics";

function LocationProbe() {
    const loc = useLocation();
    return <div data-testid="location">{loc.pathname + loc.search}</div>;
}

// One group (FOOD) with one child (GROCERIES): spend in 2026-01, nothing in
// 2026-02 — the zero cell must NOT be keyboard-focusable.
const DATA: StatisticsData = {
    monthlyData: [],
    categoryPivot: [
        {
            categoryName: "FOOD:GROCERIES",
            categoryId: 5,
            months: { "2026-01": 100 },
            incomeMonths: {},
            expenseMonths: {},
            netMonths: { "2026-01": -100 },
            total: 100,
            incomeTotal: 0,
            expenseTotal: 100,
            netTotal: -100,
        },
    ],
    topRecipients: [],
    topRecipientsByYear: {},
    yearlyComparison: [],
    allPeriods: ["2026-01", "2026-02"],
    allYears: [2026],
    totalIncome: 0,
    totalSpending: 100,
    averageMonthlySpending: 50,
    averageMonthlyIncome: 0,
};

function renderTable() {
    return renderWithApp(
        <>
            <CategoryPivotTable
                data={DATA}
                graphKey="pivot"
                isFiltered={false}
                onToggle={vi.fn()}
                exclusionsApply={false}
            />
            <LocationProbe />
        </>,
        { initialEntries: ["/statistics"] },
    );
}

describe("CategoryPivotTable keyboard drill-down", () => {
    it("drills into a child category cell with Enter on the focused cell button", async () => {
        const user = userEvent.setup();
        renderTable();

        const cellButton = await screen.findByRole("button", {
            name: "View transactions: FOOD:GROCERIES — Jan 26",
        });
        cellButton.focus();
        expect(cellButton).toHaveFocus();
        await user.keyboard("{Enter}");

        const loc = screen.getByTestId("location").textContent ?? "";
        expect(loc).toContain("/transactions?");
        expect(loc).toContain("category_id=5");
        expect(loc).toContain("start_date=2026-01-01");
        expect(loc).toContain("end_date=2026-01-31");
    });

    it("drills into the group total with Space", async () => {
        const user = userEvent.setup();
        renderTable();

        const groupTotal = await screen.findByRole("button", {
            name: "View transactions: FOOD",
        });
        groupTotal.focus();
        await user.keyboard(" ");

        const loc = screen.getByTestId("location").textContent ?? "";
        expect(loc).toContain("/transactions?");
        expect(loc).toContain("category_ids=5");
    });

    it("drills into a footer column total and the grand total", async () => {
        const user = userEvent.setup();
        renderTable();

        const footerJan = await screen.findByRole("button", {
            name: "View transactions: Jan 26",
        });
        footerJan.focus();
        await user.keyboard("{Enter}");
        expect(screen.getByTestId("location").textContent).toContain("start_date=2026-01-01");

        const grandTotal = screen.getByRole("button", { name: "View transactions: Total" });
        grandTotal.focus();
        await user.keyboard("{Enter}");
        expect(screen.getByTestId("location").textContent).toBe("/transactions");
    });

    it("only cells with a drill-down are focusable (zero cells expose no button)", async () => {
        renderTable();
        await screen.findByRole("button", { name: "View transactions: FOOD" });

        const drillButtons = screen.getAllByRole("button", { name: /^View transactions:/ });
        // group Jan + group total + child Jan + child total + footer Jan +
        // footer Feb + grand total = 7; the zero-valued group/child Feb cells
        // must not be focusable.
        expect(drillButtons).toHaveLength(7);
        expect(
            screen.queryByRole("button", { name: "View transactions: FOOD — Feb 26" }),
        ).not.toBeInTheDocument();
        expect(
            screen.queryByRole("button", { name: "View transactions: FOOD:GROCERIES — Feb 26" }),
        ).not.toBeInTheDocument();
    });

    it("mouse click on the whole cell still navigates (unchanged mouse path)", async () => {
        const user = userEvent.setup();
        renderTable();

        const cellButton = await screen.findByRole("button", {
            name: "View transactions: FOOD:GROCERIES — Jan 26",
        });
        // Click bubbles from the inner button to the td's onClick.
        await user.click(cellButton);
        expect(screen.getByTestId("location").textContent).toContain("category_id=5");
    });
});
