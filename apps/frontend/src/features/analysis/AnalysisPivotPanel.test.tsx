// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { AnalysisPivotPanel } from "./AnalysisPivotPanel";
import {
    executeAnalysisPivot,
    type AnalysisDataset,
    type VisualAnalysisPlan,
} from "@/lib/api/analysis";
vi.mock("@/lib/api/analysis", () => ({ executeAnalysisPivot: vi.fn() }));
vi.mock("@/stores/hydration/AppSettingsHydration", () => ({
    useAppSettings: () => ({ appSettings: { numberFormat: "1,234.56" } }),
}));
vi.mock("@/stores/hydration/LanguageHydration", () => ({
    useLanguage: () => ({ t: (key: string) => key }),
}));
const plan = {
    datasetId: "cash-flows",
    fields: [],
    groups: [],
    measures: ["sum_spending"],
    filters: [],
    joins: [],
    orderBy: [],
    limit: 500,
} as VisualAnalysisPlan;
const config = {
    rows: ["category_general"],
    columns: ["month"],
    values: ["sum_spending", "sum_amount"],
    filters: [],
};
const dataset = {
    id: "cash-flows",
    label: "Cash flows",
    relation: "vision_analysis.cash_flows_v2",
    fields: [
        { id: "category_general", label: "Category", type: "string" },
        { id: "month", label: "Month", type: "date" },
        { id: "currency", label: "Currency", type: "currency" },
    ],
    measures: [
        { id: "sum_spending", label: "Spending", type: "decimal" },
        { id: "sum_amount", label: "Net", type: "decimal" },
    ],
    joins: [],
} as AnalysisDataset;
describe("configured server pivot UI", () => {
    it("explains why an empty values selection cannot run", () => {
        render(
            <AnalysisPivotPanel
                plan={plan}
                dataset={dataset}
                config={{ ...config, values: [] }}
                onChange={vi.fn()}
                onDrill={vi.fn()}
            />,
        );
        expect(screen.getByRole("status").textContent).toBe(
            "analysis.ext.pivot.chooseValue",
        );
        expect(
            screen.getByRole("button", { name: "analysis.ext.pivot.run" }),
        ).toBeDisabled();
    });
    it("offers recoverable error details when a pivot run fails", async () => {
        vi.mocked(executeAnalysisPivot).mockRejectedValueOnce(
            new Error("Invalid grouping"),
        );
        render(
            <AnalysisPivotPanel
                plan={plan}
                dataset={dataset}
                config={config}
                onChange={vi.fn()}
                onDrill={vi.fn()}
            />,
        );
        fireEvent.click(
            screen.getByRole("button", { name: "analysis.ext.pivot.run" }),
        );
        expect(await screen.findByRole("alert")).toHaveTextContent(
            "analysis.ext.pivot.failed",
        );
        expect(screen.getByText("Invalid grouping")).toBeInTheDocument();
        expect(
            screen.getByRole("button", { name: "analysis.ext.pivot.run" }),
        ).toBeEnabled();
    });
    it("searches unselected fields and preserves selected field order", () => {
        const onChange = vi.fn();
        render(
            <AnalysisPivotPanel
                plan={plan}
                dataset={dataset}
                config={config}
                onChange={onChange}
                onDrill={vi.fn()}
            />,
        );
        expect(
            screen.queryByRole("textbox", {
                name: "analysis.ext.pivot.searchFields",
            }),
        ).toBeNull();
        fireEvent.click(
            screen.getAllByRole("button", {
                name: "analysis.ext.pivot.addField",
            })[0],
        );
        fireEvent.change(
            screen.getByRole("textbox", {
                name: "analysis.ext.pivot.searchFields",
            }),
            { target: { value: "curr" } },
        );
        fireEvent.click(screen.getByRole("button", { name: "Currency" }));
        expect(document.activeElement).toBe(
            screen.getAllByRole("button", {
                name: "analysis.ext.pivot.addField",
            })[0],
        );
        fireEvent.click(
            screen.getAllByRole("button", {
                name: "analysis.ext.pivot.addField",
            })[0],
        );
        fireEvent.keyDown(
            screen.getByRole("textbox", {
                name: "analysis.ext.pivot.searchFields",
            }),
            { key: "Escape" },
        );
        expect(document.activeElement).toBe(
            screen.getAllByRole("button", {
                name: "analysis.ext.pivot.addField",
            })[0],
        );
        expect(onChange).toHaveBeenCalledWith({
            ...config,
            rows: ["category_general", "currency"],
        });
        expect(
            screen.queryByRole("textbox", {
                name: "analysis.ext.pivot.searchFields",
            }),
        ).toBeNull();
    });
    it("expands a column group without changing other groups", async () => {
        const hierarchy = {
            ...config,
            columns: ["year", "month"],
            values: ["sum_spending"],
        };
        const base = { currency: "EUR", category_general: "Food", year: 2026 };
        vi.mocked(executeAnalysisPivot).mockResolvedValue({
            config: hierarchy,
            partitions: ["currency"],
            coverage: { complete: true, rows: 3 },
            levels: [
                {
                    rowDepth: 0,
                    columnDepth: 1,
                    groups: ["year", "currency"],
                    columns: [],
                    rows: [{ currency: "EUR", year: 2026, sum_spending: "30" }],
                },
                {
                    rowDepth: 1,
                    columnDepth: 1,
                    groups: ["category_general", "year", "currency"],
                    columns: [],
                    rows: [{ ...base, sum_spending: "30" }],
                },
                {
                    rowDepth: 1,
                    columnDepth: 2,
                    groups: ["category_general", "year", "month", "currency"],
                    columns: [],
                    rows: [
                        { ...base, month: "2026-02-01", sum_spending: "20" },
                        { ...base, month: "2026-01-01", sum_spending: "10" },
                    ],
                },
            ],
        });
        render(
            <AnalysisPivotPanel
                plan={plan}
                dataset={dataset}
                config={hierarchy}
                onChange={vi.fn()}
                onDrill={vi.fn()}
            />,
        );
        fireEvent.click(
            screen.getByRole("button", { name: "analysis.ext.pivot.run" }),
        );
        await screen.findByRole("button", {
            name: "analysis.ext.pivot.expand",
        });
        expect(
            screen.getByRole("rowheader", { name: "analysis.ext.pivot.total" }),
        ).toBeVisible();
        expect(screen.queryByText("2026 / 2026-01-01 · Spending")).toBeNull();
        fireEvent.click(
            screen.getByRole("button", { name: "analysis.ext.pivot.expand" }),
        );
        expect(screen.getByText("2026 / 2026-01-01 · Spending")).toBeVisible();
        expect(screen.getByRole("button", { name: "10" })).toBeVisible();
        fireEvent.click(
            screen.getByRole("button", { name: "analysis.ext.pivot.collapse" }),
        );
        expect(screen.queryByRole("button", { name: "10" })).toBeNull();
    });
    it("sorts months, expands individual groups, and preserves drill scope", async () => {
        const hierarchy = {
            ...config,
            rows: ["category_general", "account"],
            values: ["sum_spending"],
        };
        const base = { currency: "EUR", category_general: "Food" };
        vi.mocked(executeAnalysisPivot).mockResolvedValue({
            config: hierarchy,
            partitions: ["currency"],
            coverage: { complete: true, rows: 4 },
            levels: [
                {
                    rowDepth: 1,
                    columnDepth: 1,
                    groups: ["category_general", "month", "currency"],
                    columns: [],
                    rows: [
                        {
                            ...base,
                            month: "2026-02-01",
                            sum_spending: "1234.50",
                        },
                        { ...base, month: "2026-01-01", sum_spending: "20" },
                    ],
                },
                {
                    rowDepth: 2,
                    columnDepth: 1,
                    groups: [
                        "category_general",
                        "account",
                        "month",
                        "currency",
                    ],
                    columns: [],
                    rows: [
                        {
                            ...base,
                            account: "Checking",
                            month: "2026-02-01",
                            sum_spending: "1234.50",
                        },
                        {
                            ...base,
                            account: "Checking",
                            month: "2026-01-01",
                            sum_spending: "20",
                        },
                    ],
                },
            ],
        });
        const drill = vi.fn();
        render(
            <AnalysisPivotPanel
                plan={plan}
                dataset={{
                    ...dataset,
                    fields: [
                        ...dataset.fields,
                        { id: "account", label: "Account", type: "string" },
                    ],
                }}
                config={hierarchy}
                onChange={vi.fn()}
                onDrill={drill}
            />,
        );
        fireEvent.click(
            screen.getByRole("button", { name: "analysis.ext.pivot.run" }),
        );
        await screen.findByText("2026-01-01 · Spending");
        const headers = screen
            .getAllByRole("columnheader")
            .map((element) => element.textContent);
        expect(headers.indexOf("2026-01-01 · Spending")).toBeLessThan(
            headers.indexOf("2026-02-01 · Spending"),
        );
        expect(screen.queryByText("Checking")).toBeNull();
        expect(screen.getByRole("button", { name: "1,234.50" })).toBeVisible();
        fireEvent.click(
            screen.getByRole("button", { name: "analysis.ext.pivot.expand" }),
        );
        expect(screen.getByText("Checking")).toBeVisible();
        fireEvent.click(screen.getAllByRole("button", { name: "20" })[1]);
        expect(drill).toHaveBeenCalledWith(
            ["category_general", "account", "month", "currency"],
            { ...base, account: "Checking", month: "2026-01-01" },
        );
        fireEvent.click(
            screen.getByRole("button", { name: "analysis.ext.pivot.collapse" }),
        );
        expect(screen.queryByText("Checking")).toBeNull();
    });
    it("renders multiple measures across columns, source totals, typed drill and partial financial coverage", async () => {
        vi.mocked(executeAnalysisPivot).mockResolvedValue({
            config,
            partitions: ["currency"],
            coverage: {
                complete: true,
                financialComplete: false,
                unavailableRows: 1,
                rows: 4,
            },
            levels: [
                {
                    rowDepth: 0,
                    columnDepth: 0,
                    groups: ["currency"],
                    columns: [],
                    rows: [
                        {
                            currency: "EUR",
                            sum_spending: "30",
                            sum_amount: "-30",
                        },
                    ],
                },
                {
                    rowDepth: 1,
                    columnDepth: 0,
                    groups: ["category_general", "currency"],
                    columns: [],
                    rows: [
                        {
                            category_general: "Food",
                            currency: "EUR",
                            sum_spending: "30",
                            sum_amount: "-30",
                        },
                    ],
                },
                {
                    rowDepth: 1,
                    columnDepth: 1,
                    groups: ["category_general", "month", "currency"],
                    columns: [],
                    rows: [
                        {
                            category_general: "Food",
                            month: "2026-01-01",
                            currency: "EUR",
                            sum_spending: "10",
                            sum_amount: "-10",
                        },
                        {
                            category_general: "Food",
                            month: "2026-02-01",
                            currency: "EUR",
                            sum_spending: "20",
                            sum_amount: "-20",
                        },
                    ],
                },
            ],
        });
        const drill = vi.fn();
        render(
            <AnalysisPivotPanel
                plan={plan}
                dataset={dataset}
                config={config}
                onChange={vi.fn()}
                onDrill={drill}
            />,
        );
        fireEvent.click(
            screen.getByRole("button", { name: "analysis.ext.pivot.run" }),
        );
        await waitFor(() =>
            expect(screen.getByText("2026-01-01 · Spending")).toBeVisible(),
        );
        expect(screen.getByText("2026-02-01 · Net")).toBeVisible();
        expect(screen.getByText("30")).toBeVisible();
        expect(screen.getByText("analysis.ext.pivot.partial")).toBeVisible();
        fireEvent.click(screen.getByRole("button", { name: "10" }));
        expect(drill).toHaveBeenCalledWith(
            ["category_general", "month", "currency"],
            { category_general: "Food", month: "2026-01-01", currency: "EUR" },
        );
    });
});
