// @vitest-environment jsdom
/**
 * Keyboard access to per-point chart values (TODO: "Per-point chart values are
 * unreachable without a pointer").
 *
 * Covers the shared key map (keyboardNav.ts) plus its wiring into each chart
 * primitive: focus + ←/→ steps the SAME hover state the pointer drives (so the
 * existing tooltip renders), Home/End jump, Shift+←/→ extends a scrub range on
 * scrubbable charts, and Escape/blur clear so no tooltip lingers. Pointer
 * behavior must be byte-identical to before — asserted at the end.
 */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, renderHook, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { KeyboardEvent } from "react";

import { renderWithApp } from "@/test/renderWithApp";
import { useChartKeyboardNav } from "@/components/charts/keyboardNav";
import { AreaChart } from "@/components/charts/AreaChart";
import { LineChart } from "@/components/charts/LineChart";
import { BarChart } from "@/components/charts/BarChart";
import { ComposedChart } from "@/components/charts/ComposedChart";
import { DonutChart } from "@/components/charts/DonutChart";
import { PieChart } from "@/components/charts/PieChart";
import { StackedBarChart } from "@/components/charts/StackedBarChart";

// ParentSize measures 0×0 in jsdom, which suppresses every chart's inner
// render; give it a fixed viewport so LineChart/BarChart mount their SVGs.
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

function keyEvent(key: string, shiftKey = false): KeyboardEvent {
    return {
        key,
        shiftKey,
        preventDefault: vi.fn(),
    } as unknown as KeyboardEvent;
}

describe("useChartKeyboardNav (shared key map)", () => {
    function setup(
        index: number | null,
        pointCount = 5,
        scrub?: Parameters<typeof useChartKeyboardNav>[0]["scrub"],
    ) {
        const onIndexChange = vi.fn();
        const onClear = vi.fn();
        const { result } = renderHook(() =>
            useChartKeyboardNav({
                pointCount,
                index,
                onIndexChange,
                onClear,
                scrub,
            }),
        );
        return { result, onIndexChange, onClear };
    }

    it("ArrowRight from no highlight starts at the first point; ArrowLeft starts at the last", () => {
        const right = setup(null);
        const e1 = keyEvent("ArrowRight");
        right.result.current.onKeyDown(e1);
        expect(right.onIndexChange).toHaveBeenCalledWith(0);
        expect(e1.preventDefault).toHaveBeenCalled();

        const left = setup(null);
        left.result.current.onKeyDown(keyEvent("ArrowLeft"));
        expect(left.onIndexChange).toHaveBeenCalledWith(4);
    });

    it("steps by one and clamps at both ends", () => {
        const mid = setup(2);
        mid.result.current.onKeyDown(keyEvent("ArrowRight"));
        expect(mid.onIndexChange).toHaveBeenCalledWith(3);
        mid.result.current.onKeyDown(keyEvent("ArrowLeft"));
        expect(mid.onIndexChange).toHaveBeenCalledWith(1);

        const atEnd = setup(4);
        atEnd.result.current.onKeyDown(keyEvent("ArrowRight"));
        expect(atEnd.onIndexChange).toHaveBeenCalledWith(4);

        const atStart = setup(0);
        atStart.result.current.onKeyDown(keyEvent("ArrowLeft"));
        expect(atStart.onIndexChange).toHaveBeenCalledWith(0);
    });

    it("Home/End jump to first/last", () => {
        const { result, onIndexChange } = setup(2);
        result.current.onKeyDown(keyEvent("Home"));
        expect(onIndexChange).toHaveBeenCalledWith(0);
        result.current.onKeyDown(keyEvent("End"));
        expect(onIndexChange).toHaveBeenCalledWith(4);
    });

    it("does not consume keys it does not handle", () => {
        const { result, onIndexChange, onClear } = setup(2);
        const e = keyEvent("a");
        result.current.onKeyDown(e);
        expect(e.preventDefault).not.toHaveBeenCalled();
        expect(onIndexChange).not.toHaveBeenCalled();
        expect(onClear).not.toHaveBeenCalled();
    });

    it("Escape clears when something is highlighted, and passes through otherwise", () => {
        const active = setup(2);
        const e1 = keyEvent("Escape");
        active.result.current.onKeyDown(e1);
        expect(active.onClear).toHaveBeenCalled();
        expect(e1.preventDefault).toHaveBeenCalled();

        // Nothing to clear → not consumed, so an enclosing dialog still gets it.
        const idle = setup(null);
        const e2 = keyEvent("Escape");
        idle.result.current.onKeyDown(e2);
        expect(idle.onClear).not.toHaveBeenCalled();
        expect(e2.preventDefault).not.toHaveBeenCalled();
    });

    it("with zero points nothing is handled or consumed", () => {
        const { result, onIndexChange } = setup(null, 0);
        const e = keyEvent("ArrowRight");
        result.current.onKeyDown(e);
        expect(onIndexChange).not.toHaveBeenCalled();
        expect(e.preventDefault).not.toHaveBeenCalled();
    });

    it("Shift+arrow anchors then extends a scrub; a plain arrow ends it", () => {
        const scrub = {
            scrubbing: false,
            begin: vi.fn(),
            move: vi.fn(),
            end: vi.fn(),
        };
        const first = setup(1, 5, scrub);
        first.result.current.onKeyDown(keyEvent("ArrowRight", true));
        expect(scrub.begin).toHaveBeenCalledWith(1);
        expect(scrub.move).toHaveBeenCalledWith(2);
        expect(first.onIndexChange).toHaveBeenCalledWith(2);

        const active = {
            ...scrub,
            scrubbing: true,
            begin: vi.fn(),
            move: vi.fn(),
            end: vi.fn(),
        };
        const second = setup(2, 5, active);
        second.result.current.onKeyDown(keyEvent("ArrowRight", true));
        expect(active.begin).not.toHaveBeenCalled();
        expect(active.move).toHaveBeenCalledWith(3);

        second.result.current.onKeyDown(keyEvent("ArrowLeft"));
        expect(active.end).toHaveBeenCalled();
    });

    it("blur clears", () => {
        const { result, onClear } = setup(2);
        result.current.onBlur();
        expect(onClear).toHaveBeenCalled();
    });
});

// ── Component wiring ────────────────────────────────────────────────────────

const DATA = [
    { date: new Date(2025, 0, 1), value: 10 },
    { date: new Date(2025, 1, 1), value: 20 },
    { date: new Date(2025, 2, 1), value: 30 },
    { date: new Date(2025, 3, 1), value: 40 },
];
const SERIES = [
    {
        key: "value",
        label: "Value",
        accessor: (d: (typeof DATA)[number]) => d.value,
    },
];
const fmt = (v: number) => `VAL:${v}`;

function getSvg(container: HTMLElement): SVGSVGElement {
    const svg = container.querySelector("svg");
    if (!svg) throw new Error("chart svg not rendered");
    return svg;
}

async function expectTooltipValue(v: number) {
    // Tooltip renders into a body portal; presence of the formatted value is
    // the readout contract.
    await waitFor(() => expect(screen.getByText(fmt(v))).toBeInTheDocument());
}

async function expectNoTooltipValues() {
    await waitFor(() => {
        expect(screen.queryByText(/^VAL:/)).not.toBeInTheDocument();
    });
}

describe("AreaChart keyboard access", () => {
    function renderChart(scrubbable = false) {
        return renderWithApp(
            <AreaChart
                data={DATA}
                xAccessor={(d) => d.date}
                series={SERIES}
                width={600}
                height={300}
                tooltipValueFormat={fmt}
                scrubbable={scrubbable}
            />,
        );
    }

    it("is focusable via Tab and ArrowRight reads the first point through the existing tooltip", async () => {
        const user = userEvent.setup();
        const { container } = renderChart();
        const svg = getSvg(container);
        expect(svg).toHaveAttribute("tabindex", "0");
        expect(svg).toHaveAttribute("role", "img");
        expect(svg.getAttribute("aria-label")).toBeTruthy();

        await user.tab();
        expect(document.activeElement).toBe(svg);
        await user.keyboard("{ArrowRight}");
        await expectTooltipValue(10);
    });

    it("steps, clamps at both ends, and Home/End jump", async () => {
        const { container } = renderChart();
        const svg = getSvg(container);
        fireEvent.keyDown(svg, { key: "ArrowRight" });
        fireEvent.keyDown(svg, { key: "ArrowRight" });
        await expectTooltipValue(20);
        fireEvent.keyDown(svg, { key: "End" });
        await expectTooltipValue(40);
        fireEvent.keyDown(svg, { key: "ArrowRight" }); // clamped
        await expectTooltipValue(40);
        fireEvent.keyDown(svg, { key: "Home" });
        await expectTooltipValue(10);
        fireEvent.keyDown(svg, { key: "ArrowLeft" }); // clamped
        await expectTooltipValue(10);
    });

    it("Escape clears the readout; blur clears it too", async () => {
        const { container } = renderChart();
        const svg = getSvg(container);
        fireEvent.keyDown(svg, { key: "ArrowRight" });
        await expectTooltipValue(10);
        fireEvent.keyDown(svg, { key: "Escape" });
        await expectNoTooltipValues();

        fireEvent.keyDown(svg, { key: "ArrowRight" });
        await expectTooltipValue(10);
        fireEvent.blur(svg);
        await expectNoTooltipValues();
    });

    it("Shift+ArrowRight extends the range-compare scrub (Δ readout), Escape clears it", async () => {
        const { container } = renderChart(true);
        const svg = getSvg(container);
        fireEvent.keyDown(svg, { key: "ArrowRight" }); // point 0
        fireEvent.keyDown(svg, { key: "ArrowRight", shiftKey: true }); // anchor 0 → head 1
        await waitFor(() => expect(container.textContent).toMatch(/Δ/));
        fireEvent.keyDown(svg, { key: "Escape" });
        await waitFor(() => expect(container.textContent).not.toMatch(/Δ/));
    });

    it("pointer interaction is unchanged: pointermove shows the tooltip, leave hides it", async () => {
        const { container } = renderChart();
        const overlay = container.querySelector('rect[fill="transparent"]');
        if (!overlay) throw new Error("hover overlay not rendered");
        fireEvent.pointerMove(overlay, { clientX: 0, clientY: 50 });
        await expectTooltipValue(10);
        fireEvent.pointerLeave(overlay);
        await expectNoTooltipValues();
    });

    it("an empty chart is not a tab stop", () => {
        const { container } = renderWithApp(
            <AreaChart
                data={[]}
                xAccessor={(d: { date: Date }) => d.date}
                series={[]}
                width={600}
                height={300}
            />,
        );
        const svg = getSvg(container);
        expect(svg).not.toHaveAttribute("tabindex");
    });
});

describe("LineChart keyboard access", () => {
    it("focus + arrows step the hover readout; Escape clears", async () => {
        const { container } = renderWithApp(
            <LineChart
                data={DATA}
                xAccessor={(d) => d.date}
                series={SERIES}
                tooltipValueFormat={fmt}
            />,
        );
        const svg = getSvg(container);
        expect(svg).toHaveAttribute("tabindex", "0");
        fireEvent.keyDown(svg, { key: "ArrowRight" });
        await expectTooltipValue(10);
        fireEvent.keyDown(svg, { key: "ArrowRight" });
        await expectTooltipValue(20);
        fireEvent.keyDown(svg, { key: "Escape" });
        await expectNoTooltipValues();
    });
});

describe("BarChart keyboard access", () => {
    const BAR_DATA = [
        { label: "Jan", total: 5 },
        { label: "Feb", total: 15 },
        { label: "Mar", total: 25 },
    ];

    it("arrows step per category through the existing tooltip; blur clears", async () => {
        const { container } = renderWithApp(
            <BarChart
                data={BAR_DATA}
                categoryAccessor={(d) => d.label}
                series={[
                    {
                        key: "total",
                        label: "Total",
                        accessor: (d: (typeof BAR_DATA)[number]) => d.total,
                    },
                ]}
                tooltipValueFormat={fmt}
            />,
        );
        const svg = getSvg(container);
        expect(svg).toHaveAttribute("tabindex", "0");
        fireEvent.keyDown(svg, { key: "ArrowRight" });
        await expectTooltipValue(5);
        fireEvent.keyDown(svg, { key: "ArrowRight" });
        await expectTooltipValue(15);
        fireEvent.keyDown(svg, { key: "End" });
        await expectTooltipValue(25);
        fireEvent.blur(svg);
        await expectNoTooltipValues();
    });
});

describe("remaining chart primitive keyboard access", () => {
    const CATEGORIES = [
        { label: "Jan", first: 5, second: 2 },
        { label: "Feb", first: 15, second: 3 },
    ];
    const PROPORTIONS = [
        { name: "Food", value: 5 },
        { name: "Rent", value: 15 },
    ];

    it("steps StackedBar categories through the existing tooltip", async () => {
        const { container } = renderWithApp(
            <StackedBarChart
                data={CATEGORIES}
                categoryAccessor={(datum) => datum.label}
                series={[
                    { key: "first", accessor: (datum) => datum.first },
                    { key: "second", accessor: (datum) => datum.second },
                ]}
                tooltipValueFormat={fmt}
            />,
        );
        const svg = getSvg(container);
        expect(svg).toHaveAttribute("tabindex", "0");
        fireEvent.keyDown(svg, { key: "ArrowRight" });
        await expectTooltipValue(5);
        fireEvent.keyDown(svg, { key: "End" });
        await expectTooltipValue(15);
        fireEvent.blur(svg);
        await expectNoTooltipValues();
    });

    it("steps Donut slices through its existing center readout", async () => {
        const { container } = renderWithApp(
            <DonutChart data={PROPORTIONS} tooltipValueFormat={fmt} />,
        );
        const svg = getSvg(container);
        expect(svg).toHaveAttribute("tabindex", "0");
        fireEvent.keyDown(svg, { key: "ArrowRight" });
        expect(await screen.findByText("Food")).toBeInTheDocument();
        expect(await screen.findByText(fmt(5))).toBeInTheDocument();
        fireEvent.keyDown(svg, { key: "End" });
        expect(await screen.findByText("Rent")).toBeInTheDocument();
        fireEvent.keyDown(svg, { key: "Escape" });
        await expectNoTooltipValues();
    });

    it("steps Pie slices through the existing tooltip", async () => {
        const { container } = renderWithApp(
            <PieChart data={PROPORTIONS} tooltipValueFormat={fmt} />,
        );
        const svg = getSvg(container);
        expect(svg).toHaveAttribute("tabindex", "0");
        fireEvent.keyDown(svg, { key: "ArrowRight" });
        await expectTooltipValue(5);
        fireEvent.keyDown(svg, { key: "ArrowRight" });
        await expectTooltipValue(15);
    });

    it("steps a Composed candlestick series using its close-value tooltip", async () => {
        const candles = DATA.map((datum) => ({
            ...datum,
            open: datum.value - 1,
            high: datum.value + 2,
            low: datum.value - 2,
            close: datum.value + 1,
        }));
        const { container } = renderWithApp(
            <ComposedChart
                data={candles}
                xAccessor={(datum) => datum.date}
                xIsDate
                series={[
                    {
                        key: "ohlc",
                        type: "candlestick",
                        open: (datum) => datum.open,
                        high: (datum) => datum.high,
                        low: (datum) => datum.low,
                        close: (datum) => datum.close,
                    },
                ]}
                tooltipValueFormat={fmt}
            />,
        );
        const svg = getSvg(container);
        expect(svg).toHaveAttribute("tabindex", "0");
        fireEvent.keyDown(svg, { key: "ArrowRight" });
        await expectTooltipValue(11);
        fireEvent.keyDown(svg, { key: "End" });
        await expectTooltipValue(41);
    });

    it("keeps Donut pointer behavior and safely drops a stale last-slice index", async () => {
        const { container, rerender } = renderWithApp(
            <DonutChart data={PROPORTIONS} tooltipValueFormat={fmt} />,
        );
        const paths = container.querySelectorAll("path");
        fireEvent.pointerEnter(paths[1]);
        expect(await screen.findByText("Rent")).toBeInTheDocument();

        rerender(
            <DonutChart
                data={PROPORTIONS.slice(0, 1)}
                tooltipValueFormat={fmt}
            />,
        );
        await waitFor(() =>
            expect(screen.queryByText("Rent")).not.toBeInTheDocument(),
        );

        const svg = getSvg(container);
        fireEvent.keyDown(svg, { key: "ArrowRight" });
        expect(await screen.findByText("Food")).toBeInTheDocument();
    });

    it("keeps pointer readouts aligned with keyboard readouts for changed chart primitives", async () => {
        const stacked = renderWithApp(
            <StackedBarChart
                data={CATEGORIES}
                categoryAccessor={(datum) => datum.label}
                series={[
                    { key: "first", accessor: (datum) => datum.first },
                    { key: "second", accessor: (datum) => datum.second },
                ]}
                tooltipValueFormat={fmt}
            />,
        );
        const stackedBars = stacked.container.querySelectorAll("rect[fill]");
        fireEvent.pointerEnter(stackedBars[1]);
        await expectTooltipValue(15);
        fireEvent.pointerLeave(stackedBars[1]);
        await expectNoTooltipValues();
        stacked.unmount();

        const pie = renderWithApp(
            <PieChart data={PROPORTIONS} tooltipValueFormat={fmt} />,
        );
        const pieSlices = pie.container.querySelectorAll(
            'path[style*="cursor"]',
        );
        fireEvent.pointerEnter(pieSlices[1]);
        await expectTooltipValue(15);
        fireEvent.pointerLeave(pieSlices[1]);
        await expectNoTooltipValues();
        pie.unmount();

        const candles = DATA.map((datum) => ({
            ...datum,
            open: datum.value - 1,
            high: datum.value + 2,
            low: datum.value - 2,
            close: datum.value + 1,
        }));
        const composed = renderWithApp(
            <ComposedChart
                data={candles}
                xAccessor={(datum) => datum.date}
                xIsDate
                series={[
                    {
                        key: "ohlc",
                        type: "candlestick",
                        open: (datum) => datum.open,
                        high: (datum) => datum.high,
                        low: (datum) => datum.low,
                        close: (datum) => datum.close,
                    },
                ]}
                tooltipValueFormat={fmt}
            />,
        );
        const overlay = composed.container.querySelector(
            'rect[fill="transparent"]',
        );
        if (!overlay) throw new Error("composed pointer overlay not rendered");
        fireEvent.pointerMove(overlay, { clientX: 500 });
        await expectTooltipValue(41);
    });

    it("does not add dead tab stops to empty extended primitives", () => {
        const { container } = renderWithApp(
            <>
                <StackedBarChart
                    data={[]}
                    categoryAccessor={() => ""}
                    series={[]}
                />
                <DonutChart data={[]} />
                <PieChart data={[]} />
                <ComposedChart data={[]} xAccessor={() => 0} series={[]} />
            </>,
        );
        for (const svg of container.querySelectorAll("svg[role=img]")) {
            expect(svg).not.toHaveAttribute("tabindex");
        }
    });
});
