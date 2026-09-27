/**
 * ChartAxis — token-styled wrappers around @visx/axis.
 */
import { AxisBottom, AxisLeft, AxisRight } from "@visx/axis";
import { getTicks } from "@visx/scale";
import type { AxisScale } from "@visx/axis";

export interface ChartAxisProps<Scale extends AxisScale> {
    readonly scale: Scale;
    readonly top?: number;
    readonly left?: number;
    readonly numTicks?: number;
    readonly tickValues?: ReadonlyArray<number | string | Date>;
    readonly tickFormat?: (value: unknown, index: number) => string;
    readonly hideAxisLine?: boolean;
    readonly hideTicks?: boolean;
    readonly label?: string;
}

const TICK_COLOR = "hsl(var(--muted-foreground))";
const AXIS_COLOR = "hsl(var(--border))";

const tickLabelProps = () =>
    ({
        fill: TICK_COLOR,
        fontSize: 11,
        fontFamily: "inherit",
        className: "tabular-nums",
        textAnchor: "middle" as const,
    }) as const;

const tickLabelPropsSide = (anchor: "start" | "end") =>
    ({
        fill: TICK_COLOR,
        fontSize: 11,
        fontFamily: "inherit",
        className: "tabular-nums",
        textAnchor: anchor,
        dy: "0.33em",
    }) as const;

export function BottomAxis<Scale extends AxisScale>({
    scale,
    top,
    numTicks,
    tickValues,
    tickFormat,
    hideAxisLine,
    hideTicks,
    label,
}: ChartAxisProps<Scale>) {
    // D3's tick count is a suggestion; retain only labels with room to read.
    let previousRight = -Infinity;
    const readableTicks = (tickValues ?? getTicks(scale, numTicks)).filter(
        (value, index) => {
            const position = Number(scale(value as never));
            const labelText = tickFormat
                ? tickFormat(value, index)
                : String(value);
            const halfWidth = Array.from(labelText).length * 3.5;
            if (
                !Number.isFinite(position) ||
                position - halfWidth < previousRight + 12
            )
                return false;
            previousRight = position + halfWidth;
            return true;
        },
    );
    return (
        <AxisBottom
            scale={scale}
            top={top}
            numTicks={numTicks}
            tickValues={readableTicks as never}
            tickFormat={tickFormat as never}
            stroke={AXIS_COLOR}
            tickStroke={AXIS_COLOR}
            hideAxisLine={hideAxisLine}
            hideTicks={hideTicks}
            tickLabelProps={tickLabelProps}
            label={label}
            labelProps={{
                fill: TICK_COLOR,
                fontSize: 11,
                textAnchor: "middle",
            }}
        />
    );
}

export function LeftAxis<Scale extends AxisScale>({
    scale,
    left,
    numTicks,
    tickValues,
    tickFormat,
    hideAxisLine,
    hideTicks,
    label,
}: ChartAxisProps<Scale>) {
    return (
        <AxisLeft
            scale={scale}
            left={left}
            numTicks={numTicks}
            tickValues={tickValues as never}
            tickFormat={tickFormat as never}
            stroke={AXIS_COLOR}
            tickStroke={AXIS_COLOR}
            hideAxisLine={hideAxisLine}
            hideTicks={hideTicks}
            tickLabelProps={() => tickLabelPropsSide("end")}
            label={label}
            labelProps={{
                fill: TICK_COLOR,
                fontSize: 11,
                textAnchor: "middle",
            }}
        />
    );
}

export function RightAxis<Scale extends AxisScale>({
    scale,
    left,
    numTicks,
    tickValues,
    tickFormat,
    hideAxisLine,
    hideTicks,
    label,
}: ChartAxisProps<Scale>) {
    return (
        <AxisRight
            scale={scale}
            left={left}
            numTicks={numTicks}
            tickValues={tickValues as never}
            tickFormat={tickFormat as never}
            stroke={AXIS_COLOR}
            tickStroke={AXIS_COLOR}
            hideAxisLine={hideAxisLine}
            hideTicks={hideTicks}
            tickLabelProps={() => tickLabelPropsSide("start")}
            label={label}
            labelProps={{
                fill: TICK_COLOR,
                fontSize: 11,
                textAnchor: "middle",
            }}
        />
    );
}
