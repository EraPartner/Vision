// @vitest-environment jsdom
/**
 * Range compare on the time-series chart primitives: drag across a chart in
 * either direction, or click a point and move, to read the change between
 * two points per series. The range stays after release and clears on a
 * click, Escape or blur.
 */
import { describe, expect, it, vi } from "vitest";
import { fireEvent } from "@testing-library/react";

import { renderWithApp } from "@/test/renderWithApp";
import { AreaChart } from "@/components/charts/AreaChart";
import { ComposedChart } from "@/components/charts/ComposedChart";
import { LineChart } from "@/components/charts/LineChart";
import { CHART_NEUTRAL } from "@/components/charts/palette";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogTitle,
} from "@/components/ui/dialog";

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
const X0 = 0;
const X1 = 170;
const X2 = 320;
const X3 = 480;

// One point per plot pixel: a press that wobbles 2px lands on another index.
const DENSE = Array.from({ length: 487 }, (_, i) => ({
    date: new Date(2025, 0, 1 + i),
    value: i + 1,
    cost: 0,
}));

const MOUSE = { pointerId: 1, isPrimary: true, button: 0 };

const GAIN = "hsl(var(--gain))";
const LOSS = "hsl(var(--loss))";

function overlayOf(container: HTMLElement): Element {
    const overlay = container.querySelector('rect[fill="transparent"]');
    if (!overlay) throw new Error("hover overlay not rendered");
    return overlay;
}

function frameOf(container: HTMLElement): Element {
    const svg = container.querySelector("svg[role]");
    if (!svg) throw new Error("chart svg not rendered");
    return svg;
}

function readout(container: HTMLElement): string | null {
    return (
        container.querySelector('[data-testid="chart-scrub-readout"]')
            ?.textContent ?? null
    );
}

function band(container: HTMLElement): Element | null {
    return container.querySelector('[data-testid="chart-scrub-band"]');
}

function bandFill(container: HTMLElement): string | null | undefined {
    return band(container)?.querySelector("rect")?.getAttribute("fill");
}

function drag(overlay: Element, from: number, to: number) {
    fireEvent.pointerDown(overlay, { clientX: from, ...MOUSE });
    fireEvent.pointerMove(overlay, { clientX: to, ...MOUSE });
    fireEvent.pointerUp(overlay, { clientX: to, ...MOUSE });
}

function click(overlay: Element, x: number) {
    fireEvent.pointerMove(overlay, { clientX: x, ...MOUSE });
    fireEvent.pointerDown(overlay, { clientX: x, ...MOUSE });
    fireEvent.pointerUp(overlay, { clientX: x, ...MOUSE });
}

/** A finger has no hover: it arrives on press and leaves on every lift. */
function tap(overlay: Element, x: number) {
    fireEvent.pointerDown(overlay, { clientX: x, ...MOUSE });
    fireEvent.pointerUp(overlay, { clientX: x, ...MOUSE });
    fireEvent.pointerLeave(overlay, { clientX: x, ...MOUSE });
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

function renderDense() {
    return renderWithApp(
        <AreaChart
            data={DENSE}
            xAccessor={(d) => d.date}
            series={SERIES}
            width={600}
            height={300}
            tooltipValueFormat={fmt}
            scrubbable
        />,
    );
}

describe("chart range compare", () => {
    it("reads the same earlier → later change per series in both drag directions and keeps it after release", () => {
        const { container } = renderArea(true);
        const overlay = overlayOf(container);

        drag(overlay, X1, X3);
        const rightward = readout(container);
        expect(rightward).toContain("T20 – T40");
        expect(rightward).toMatch(/Value.*Δ \+VAL:20/);
        expect(rightward).toMatch(/Cost.*Δ −VAL:10/);

        click(overlay, X0); // dismiss
        expect(readout(container)).toBeNull();

        drag(overlay, X3, X1);
        expect(readout(container)).toBe(rightward);
    });

    it("a click on a pinned range clears it", () => {
        const { container } = renderArea(true);
        const overlay = overlayOf(container);
        drag(overlay, X0, X2);
        expect(readout(container)).not.toBeNull();
        fireEvent.pointerMove(overlay, { clientX: X3 });
        expect(readout(container)).toContain("T10 – T30");
        click(overlay, X3);
        expect(readout(container)).toBeNull();
        expect(band(container)).toBeNull();
    });

    it("click anchors a point, moving stretches the range, a second click pins it", () => {
        const { container } = renderArea(true);
        const overlay = overlayOf(container);
        click(overlay, X0);
        expect(band(container)).not.toBeNull();
        expect(readout(container)).toBeNull();

        fireEvent.pointerMove(overlay, { clientX: X2 });
        expect(readout(container)).toContain("T10 – T30");
        click(overlay, X3);
        fireEvent.pointerMove(overlay, { clientX: X1 });
        expect(readout(container)).toContain("T10 – T40");
    });

    it("Escape and blur clear the range", () => {
        const { container } = renderArea(true);
        const overlay = overlayOf(container);
        const svg = frameOf(container);

        drag(overlay, X0, X2);
        fireEvent.keyDown(svg, { key: "Escape" });
        expect(readout(container)).toBeNull();

        drag(overlay, X0, X2);
        fireEvent.blur(svg);
        expect(readout(container)).toBeNull();
    });

    it("keeps a range released outside the plot when the pointer leaves", () => {
        const { container } = renderArea(true);
        const overlay = overlayOf(container);
        drag(overlay, X0, 10_000);
        fireEvent.pointerLeave(overlay, MOUSE);
        expect(readout(container)).toContain("T10 – T40");
    });

    it("keeps an anchor when the pointer brushes past the edge of the chart", () => {
        const { container } = renderArea(true);
        const overlay = overlayOf(container);
        click(overlay, X1);
        fireEvent.pointerLeave(overlay, MOUSE);
        expect(band(container)).not.toBeNull();
        fireEvent.pointerMove(overlay, { clientX: X3, ...MOUSE });
        expect(readout(container)).toContain("T20 – T40");
    });

    it("pins a range with two taps and with a drag on touch, where every lift leaves", () => {
        const { container } = renderArea(true);
        const overlay = overlayOf(container);

        tap(overlay, X0);
        expect(band(container)).not.toBeNull();
        tap(overlay, X2);
        expect(readout(container)).toContain("T10 – T30");

        tap(overlay, X2); // dismiss
        expect(readout(container)).toBeNull();

        fireEvent.pointerDown(overlay, { clientX: X1, ...MOUSE });
        fireEvent.pointerMove(overlay, { clientX: X3, ...MOUSE });
        fireEvent.pointerUp(overlay, { clientX: X3, ...MOUSE });
        fireEvent.pointerLeave(overlay, { clientX: X3, ...MOUSE });
        expect(readout(container)).toContain("T20 – T40");
    });

    it("drops a press the browser takes over for a scroll", () => {
        const { container } = renderArea(true);
        const overlay = overlayOf(container);
        fireEvent.pointerDown(overlay, { clientX: X1, ...MOUSE });
        fireEvent.pointerCancel(overlay, MOUSE);
        expect(band(container)).toBeNull();
    });

    it("treats a press that wobbles a few pixels as a click on dense data", () => {
        const { container } = renderDense();
        const overlay = overlayOf(container);

        fireEvent.pointerDown(overlay, { clientX: 100, ...MOUSE });
        fireEvent.pointerMove(overlay, { clientX: 102, ...MOUSE });
        fireEvent.pointerUp(overlay, { clientX: 102, ...MOUSE });
        expect(readout(container)).toBeNull();
        expect(band(container)).not.toBeNull();

        // The anchor stands, so the range follows from here.
        fireEvent.pointerMove(overlay, { clientX: 300, ...MOUSE });
        expect(readout(container)).not.toBeNull();

        // A second click a few pixels off the anchor cancels it.
        click(overlay, 103);
        expect(band(container)).toBeNull();
    });

    it("ignores the secondary button and a non-primary pointer", () => {
        const { container } = renderArea(true);
        const overlay = overlayOf(container);
        fireEvent.pointerDown(overlay, { clientX: X1, ...MOUSE, button: 2 });
        fireEvent.pointerUp(overlay, { clientX: X1, ...MOUSE, button: 2 });
        expect(band(container)).toBeNull();

        fireEvent.pointerDown(overlay, {
            clientX: X1,
            pointerId: 2,
            isPrimary: false,
        });
        expect(band(container)).toBeNull();
    });

    it("does not let a second finger steer or end a drag", () => {
        const { container } = renderArea(true);
        const overlay = overlayOf(container);
        const finger2 = { pointerId: 2, isPrimary: false };

        fireEvent.pointerDown(overlay, { clientX: X0, ...MOUSE });
        fireEvent.pointerMove(overlay, { clientX: X1, ...MOUSE });
        fireEvent.pointerMove(overlay, { clientX: X3, ...finger2 });
        fireEvent.pointerUp(overlay, { clientX: X3, ...finger2 });
        fireEvent.pointerMove(overlay, { clientX: X2, ...MOUSE });
        expect(readout(container)).toContain("T10 – T30");
        fireEvent.pointerUp(overlay, { clientX: X2, ...MOUSE });
        fireEvent.pointerMove(overlay, { clientX: X3, ...MOUSE });
        expect(readout(container)).toContain("T10 – T30");
    });

    it("drops the percent on a chart of percentages and keeps it elsewhere", () => {
        const percent = renderWithApp(
            <AreaChart
                data={DATA}
                xAccessor={(d) => d.date}
                series={SERIES.slice(0, 1)}
                width={600}
                height={300}
                tooltipValueFormat={fmt}
                scrubbable
                scrubPercent={false}
            />,
        );
        drag(overlayOf(percent.container), X0, X2);
        expect(readout(percent.container)).toMatch(/Δ \+VAL:20$/);
        percent.unmount();

        const { container } = renderArea(true);
        drag(overlayOf(container), X0, X2);
        expect(readout(container)).toMatch(/Value.*Δ \+VAL:20 \(\+200/);
    });

    it("leads the readout with the primary series and tints the band by it", () => {
        const flat = (key: string) => ({
            key,
            label: key,
            accessor: (d: Datum) => d.cost,
        });
        const { container } = renderWithApp(
            <AreaChart
                data={DATA}
                xAccessor={(d) => d.date}
                series={[
                    flat("a"),
                    flat("b"),
                    flat("c"),
                    flat("d"),
                    {
                        key: "main",
                        label: "Main",
                        accessor: (d: Datum) => d.value,
                        primary: true,
                    },
                ]}
                width={600}
                height={300}
                tooltipValueFormat={fmt}
                scrubbable
            />,
        );
        drag(overlayOf(container), X0, X3);
        const text = readout(container);
        // Declared last, shown first; the fifth row folds into "+1". The
        // others all fell, so a gain tint can only come from the primary.
        expect(text).toMatch(/^.*?Main.*a.*b.*c.*\+1$/);
        expect(bandFill(container)).toBe(GAIN);
    });

    it("keeps the band neutral on peer series with no primary", () => {
        const { container } = renderArea(true);
        drag(overlayOf(container), X0, X3);
        expect(bandFill(container)).toBe(CHART_NEUTRAL.label);
    });

    it("tints a single series by its own change", () => {
        const { container } = renderWithApp(
            <AreaChart
                data={DATA}
                xAccessor={(d) => d.date}
                series={SERIES.slice(1)}
                width={600}
                height={300}
                tooltipValueFormat={fmt}
                scrubbable
            />,
        );
        drag(overlayOf(container), X0, X3);
        expect(bandFill(container)).toBe(LOSS);
    });

    it("reads a series without a value at a range end from its nearest value and shows that span", () => {
        const months = ["Jan", "Feb", "Mar", "Apr"];
        const rows = [
            { i: 0, actual: 10, forecast: null, solo: null },
            { i: 1, actual: 20, forecast: null, solo: null },
            { i: 2, actual: 30, forecast: 30, solo: 5 },
            { i: 3, actual: null, forecast: 50, solo: null },
        ];
        type Row = (typeof rows)[number];
        const { container } = renderWithApp(
            <LineChart
                data={rows}
                xAccessor={(d) => DATA[d.i]?.date ?? new Date(0)}
                series={[
                    {
                        key: "actual",
                        label: "Actual",
                        accessor: (d: Row) => d.actual,
                    },
                    {
                        key: "forecast",
                        label: "Forecast",
                        accessor: (d: Row) => d.forecast,
                    },
                    { key: "solo", label: "Solo", accessor: (d: Row) => d.solo },
                ]}
                tooltipValueFormat={fmt}
                tooltipTitle={(d) => months[d.i] ?? ""}
                scrubbable
            />,
        );
        drag(overlayOf(container), X0, X3);
        const text = readout(container);
        expect(text).toMatch(/^Jan – Apr/);
        expect(text).toMatch(/Actual.*Δ \+VAL:20.*Jan – Mar/);
        expect(text).toMatch(/Forecast.*Δ \+VAL:20.*Mar – Apr/);
        expect(text).not.toContain("Solo");
    });

    it("names the series when only one of several has a row", () => {
        const { container } = renderWithApp(
            <AreaChart
                data={DATA}
                xAccessor={(d) => d.date}
                series={[
                    SERIES[0] ?? { key: "", accessor: () => 0 },
                    { key: "gap", label: "Gap", accessor: () => null },
                ]}
                width={600}
                height={300}
                tooltipValueFormat={fmt}
                scrubbable
            />,
        );
        drag(overlayOf(container), X0, X2);
        expect(readout(container)).toMatch(/Value.*Δ \+VAL:20/);
    });

    it("lets the first Escape clear the range inside a dialog and the next close it", () => {
        const onOpenChange = vi.fn();
        renderWithApp(
            <Dialog open onOpenChange={onOpenChange}>
                <DialogContent>
                    <DialogTitle>Chart</DialogTitle>
                    <DialogDescription>Price</DialogDescription>
                    <AreaChart
                        data={DATA}
                        xAccessor={(d) => d.date}
                        series={SERIES}
                        width={600}
                        height={300}
                        tooltipValueFormat={fmt}
                        scrubbable
                    />
                </DialogContent>
            </Dialog>,
        );
        const svg = frameOf(document.body);

        drag(overlayOf(document.body), X0, X2);
        fireEvent.keyDown(svg, { key: "Escape" });
        expect(readout(document.body)).toBeNull();
        expect(onOpenChange).not.toHaveBeenCalled();

        fireEvent.keyDown(svg, { key: "Escape" });
        expect(onOpenChange).toHaveBeenCalledWith(false);
    });

    it("extends a pinned range from its end on Shift+arrow, not from the hover", () => {
        const { container } = renderArea(true);
        const overlay = overlayOf(container);
        drag(overlay, X0, X2);
        fireEvent.pointerMove(overlay, { clientX: X0, ...MOUSE });
        fireEvent.keyDown(frameOf(container), {
            key: "ArrowRight",
            shiftKey: true,
        });
        expect(readout(container)).toContain("T10 – T40");
    });

    it("drops the range when the data moves to another timeline, not on a new array of it", () => {
        const chart = (data: typeof DATA) => (
            <AreaChart
                data={data}
                xAccessor={(d) => d.date}
                series={SERIES}
                width={600}
                height={300}
                tooltipValueFormat={fmt}
                tooltipTitle={(d) => `T${d.value}`}
                scrubbable
            />
        );
        const { container, rerender } = renderWithApp(chart(DATA));
        drag(overlayOf(container), X0, X2);

        rerender(chart([...DATA]));
        expect(readout(container)).toContain("T10 – T30");

        rerender(chart(DATA.slice(1)));
        expect(readout(container)).toBeNull();
    });

    it("does nothing on a chart that is not scrubbable", () => {
        const { container } = renderArea(false);
        drag(overlayOf(container), X0, X3);
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
