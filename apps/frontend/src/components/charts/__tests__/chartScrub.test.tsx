// @vitest-environment jsdom
/**
 * Range compare on the time-series chart primitives: drag across a chart in
 * either direction, or click a point and move, to read the change between
 * two points per series. The range stays after release and clears on a
 * click, Escape, or the pointer leaving the chart.
 */
import { describe, expect, it, vi } from "vitest";
import { fireEvent } from "@testing-library/react";

import { renderWithApp } from "@/test/renderWithApp";
import { AreaChart } from "@/components/charts/AreaChart";
import { ComposedChart } from "@/components/charts/ComposedChart";
import { LineChart } from "@/components/charts/LineChart";

// ParentSize measures 0×0 in jsdom; give responsive charts a fixed box.
vi.mock("@visx/responsive", async (importOriginal) => {
    const mod = await importOriginal<typeof import("@visx/responsive")>();
    return {
        ...mod,
        ParentSize: ({
            children,
        }: {
            children: (size: {
                width: number;
                height: number;
            }) => React.ReactNode;
        }) => children({ width: 600, height: 300 }),
    };
});

const DATA = [
    { date: new Date(2025, 0, 1), value: 10, cost: 100 },
    { date: new Date(2025, 1, 1), value: 20, cost: 90 },
    { date: new Date(2025, 2, 1), value: 30, cost: 95 },
    { date: new Date(2025, 3, 1), value: 40, cost: 80 },
];
type Datum = (typeof DATA)[number];
const SERIES = [
    { key: "value", label: "Value", accessor: (d: Datum) => d.value },
    { key: "cost", label: "Cost", accessor: (d: Datum) => d.cost },
];
const fmt = (v: number) => `VAL:${v}`;

// Plot x (jsdom rects sit at 0) of each point: 600 wide, 90 + 24 margins.
const X = [0, 170, 320, 480];

function overlayOf(container: HTMLElement): Element {
    const overlay = container.querySelector('rect[fill="transparent"]');
    if (!overlay) throw new Error("hover overlay not rendered");
    return overlay;
}

function readout(container: HTMLElement): string | null {
    return (
        container.querySelector('[data-testid="chart-scrub-readout"]')
            ?.textContent ?? null
    );
}

function drag(overlay: Element, from: number, to: number) {
    fireEvent.pointerDown(overlay, { clientX: from, pointerId: 1 });
    fireEvent.pointerMove(overlay, { clientX: to, pointerId: 1 });
    fireEvent.pointerUp(overlay, { clientX: to, pointerId: 1 });
}

function click(overlay: Element, x: number) {
    fireEvent.pointerMove(overlay, { clientX: x, pointerId: 1 });
    fireEvent.pointerDown(overlay, { clientX: x, pointerId: 1 });
    fireEvent.pointerUp(overlay, { clientX: x, pointerId: 1 });
}

function renderArea(scrubbable: boolean) {
    return renderWithApp(
        <AreaChart
            data={DATA}
            xAccessor={(d) => d.date}
            series={SERIES}
            width={600}
            height={300}
            tooltipValueFormat={fmt}
            tooltipTitle={(d) => `T${d.value}`}
            scrubbable={scrubbable}
        />,
    );
}

describe("chart range compare", () => {
    it("reads the same earlier → later change per series in both drag directions and keeps it after release", () => {
        const { container } = renderArea(true);
        const overlay = overlayOf(container);

        drag(overlay, X[1] ?? 0, X[3] ?? 0);
        const rightward = readout(container);
        expect(rightward).toContain("T20 – T40");
        expect(rightward).toMatch(/Value.*Δ \+VAL:20/);
        expect(rightward).toMatch(/Cost.*Δ −VAL:10/);

        click(overlay, X[0] ?? 0); // dismiss
        expect(readout(container)).toBeNull();

        drag(overlay, X[3] ?? 0, X[1] ?? 0);
        expect(readout(container)).toBe(rightward);
    });

    it("a click on a pinned range clears it", () => {
        const { container } = renderArea(true);
        const overlay = overlayOf(container);
        drag(overlay, X[0] ?? 0, X[2] ?? 0);
        expect(readout(container)).not.toBeNull();
        fireEvent.pointerMove(overlay, { clientX: X[3] ?? 0 });
        expect(readout(container)).toContain("T10 – T30");
        click(overlay, X[3] ?? 0);
        expect(readout(container)).toBeNull();
        expect(
            container.querySelector('[data-testid="chart-scrub-band"]'),
        ).toBeNull();
    });

    it("click anchors a point, moving stretches the range, a second click pins it", () => {
        const { container } = renderArea(true);
        const overlay = overlayOf(container);
        click(overlay, X[0] ?? 0);
        expect(
            container.querySelector('[data-testid="chart-scrub-band"]'),
        ).not.toBeNull();
        expect(readout(container)).toBeNull();

        fireEvent.pointerMove(overlay, { clientX: X[2] ?? 0 });
        expect(readout(container)).toContain("T10 – T30");
        click(overlay, X[3] ?? 0);
        fireEvent.pointerMove(overlay, { clientX: X[1] ?? 0 });
        expect(readout(container)).toContain("T10 – T40");
    });

    it("Escape and leaving the chart clear the range", () => {
        const { container } = renderArea(true);
        const overlay = overlayOf(container);
        const svg = container.querySelector("svg[role]");
        if (!svg) throw new Error("chart svg not rendered");

        drag(overlay, X[0] ?? 0, X[2] ?? 0);
        fireEvent.keyDown(svg, { key: "Escape" });
        expect(readout(container)).toBeNull();

        drag(overlay, X[0] ?? 0, X[2] ?? 0);
        fireEvent.pointerLeave(overlay);
        expect(readout(container)).toBeNull();
    });

    it("does nothing on a chart that is not scrubbable", () => {
        const { container } = renderArea(false);
        drag(overlayOf(container), X[0] ?? 0, X[3] ?? 0);
        expect(readout(container)).toBeNull();
    });

    it("works on line and composed charts", () => {
        const line = renderWithApp(
            <LineChart
                data={DATA}
                xAccessor={(d) => d.date}
                series={SERIES}
                tooltipValueFormat={fmt}
                scrubbable
            />,
        );
        drag(overlayOf(line.container), 0, 10_000);
        expect(readout(line.container)).toMatch(/Value.*Δ \+VAL:30/);
        line.unmount();

        const composed = renderWithApp(
            <ComposedChart
                data={DATA}
                xAccessor={(d) => d.date}
                series={[
                    {
                        key: "close",
                        label: "Close",
                        type: "line",
                        accessor: (d) => d.value,
                    },
                ]}
                tooltipValueFormat={fmt}
                scrubbable
            />,
        );
        // Past the last point clamps to it.
        drag(overlayOf(composed.container), 0, 10_000);
        expect(readout(composed.container)).toMatch(/Δ \+VAL:30/);
    });
});
