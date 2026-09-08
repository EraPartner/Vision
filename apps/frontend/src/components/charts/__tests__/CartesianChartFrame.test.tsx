// @vitest-environment jsdom
import { render, renderHook, screen } from "@testing-library/react";
import { Group } from "@visx/group";
import { beforeEach, describe, expect, it, vi } from "vitest";

const measuredSize = vi.hoisted(() => ({ width: 640, height: 320 }));

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
        }) => children(measuredSize),
    };
});

import {
    CartesianChartFrame,
    ResponsiveCartesianFrame,
    useCartesianFrame,
} from "../CartesianChartFrame";

const MARGIN = { top: 10, right: 20, bottom: 30, left: 40 };

beforeEach(() => {
    measuredSize.width = 640;
    measuredSize.height = 320;
});

describe("ResponsiveCartesianFrame", () => {
    it("uses measured positive bounds and suppresses an unmeasured chart", () => {
        const { rerender } = render(
            <ResponsiveCartesianFrame height={280}>
                {({ width, height }) => <span>{`${width}x${height}`}</span>}
            </ResponsiveCartesianFrame>,
        );
        expect(screen.getByText("640x320")).toBeInTheDocument();

        measuredSize.width = 0;
        rerender(
            <ResponsiveCartesianFrame height={280}>
                {({ width, height }) => <span>{`${width}x${height}`}</span>}
            </ResponsiveCartesianFrame>,
        );
        expect(screen.queryByText(/x/)).not.toBeInTheDocument();
    });

    it("preserves AreaChart's explicit width path without parent measurement", () => {
        measuredSize.width = 0;
        render(
            <ResponsiveCartesianFrame width={480} height={240}>
                {({ width, height }) => <span>{`${width}x${height}`}</span>}
            </ResponsiveCartesianFrame>,
        );
        expect(screen.getByText("480x240")).toBeInTheDocument();
    });
});

describe("useCartesianFrame", () => {
    it("builds clamped plot bounds and numeric/date x scales", () => {
        const numeric = renderHook(() =>
            useCartesianFrame({
                data: [2, 4, 8],
                xAccessor: (value) => value,
                xIsDate: false,
                width: 50,
                height: 20,
                margin: MARGIN,
            }),
        );
        expect(numeric.result.current.innerWidth).toBe(0);
        expect(numeric.result.current.innerHeight).toBe(0);
        expect(numeric.result.current.xScale.domain()).toEqual([2, 8]);

        const dates = [new Date(2025, 0, 1), new Date(2025, 0, 3)];
        const date = renderHook(() =>
            useCartesianFrame({
                data: dates,
                xAccessor: (value) => value,
                xIsDate: true,
                width: 500,
                height: 300,
                margin: MARGIN,
            }),
        );
        expect(date.result.current.innerWidth).toBe(440);
        expect(date.result.current.innerHeight).toBe(260);
        expect(date.result.current.xScale.domain()).toEqual(dates);
    });
});

describe("CartesianChartFrame", () => {
    it("renders the shared accessible shell and translated plot group", () => {
        const { container, rerender } = render(
            <CartesianChartFrame
                width={500}
                height={300}
                ariaLabel="Portfolio history"
                pointCount={2}
                onKeyDown={() => undefined}
                onBlur={() => undefined}
            >
                <Group left={MARGIN.left} top={MARGIN.top}>
                    <circle data-testid="mark" />
                </Group>
            </CartesianChartFrame>,
        );
        const svg = screen.getByRole("img", { name: "Portfolio history" });
        expect(svg).toHaveAttribute("width", "500");
        expect(svg).toHaveAttribute("height", "300");
        expect(svg).toHaveAttribute("tabindex", "0");
        expect(screen.getByTestId("mark").parentElement).toHaveAttribute(
            "transform",
            "translate(40, 10)",
        );

        rerender(
            <CartesianChartFrame
                width={500}
                height={300}
                ariaLabel="Empty history"
                pointCount={0}
                onKeyDown={() => undefined}
                onBlur={() => undefined}
            >
                <circle />
            </CartesianChartFrame>,
        );
        expect(container.querySelector("svg")).not.toHaveAttribute("tabindex");
    });
});
