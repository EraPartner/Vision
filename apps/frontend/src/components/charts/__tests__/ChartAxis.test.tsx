// @vitest-environment jsdom

import { render } from "@testing-library/react";
import { scaleLinear } from "@visx/scale";
import { describe, expect, it } from "vitest";
import { BottomAxis, LeftAxis, RightAxis } from "../ChartAxis";

describe("ChartAxis", () => {
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
