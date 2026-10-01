// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { AnalysisResult } from "@/lib/api/analysis";
import { AnalysisChartPanel } from "./AnalysisChartPanel";
vi.mock("@/stores/hydration/LanguageHydration", () => ({
    useLanguage: () => ({ t: (key: string) => key }),
}));
vi.mock("@/stores/hydration/AppSettingsHydration", () => ({
    useAppSettings: () => ({
        appSettings: { numberFormat: "eu", dateFormat: "DD/MM/YYYY" },
    }),
}));
const result = {
    columns: [
        { id: "category", type: "string" },
        { id: "amount", type: "decimal" },
    ],
    rows: [
        { category: "A", amount: "-2" },
        { category: "B", amount: "4" },
    ],
    window: {
        kind: "page",
        offset: 0,
        hasMore: false,
        limit: 500,
        returnedRows: 2,
    },
} as unknown as AnalysisResult;
describe("analysis chart rendering", () => {
    it("explains an empty chart without rendering empty axes", () => {
        render(
            <AnalysisChartPanel
                result={{ ...result, rows: [] }}
                spec={{ kind: "bar", x: "category", y: ["amount"] }}
                onChange={vi.fn()}
            />,
        );
        expect(screen.getByRole("status").textContent).toBe(
            "analysis.ext.chart.empty",
        );
        expect(screen.queryByRole("img")).toBeNull();
    });
    it("formats exact values and dates without rounding the table", () => {
        const { container } = render(
            <AnalysisChartPanel
                result={{
                    ...result,
                    columns: [
                        { id: "day", type: "date" },
                        { id: "amount", type: "decimal" },
                    ],
                    rows: [{ day: "2026-10-01", amount: "1234.567890123" }],
                }}
                spec={{ kind: "bar", x: "day", y: ["amount"] }}
                onChange={vi.fn()}
            />,
        );
        expect(container.querySelector("tbody")?.textContent).toContain(
            "01/10/2026",
        );
        expect(container.querySelector("tbody")?.textContent).toContain(
            "1.234,567890123",
        );
        expect(container.querySelector("title")?.textContent).toContain(
            "1.234,567890123",
        );
        expect(
            container.querySelector('svg[role="img"]')?.textContent,
        ).toContain("1.234,6");
    });
    it("renders signed grouped bars and an accessible data table", () => {
        const { container } = render(
            <AnalysisChartPanel
                result={result}
                spec={{ kind: "bar", x: "category", y: ["amount"] }}
                onChange={vi.fn()}
            />,
        );
        expect(screen.getByRole("img")).toBeTruthy();
        expect(container.querySelectorAll("rect")).toHaveLength(2);
        expect(container.querySelectorAll("title")[0].textContent).toContain(
            "-2",
        );
        expect(screen.getByText("analysis.ext.chart.table")).toBeTruthy();
    });
    it("does not invent cumulative zero for missing waterfall values", () => {
        render(
            <AnalysisChartPanel
                result={{ ...result, rows: [{ category: "A", amount: null }] }}
                spec={{ kind: "waterfall", x: "category", y: ["amount"] }}
                onChange={vi.fn()}
            />,
        );
        expect(screen.getByRole("status").textContent).toBe(
            "analysis.ext.chart.waterfallMissing",
        );
        expect(screen.queryByRole("img")).toBeNull();
    });
});
