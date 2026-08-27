// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useLocation } from "react-router";
import { renderWithApp } from "@/test/renderWithApp";
import { CategoryPivotTable } from "@/features/statistics/CategoryPivotTable";
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
    it("exposes a child category drill-down as a native link", async () => {
        const user = userEvent.setup();
        renderTable();

        const cellLink = await screen.findByRole("link", {
            name: "View transactions: FOOD:GROCERIES — Jan 26",
        });
        expect(cellLink).toHaveAttribute(
            "href",
            expect.stringContaining("category_id=5"),
        );
        cellLink.focus();
        expect(cellLink).toHaveFocus();
        await user.keyboard("{Enter}");

        const loc = screen.getByTestId("location").textContent ?? "";
        expect(loc).toContain("/transactions?");
        expect(loc).toContain("category_id=5");
        expect(loc).toContain("start_date=2026-01-01");
        expect(loc).toContain("end_date=2026-01-31");
    });

    it("drills into the group total with Enter", async () => {
        const user = userEvent.setup();
        renderTable();

        const groupTotal = await screen.findByRole("link", {
            name: "View transactions: FOOD",
        });
        groupTotal.focus();
        await user.keyboard("{Enter}");

        const loc = screen.getByTestId("location").textContent ?? "";
        expect(loc).toContain("/transactions?");
        expect(loc).toContain("category_ids=5");
    });

    it("drills into a footer column total and the grand total", async () => {
        const user = userEvent.setup();
        renderTable();

        const footerJan = await screen.findByRole("link", {
            name: "View transactions: Jan 26",
        });
        footerJan.focus();
        await user.keyboard("{Enter}");
        expect(screen.getByTestId("location").textContent).toContain(
            "start_date=2026-01-01",
        );

        const grandTotal = screen.getByRole("link", {
            name: "View transactions: Total",
        });
        grandTotal.focus();
        await user.keyboard("{Enter}");
        expect(screen.getByTestId("location").textContent).toBe(
            "/transactions",
        );
    });

    it("only cells with a drill-down are focusable (zero cells expose no button)", async () => {
        renderTable();
        await screen.findByRole("link", { name: "View transactions: FOOD" });

        const drillLinks = screen.getAllByRole("link", {
            name: /^View transactions:/,
        });
        // group Jan + group total + child Jan + child total + footer Jan +
        // footer Feb + grand total = 7; the zero-valued group/child Feb cells
        // must not be focusable.
        expect(drillLinks).toHaveLength(7);
        expect(
            screen.queryByRole("link", {
                name: "View transactions: FOOD — Feb 26",
            }),
        ).not.toBeInTheDocument();
        expect(
            screen.queryByRole("link", {
                name: "View transactions: FOOD:GROCERIES — Feb 26",
            }),
        ).not.toBeInTheDocument();
    });

    it("clicking the link navigates without making the whole cell interactive", async () => {
        const user = userEvent.setup();
        renderTable();

        const cellLink = await screen.findByRole("link", {
            name: "View transactions: FOOD:GROCERIES — Jan 26",
        });
        await user.click(cellLink);
        expect(screen.getByTestId("location").textContent).toContain(
            "category_id=5",
        );
    });

    it("gives every controlled child row a unique id", async () => {
        const user = userEvent.setup();
        const multiChildData: StatisticsData = {
            ...DATA,
            categoryPivot: [
                ...DATA.categoryPivot,
                {
                    ...DATA.categoryPivot[0],
                    categoryName: "FOOD:DINING",
                    categoryId: 6,
                    months: { "2026-01": 50 },
                    netMonths: { "2026-01": -50 },
                    total: 50,
                    expenseTotal: 50,
                    netTotal: -50,
                },
            ],
        };
        const { container } = renderWithApp(
            <CategoryPivotTable
                data={multiChildData}
                graphKey="pivot"
                isFiltered={false}
                onToggle={vi.fn()}
                exclusionsApply={false}
            />,
        );

        const toggle = await screen.findByRole("button", {
            name: "Collapse FOOD",
        });
        const controlledIds =
            toggle.getAttribute("aria-controls")?.split(" ") ?? [];

        expect(controlledIds).toHaveLength(2);
        expect(new Set(controlledIds).size).toBe(2);
        for (const id of controlledIds) {
            expect(container.querySelectorAll(`[id="${id}"]`)).toHaveLength(1);
        }

        await user.click(toggle);
        for (const id of controlledIds) {
            expect(container.querySelector(`[id="${id}"]`)).toHaveAttribute(
                "hidden",
            );
        }
    });
});
