// @vitest-environment jsdom

import { render } from "@testing-library/react";
import { scaleLinear, scaleTime, scaleBand } from "@visx/scale";
import { describe, expect, it } from "vitest";
import { BottomAxis, LeftAxis, RightAxis } from "../ChartAxis";

describe("ChartAxis", () => {
    it("keeps time and categorical labels readable at narrow widths", () => {
        const time = scaleTime({
            domain: [new Date(2026, 0, 1), new Date(2031, 0, 1)],
            range: [0, 320],
        });
        const { container, rerender } = render(
            <svg>
                <BottomAxis
                    scale={time}
                    numTicks={20}
                    tickFormat={(v) =>
                        new Date(v as Date).toISOString().slice(0, 10)
                    }
                />
            </svg>,
        );
        expect(
            container.querySelectorAll(".visx-axis-tick").length,
        ).toBeGreaterThanOrEqual(2);
        expect(
            container.querySelectorAll(".visx-axis-tick").length,
        ).toBeLessThan(8);
        const band = scaleBand({
            domain: [
                "Long category one",
                "Long category two",
                "Long category three",
                "Long category four",
            ],
            range: [0, 320],
        });
        rerender(
            <svg>
                <BottomAxis scale={band} />
            </svg>,
        );
        expect(
            container.querySelectorAll(".visx-axis-tick").length,
        ).toBeLessThan(4);
        expect(band.domain()).toHaveLength(4);
    });

    it("reduces crowded labels without removing the underlying scale", () => {
        const scale = scaleLinear({ domain: [0, 100], range: [0, 320] });
        const { container, rerender } = render(
            <svg>
                <BottomAxis
                    scale={scale}
                    numTicks={20}
                    tickFormat={(value) => `01/01/${2000 + Number(value)}`}
                />
            </svg>,
        );
        const narrowCount =
            container.querySelectorAll(".visx-axis-tick").length;
        expect(narrowCount).toBeGreaterThanOrEqual(2);
        expect(narrowCount).toBeLessThan(10);
        scale.range([0, 1000]);
        rerender(
            <svg>
                <BottomAxis
                    scale={scale}
                    numTicks={20}
                    tickFormat={(value) => `01/01/${2000 + Number(value)}`}
                />
            </svg>,
        );
        expect(
            container.querySelectorAll(".visx-axis-tick").length,
        ).toBeGreaterThan(narrowCount);
        expect(scale.domain()).toEqual([0, 100]);
    });

    it("renders every numeric tick with tabular figures", () => {
        const scale = scaleLinear({ domain: [0, 100], range: [0, 200] });
        const { container } = render(
            <svg>
                <BottomAxis scale={scale} tickValues={[0, 50, 100]} />
                <LeftAxis scale={scale} tickValues={[0, 50, 100]} />
                <RightAxis scale={scale} tickValues={[0, 50, 100]} />
            </svg>,
        );

        const ticks = container.querySelectorAll(".visx-axis-tick text");
        expect(ticks).toHaveLength(9);
        for (const tick of ticks) {
            expect(tick).toHaveClass("tabular-nums");
            expect(tick).not.toHaveAttribute("fontVariantNumeric");
        }
    });
});
