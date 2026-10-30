/**
 * LineChart — visx multi-series line chart.
 */
import { axisDateOrNumber, axisNumber } from "./axisValue";
import { curveMonotoneX } from "@visx/curve";
import { summarizeSeriesChart } from "./chartAria";
import { Group } from "@visx/group";
import { scaleLinear } from "@visx/scale";
import { Line, LinePath } from "@visx/shape";
import { bisector, max, min } from "d3-array";
import { memo, useCallback, useMemo, useRef, useState } from "react";

import { BottomAxis, LeftAxis, RightAxis } from "./ChartAxis";
import {
    CartesianChartFrame,
    type CartesianXScale,
    ResponsiveCartesianFrame,
    useCartesianFrame,
} from "./CartesianChartFrame";
import { useChartSync } from "./ChartSyncContext";
import { useChartKeyboardNav } from "./keyboardNav";
import { ScrubBand, ScrubReadout } from "./ScrubOverlay";
import { scrubView, useChartScrub, type ScrubSeries } from "./scrub";
import { ChartTooltip, type ChartTooltipDatum } from "./ChartTooltip";
import { CHART_NEUTRAL, getChartColor } from "./palette";
import { ChartEntrance, ChartLayerSvg } from "./chartEntrance";
import { durations } from "@/lib/motion";
import { useLanguage } from "@/stores/hydration/LanguageHydration";
import { useAppSettings } from "@/stores/hydration/AppSettingsHydration";
import { formatDateWithAppSettings } from "@/lib/dateUtils";
import { usePercentFormatter } from "@/hooks/useCurrencyFormatter";
import { useFullEffects } from "@/hooks/useVisualEffectsTier";

export interface LineSeries<Datum> {
    readonly key: string;
    readonly label?: string | undefined;
    readonly accessor: (datum: Datum) => number | null | undefined;
    readonly color?: string | undefined;
    readonly dashed?: boolean | undefined;
    readonly strokeWidth?: number | undefined;
    readonly connectNulls?: boolean | undefined;
}

export interface LineReferenceLine {
    readonly y?: number | undefined;
    readonly x?: Date | number | undefined;
    readonly label?: string | undefined;
    readonly color?: string | undefined;
    readonly dashed?: boolean | undefined;
}

export interface LineChartProps<Datum> {
    readonly data: ReadonlyArray<Datum>;
    readonly xAccessor: (datum: Datum) => Date | number;
    readonly series: ReadonlyArray<LineSeries<Datum>>;
    readonly height?: number | undefined;
    readonly xIsDate?: boolean | undefined;
    readonly xTickFormat?: ((value: Date | number) => string) | undefined;
    readonly yTickFormat?: ((value: number) => string) | undefined;
    readonly yAxisSide?: "left" | "right" | undefined;
    readonly numYTicks?: number | undefined;
    readonly referenceLines?: ReadonlyArray<LineReferenceLine> | undefined;
    readonly tooltipTitle?: ((datum: Datum) => string) | undefined;
    readonly tooltipValueFormat?:
        ((value: number, seriesKey: string) => string) | undefined;
    readonly margin?:
        | {
              top: number;
              right: number;
              bottom: number;
              left: number;
          }
        | undefined;
    readonly yDomain?: readonly [number, number] | undefined;
    readonly ariaLabel?: string | undefined;
    /** Opt into synced crosshairs with sibling charts sharing this id (needs ChartSyncProvider). */
    readonly syncId?: string | undefined;
    /** Enable range compare (Δ + % per series): drag across the chart, or click a point and move. */
    readonly scrubbable?: boolean | undefined;
}

const DEFAULT_MARGIN = { top: 16, right: 24, bottom: 28, left: 90 };

type LineYScale = ReturnType<typeof scaleLinear<number>>;
type LineXScale = CartesianXScale;

interface LineSeriesLayerProps<Datum> {
    readonly data: ReadonlyArray<Datum>;
    readonly series: ReadonlyArray<LineSeries<Datum>>;
    readonly xAccessor: (d: Datum) => Date | number;
    readonly xScale: LineXScale;
    readonly yScale: LineYScale;
    readonly width: number;
    readonly height: number;
    readonly marginLeft: number;
    readonly marginTop: number;
}

/**
 * Series paths behind React.memo: hover state changes in Inner fire per
 * pointermove and must not re-run the per-series filtering + monotone curve
 * fits below. All props are referentially stable across those renders.
 *
 * Each series is its own `<svg>` in an HTML fade wrapper (chartEntrance.tsx),
 * stacked between the grid layer and the accessible frame.
 */
function LineSeriesLayerInner<Datum>({
    data,
    series,
    xAccessor,
    xScale,
    yScale,
    width,
    height,
    marginLeft,
    marginTop,
}: LineSeriesLayerProps<Datum>) {
    return (
        <>
            {series.map((s, i) => {
                const color = s.color ?? getChartColor(i);
                const connectNulls = s.connectNulls !== false;
                // connectNulls=true → drop null points so the path runs
                // continuously through the remaining ones; false → keep
                // them and let `defined` (below) break the path at each
                // gap. These were inverted (true left gaps, false bridged).
                const filtered = connectNulls
                    ? (data as Datum[]).filter((d) => {
                          const v = s.accessor(d);
                          return v != null && Number.isFinite(v);
                      })
                    // visx takes a mutable array; the prop is a ReadonlyArray that visx never writes to.
                    : (data as Datum[]);
                return (
                    <ChartEntrance
                        key={s.key}
                        effect="fade"
                        duration={durations.slow}
                        delay={i * 0.05}
                        width={width}
                        height={height}
                    >
                        <svg
                            width={width}
                            height={height}
                            aria-hidden="true"
                            focusable="false"
                        >
                            <Group left={marginLeft} top={marginTop}>
                                <LinePath<Datum>
                                    data={filtered}
                                    x={(d) => xScale(xAccessor(d))}
                                    y={(d) => yScale(s.accessor(d) ?? 0)}
                                    curve={curveMonotoneX}
                                    stroke={color}
                                    strokeWidth={s.strokeWidth ?? 2}
                                    strokeDasharray={
                                        s.dashed ? "5 4" : undefined
                                    }
                                    fill="none"
                                    defined={(d) => {
                                        const v = s.accessor(d);
                                        return v != null && Number.isFinite(v);
                                    }}
                                />
                            </Group>
                        </svg>
                    </ChartEntrance>
                );
            })}
        </>
    );
}

// memo() erases the generic signature; the cast restores it for callers.
const LineSeriesLayer = memo(
    LineSeriesLayerInner,
) as typeof LineSeriesLayerInner;

export function LineChart<Datum>(props: LineChartProps<Datum>) {
    const { height = 280 } = props;
    return (
        <ResponsiveCartesianFrame height={height}>
            {(size) => <Inner {...props} {...size} />}
        </ResponsiveCartesianFrame>
    );
}

function Inner<Datum>({
    data,
    xAccessor,
    series,
    xIsDate = true,
    xTickFormat,
    yTickFormat,
    yAxisSide = "left",
    numYTicks = 5,
    referenceLines,
    tooltipTitle,
    tooltipValueFormat,
    margin = DEFAULT_MARGIN,
    yDomain,
    width,
    height,
    ariaLabel,
    syncId,
    scrubbable = false,
}: LineChartProps<Datum> & { width: number; height: number }) {
    const { t } = useLanguage();
    const { appSettings } = useAppSettings();
    const formatPercent = usePercentFormatter();
    const fullEffects = useFullEffects();

    const { innerWidth, innerHeight, stableXAccessor, xScale } =
        useCartesianFrame({
            data,
            xAccessor,
            xIsDate,
            width,
            height,
            margin,
        });

    const yScale = useMemo(() => {
        if (yDomain) {
            return scaleLinear({
                range: [innerHeight, 0],
                domain: [yDomain[0], yDomain[1]],
                nice: true,
            });
        }
        const values: number[] = [];
        for (const d of data) {
            for (const s of series) {
                const v = s.accessor(d);
                if (typeof v === "number" && Number.isFinite(v)) values.push(v);
            }
        }
        if (referenceLines) {
            for (const r of referenceLines) {
                if (typeof r.y === "number") values.push(r.y);
            }
        }
        // values is finite-filtered above, so d3 min/max match Math.min/max(...)
        // exactly while avoiding the spread stack-size hazard on large series.
        const lo = values.length > 0 ? (min(values) ?? 0) : 0;
        const hi = values.length > 0 ? (max(values) ?? 1) : 1;
        const pad = hi !== lo ? (hi - lo) * 0.08 : 1;
        return scaleLinear({
            range: [innerHeight, 0],
            domain: [lo - pad, hi + pad],
            nice: true,
        });
    }, [data, innerHeight, referenceLines, series, yDomain]);

    const bisect = useMemo(() => {
        const bisectX = bisector<Datum, Date | number>((d) =>
            stableXAccessor(d),
        );
        return (array: ArrayLike<Datum>, x: Date | number) =>
            bisectX.center(array, x);
    }, [stableXAccessor]);

    const [hoverIdx, setHoverIdx] = useState<number | null>(null);
    const { syncedX, publishHover } = useChartSync(syncId);
    const scrub = useChartScrub();

    // Cache the overlay rect for the duration of a hover session instead of
    // calling getBoundingClientRect on every pointermove (forced layout per
    // frame). Cleared on pointerleave so the next hover re-measures.
    const overlayRectRef = useRef<DOMRect | null>(null);

    const indexAtClientX = useCallback(
        (event: React.PointerEvent<SVGRectElement>) => {
            let rect = overlayRectRef.current;
            if (!rect) {
                rect = event.currentTarget.getBoundingClientRect();
                overlayRectRef.current = rect;
            }
            const x = event.clientX - rect.left;
            const x0 = xScale.invert(x);
            const idx = bisect(data, x0);
            return idx >= 0 && idx < data.length ? idx : null;
        },
        [bisect, data, xScale],
    );

    const handleMove = useCallback(
        (event: React.PointerEvent<SVGRectElement>) => {
            const idx = indexAtClientX(event);
            if (idx == null) return;
            const datum = data[idx];
            if (datum === undefined) return;
            setHoverIdx(idx);
            publishHover(Number(stableXAccessor(datum)));
            scrub.hover(idx);
        },
        [indexAtClientX, publishHover, stableXAccessor, data, scrub],
    );

    const handleLeave = useCallback(() => {
        overlayRectRef.current = null;
        setHoverIdx(null);
        publishHover(null);
        scrub.end();
    }, [publishHover, scrub]);

    const handleDown = useCallback(
        (event: React.PointerEvent<SVGRectElement>) => {
            if (!scrubbable) return;
            const idx = indexAtClientX(event);
            if (idx == null) return;
            // Keep receiving moves while the button is held outside the plot.
            event.currentTarget.setPointerCapture(event.pointerId);
            scrub.press(idx);
        },
        [scrubbable, indexAtClientX, scrub],
    );

    const handleUp = useCallback(() => scrub.release(), [scrub]);

    // Keyboard path (←/→, Home/End, Shift+←/→, Escape) — drives the same
    // hover/scrub state as the pointer, so tooltip/crosshair render unchanged.
    const stepToIndex = useCallback(
        (idx: number) => {
            const datum = data[idx];
            if (datum === undefined) return;
            setHoverIdx(idx);
            publishHover(Number(stableXAccessor(datum)));
        },
        [publishHover, stableXAccessor, data],
    );
    const { onKeyDown: handleKeyDown, onBlur: handleBlur } =
        useChartKeyboardNav({
            pointCount: data.length,
            index: hoverIdx,
            onIndexChange: stepToIndex,
            onClear: handleLeave,
            scrub: scrubbable ? scrub : undefined,
        });

    const syncedIdx = useMemo(() => {
        if (hoverIdx != null || syncedX == null) return null;
        const firstDatum = data[0];
        const lastDatum = data.at(-1);
        if (firstDatum === undefined || lastDatum === undefined) return null;
        // Only mirror when the synced x falls inside this chart's domain —
        // disjoint timelines (history vs forecast) must not pin to an edge.
        const lo = Number(stableXAccessor(firstDatum));
        const hi = Number(stableXAccessor(lastDatum));
        if (syncedX < Math.min(lo, hi) || syncedX > Math.max(lo, hi))
            return null;
        let best = 0;
        let bestDist = Infinity;
        data.forEach((datum, i) => {
            const dist = Math.abs(Number(stableXAccessor(datum)) - syncedX);
            if (dist < bestDist) {
                bestDist = dist;
                best = i;
            }
        });
        return best;
    }, [hoverIdx, syncedX, data, stableXAccessor]);

    const effectiveIdx = hoverIdx ?? syncedIdx;
    const hoverDatum = effectiveIdx != null ? data[effectiveIdx] : null;

    const tooltipItems: ChartTooltipDatum[] = useMemo(() => {
        if (hoverDatum == null) return [];
        return series
            .map((s, i) => {
                const raw = s.accessor(hoverDatum);
                if (raw == null || !Number.isFinite(raw)) return null;
                return {
                    label: s.label ?? s.key,
                    color: s.color ?? getChartColor(i),
                    value: tooltipValueFormat
                        ? tooltipValueFormat(raw, s.key)
                        : String(raw),
                };
            })
            .filter((x): x is NonNullable<typeof x> => x !== null);
    }, [hoverDatum, series, tooltipValueFormat]);

    const tooltipLeft =
        hoverDatum != null
            ? margin.left + (xScale(xAccessor(hoverDatum)))
            : 0;

    const titleOf = (datum: Datum) =>
        tooltipTitle
            ? tooltipTitle(datum)
            : formatTitle(xAccessor(datum), appSettings.dateFormat);

    const scrubSeries = useMemo<ScrubSeries<Datum>[]>(
        () =>
            series.map((s, i) => ({
                key: s.key,
                label: s.label,
                color: s.color ?? getChartColor(i),
                value: s.accessor,
            })),
        [series],
    );
    const scrubbed = scrubbable ? scrubView(scrub, data, scrubSeries) : null;
    const formatScrubValue = (v: number, key: string) =>
        tooltipValueFormat
            ? tooltipValueFormat(v, key)
            : String(Math.round(v * 100) / 100);

    return (
        <div style={{ position: "relative", width, height }}>
            {/* Grid, under the series layer. */}
            <ChartLayerSvg width={width} height={height}>
                <Group left={margin.left} top={margin.top}>
                    {yScale.ticks(numYTicks).map((tick) => (
                        <line
                            key={`grid-${tick}`}
                            x1={0}
                            x2={innerWidth}
                            y1={yScale(tick)}
                            y2={yScale(tick)}
                            stroke={CHART_NEUTRAL.grid}
                            strokeOpacity={0.35}
                            strokeDasharray="2 4"
                        />
                    ))}
                </Group>
            </ChartLayerSvg>

            {/* Series paths — memoized so pointermove renders never
                regenerate them (see LineSeriesLayer). */}
            <LineSeriesLayer
                data={data}
                series={series}
                xAccessor={stableXAccessor}
                xScale={xScale}
                yScale={yScale}
                width={width}
                height={height}
                marginLeft={margin.left}
                marginTop={margin.top}
            />

            <CartesianChartFrame
                className="relative"
                width={width}
                height={height}
                ariaLabel={
                    ariaLabel ??
                    summarizeSeriesChart(
                        t,
                        "chart.aria.kind.line",
                        data.length,
                        series.map((s) => s.label),
                    )
                }
                pointCount={data.length}
                onKeyDown={handleKeyDown}
                onBlur={handleBlur}
            >
                <Group left={margin.left} top={margin.top}>
                    {referenceLines?.map((r, i) => {
                        const color = r.color ?? CHART_NEUTRAL.label;
                        const dashAttr = r.dashed === false ? undefined : "4 4";
                        if (r.x != null) {
                            const x = xScale(r.x);
                            return (
                                <g key={`ref-${i}`}>
                                    <Line
                                        from={{ x, y: 0 }}
                                        to={{ x, y: innerHeight }}
                                        stroke={color}
                                        strokeWidth={1}
                                        strokeDasharray={dashAttr}
                                    />
                                    {r.label ? (
                                        <text
                                            x={x + 4}
                                            y={12}
                                            textAnchor="start"
                                            fontSize={11}
                                            fill={color}
                                        >
                                            {r.label}
                                        </text>
                                    ) : null}
                                </g>
                            );
                        }
                        if (r.y == null) return null;
                        const y = yScale(r.y);
                        return (
                            <g key={`ref-${i}`}>
                                <Line
                                    from={{ x: 0, y }}
                                    to={{ x: innerWidth, y }}
                                    stroke={color}
                                    strokeWidth={1}
                                    strokeDasharray={dashAttr}
                                />
                                {r.label ? (
                                    <text
                                        x={innerWidth - 4}
                                        y={y - 4}
                                        textAnchor="end"
                                        fontSize={11}
                                        fill={color}
                                    >
                                        {r.label}
                                    </text>
                                ) : null}
                            </g>
                        );
                    })}

                    {hoverDatum != null ? (
                        <>
                            <Line
                                from={{
                                    x: xScale(xAccessor(hoverDatum)),
                                    y: 0,
                                }}
                                to={{
                                    x: xScale(xAccessor(hoverDatum)),
                                    y: innerHeight,
                                }}
                                stroke={CHART_NEUTRAL.label}
                                strokeWidth={1}
                                strokeDasharray="3 3"
                                strokeOpacity={0.5}
                            />
                            {series.map((s, i) => {
                                const v = s.accessor(hoverDatum);
                                if (v == null || !Number.isFinite(v))
                                    return null;
                                const color = s.color ?? getChartColor(i);
                                return (
                                    <circle
                                        key={`dot-${s.key}`}
                                        cx={xScale(xAccessor(hoverDatum))}
                                        cy={yScale(v)}
                                        r={4}
                                        fill={CHART_NEUTRAL.background}
                                        stroke={color}
                                        strokeWidth={2}
                                    />
                                );
                            })}
                        </>
                    ) : null}

                    <BottomAxis
                        scale={xScale}
                        top={innerHeight}
                        numTicks={Math.max(2, Math.floor(innerWidth / 90))}
                        tickFormat={
                            xTickFormat
                                ? (v) => xTickFormat(axisDateOrNumber(v))
                                : undefined
                        }
                    />
                    {yAxisSide === "left" ? (
                        <LeftAxis
                            scale={yScale}
                            numTicks={numYTicks}
                            tickFormat={
                                yTickFormat
                                    ? (v) => yTickFormat(axisNumber(v))
                                    : undefined
                            }
                        />
                    ) : (
                        <RightAxis
                            scale={yScale}
                            left={innerWidth}
                            numTicks={numYTicks}
                            tickFormat={
                                yTickFormat
                                    ? (v) => yTickFormat(axisNumber(v))
                                    : undefined
                            }
                        />
                    )}

                    {scrubbed ? (
                        <ScrubBand
                            xStart={xScale(xAccessor(scrubbed.startDatum))}
                            xEnd={xScale(xAccessor(scrubbed.endDatum))}
                            innerHeight={innerHeight}
                            rows={scrubbed.rows}
                            startMarkers={scrubbed.rows.map((r) => ({
                                key: r.key,
                                y: yScale(r.start),
                                color: r.color,
                            }))}
                            endMarkers={scrubbed.rows.map((r) => ({
                                key: r.key,
                                y: yScale(r.end),
                                color: r.color,
                            }))}
                        />
                    ) : null}

                    <rect
                        x={0}
                        y={0}
                        width={innerWidth}
                        height={innerHeight}
                        fill="transparent"
                        style={
                            scrubbable
                                ? { touchAction: "pan-y", cursor: "crosshair" }
                                : undefined
                        }
                        onPointerMove={handleMove}
                        onPointerLeave={handleLeave}
                        onPointerDown={handleDown}
                        onPointerUp={handleUp}
                        onPointerCancel={handleLeave}
                    />
                </Group>
            </CartesianChartFrame>

            {scrubbed?.isRange ? (
                <ScrubReadout
                    xStart={margin.left + xScale(xAccessor(scrubbed.startDatum))}
                    xEnd={margin.left + xScale(xAccessor(scrubbed.endDatum))}
                    width={width}
                    top={2}
                    startTitle={titleOf(scrubbed.startDatum)}
                    endTitle={titleOf(scrubbed.endDatum)}
                    rows={scrubbed.rows}
                    formatValue={formatScrubValue}
                    formatPercent={formatPercent}
                    fullEffects={fullEffects}
                />
            ) : null}

            <ChartTooltip
                open={hoverDatum != null && !scrub.range}
                left={tooltipLeft}
                top={margin.top}
                title={hoverDatum != null ? titleOf(hoverDatum) : undefined}
                items={tooltipItems}
            />
        </div>
    );
}

// App date format, not the browser locale — an nl-app user with an en-US
// browser otherwise got US date order in tooltips.
function formatTitle(x: Date | number, appDateFormat: string): string {
    if (x instanceof Date) return formatDateWithAppSettings(x, appDateFormat);
    return String(x);
}
