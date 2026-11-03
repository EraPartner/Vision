// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { ScrubReadout } from "@/components/charts/ScrubOverlay";
import { scrubView, type ScrubSeries } from "@/components/charts/scrub";
import { must } from "@/test/must";

interface Point {
    readonly date: string;
    readonly actual: number | null;
    readonly forecast: number;
}

// Actuals stop before the range ends, so their row is partial and shows its span.
const DATA: Point[] = [
    { date: "2026-01", actual: 100, forecast: 100 },
    { date: "2026-02", actual: 110, forecast: 120 },
    { date: "2026-03", actual: null, forecast: 130 },
];

const SERIES: ScrubSeries<Point>[] = [
    {
        key: "actual",
        label: "Actual",
        color: "currentColor",
        value: (d) => d.actual,
        primary: true,
    },
    {
        key: "forecast",
        label: "Forecast",
        color: "currentColor",
        value: (d) => d.forecast,
    },
];

function renderReadout(width: number) {
    const view = must(
        scrubView(
            { range: { startIndex: 0, endIndex: 2 }, anchorIndex: 0 },
            DATA,
            SERIES,
        ),
    );
    render(
        <ScrubReadout
            view={view}
            titleOf={(d) => d.date}
            xStart={40}
            xEnd={200}
            width={width}
            top={2}
            formatValue={(v) => String(v)}
            formatPercent={undefined}
            fullEffects={false}
        />,
    );
    return screen.getByRole("status");
}

describe("ScrubReadout", () => {
    it("caps a readout with a partial row at the chart-box width", () => {
        const readout = renderReadout(320);

        expect(readout).toHaveTextContent("2026-01 – 2026-02");
        expect(readout.style.maxWidth).toBe("320px");
    });

    it("sets no cap before the chart box has a width", () => {
        const readout = renderReadout(0);

        expect(readout).toHaveTextContent("2026-01 – 2026-02");
        expect(readout.style.maxWidth).toBe("");
    });
});
