// @vitest-environment jsdom
/** AI-chat tool charts on the in-house chart primitives (ADR-245). */
import { describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";

import { renderWithApp } from "@/test/renderWithApp";
import ToolResultChart from "../ToolResultChart";

vi.mock("@visx/responsive", async (importOriginal) => {
    const mod = await importOriginal<typeof import("@visx/responsive")>();
    return {
        ...mod,
        ParentSize: ({
            children,
        }: {
            children: (size: { width: number; height: number }) => React.ReactNode;
        }) => children({ width: 600, height: 224 }),
    };
});

const rows = [
    { month: "2026-07", income: 10, spending: 4 },
    { month: "2026-08", income: 12, spending: "n/a" },
    { month: "2026-09", income: 9, spending: 6 },
];

describe("ToolResultChart", () => {
    it("draws one line per numeric column and a legend for several", () => {
        const { container } = renderWithApp(<ToolResultChart kind="line" rows={rows} />);
        expect(container.querySelectorAll("svg path").length).toBeGreaterThanOrEqual(2);
        expect(screen.getByText("income")).toBeInTheDocument();
        expect(screen.getByText("spending")).toBeInTheDocument();
        expect(screen.getByText("2026-08")).toBeInTheDocument();
    });

    it("draws bars per category for the requested column only", () => {
        const { container } = renderWithApp(
            <ToolResultChart kind="bar" rows={rows} xKey="month" yKeys={["income"]} />,
        );
        expect(container.querySelectorAll("svg rect, svg path").length).toBeGreaterThanOrEqual(3);
        expect(screen.queryByText("spending")).not.toBeInTheDocument();
    });

    it("draws a donut with name and share labels", () => {
        const { container } = renderWithApp(
            <ToolResultChart
                kind="pie"
                rows={[
                    { name: "Food", value: 30 },
                    { name: "Rent", value: 70 },
                ]}
            />,
        );
        expect(container.querySelectorAll("svg path").length).toBe(2);
        expect(screen.getByText(/Food\s+30\s?%/)).toBeInTheDocument();
        expect(screen.getByText(/Rent\s+70\s?%/)).toBeInTheDocument();
    });

    it("shows the empty message without rows or numeric values", () => {
        renderWithApp(<ToolResultChart kind="line" rows={[]} />);
        renderWithApp(
            <ToolResultChart kind="pie" rows={[{ name: "x", value: 0 }]} />,
        );
        expect(screen.getAllByText(/no chart data|aiChat.noChartData/i)).toHaveLength(2);
    });
});
