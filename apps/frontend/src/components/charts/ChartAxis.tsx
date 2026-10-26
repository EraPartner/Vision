/**
 * ChartAxis — token-styled wrappers around @visx/axis.
 */
import { AxisBottom, AxisLeft, AxisRight } from "@visx/axis";
import { getTicks } from "@visx/scale";
import type { AxisScale } from "@visx/axis";

export interface ChartAxisProps<Scale extends AxisScale> {
    readonly scale: Scale;
    readonly top?: number | undefined;
    readonly left?: number | undefined;
    readonly numTicks?: number | undefined;
    readonly tickValues?: ReadonlyArray<number | string | Date> | undefined;
    readonly tickFormat?:
        ((value: unknown, index: number) => string) | undefined;
    readonly hideAxisLine?: boolean | undefined;
    readonly hideTicks?: boolean | undefined;
    readonly label?: string | undefined;
}

// visx's axis generics tie `tickValues`/`tickFormat` to the scale's domain type, which
// these wrappers deliberately erase (`unknown` formatter, plain tick values), hence the
// `as never` hand-offs below.
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

/** Forward only the optional axis props that were provided (visx applies its own defaults). */
function optionalAxisProps({
    numTicks,
    hideAxisLine,
    hideTicks,
    label,
}: Pick<
    ChartAxisProps<AxisScale>,
    "numTicks" | "hideAxisLine" | "hideTicks" | "label"
>) {
    return {
        ...(numTicks === undefined ? {} : { numTicks }),
        ...(hideAxisLine === undefined ? {} : { hideAxisLine }),
        ...(hideTicks === undefined ? {} : { hideTicks }),
        ...(label === undefined ? {} : { label }),
    };
}

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
            {...(top === undefined ? {} : { top })}
            {...optionalAxisProps({ numTicks, hideAxisLine, hideTicks, label })}
            tickValues={readableTicks}
            // visx's axis props are generic over the scale type and cannot express our scale union; `never` bridges tickFormat/tickValues.
            tickFormat={tickFormat as never}
            stroke={AXIS_COLOR}
            tickStroke={AXIS_COLOR}
            tickLabelProps={tickLabelProps}
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
            {...(left === undefined ? {} : { left })}
            {...optionalAxisProps({ numTicks, hideAxisLine, hideTicks, label })}
            // visx's axis props are generic over the scale type and cannot express our scale union; `never` bridges tickFormat/tickValues.
            tickValues={tickValues as never}
            // visx's axis props are generic over the scale type and cannot express our scale union; `never` bridges tickFormat/tickValues.
            tickFormat={tickFormat as never}
            stroke={AXIS_COLOR}
            tickStroke={AXIS_COLOR}
            tickLabelProps={() => tickLabelPropsSide("end")}
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
            {...(left === undefined ? {} : { left })}
            {...optionalAxisProps({ numTicks, hideAxisLine, hideTicks, label })}
            // visx's axis props are generic over the scale type and cannot express our scale union; `never` bridges tickFormat/tickValues.
            tickValues={tickValues as never}
            // visx's axis props are generic over the scale type and cannot express our scale union; `never` bridges tickFormat/tickValues.
            tickFormat={tickFormat as never}
            stroke={AXIS_COLOR}
            tickStroke={AXIS_COLOR}
            tickLabelProps={() => tickLabelPropsSide("start")}
            labelProps={{
                fill: TICK_COLOR,
                fontSize: 11,
                textAnchor: "middle",
            }}
        />
    );
}
