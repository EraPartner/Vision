/**
 * AreaChart — visx area chart primitive.
 *
 * Features:
 *  - Single or multi series
 *  - Optional stacking
 *  - Token-only gradient fills
 *  - Compositor draw-in (respects prefers-reduced-motion)
 *  - Optional horizontal ReferenceLine
 *  - Crosshair tooltip powered by ChartTooltip
 */
import { axisDateOrNumber, axisNumber } from "./axisValue";
import { curveMonotoneX } from "@visx/curve";
import { summarizeSeriesChart } from "./chartAria";
import { Group } from "@visx/group";
import { scaleLinear } from "@visx/scale";
import { AreaClosed, AreaStack, Line, LinePath } from "@visx/shape";
import { bisector, max, min, sum } from "d3-array";
import {
    memo,
    type ReactNode,
    useCallback,
    useId,
    useMemo,
    useRef,
    useState,
} from "react";

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
import { ChartEntrance, ChartLayerSvg, ChartReveal } from "./chartEntrance";
import { durations } from "@/lib/motion";
import { useLanguage } from "@/stores/hydration/LanguageHydration";
import { useAppSettings } from "@/stores/hydration/AppSettingsHydration";
import { formatDateWithAppSettings } from "@/lib/dateUtils";
import { usePercentFormatter } from "@/hooks/useCurrencyFormatter";
import { useFullEffects } from "@/hooks/useVisualEffectsTier";

export interface AreaSeries<Datum> {
    readonly key: string;
    readonly label?: string | undefined;
    readonly accessor: (datum: Datum) => number | null | undefined;
    readonly color?: string | undefined;
    readonly dashed?: boolean | undefined;
    readonly strokeWidth?: number | undefined;
    readonly fillOpacity?: number | undefined;
}

export interface AreaReferenceLine {
    readonly y: number;
    readonly label?: string | undefined;
    readonly color?: string | undefined;
    readonly dashed?: boolean | undefined;
}

export interface AreaChartProps<Datum> {
    readonly data: ReadonlyArray<Datum>;
    readonly xAccessor: (datum: Datum) => Date | number;
    readonly series: ReadonlyArray<AreaSeries<Datum>>;
    readonly height?: number | undefined;
    readonly stacked?: boolean | undefined;
    readonly yDomain?: readonly [number, number] | undefined;
    readonly xIsDate?: boolean | undefined;
    readonly xTickFormat?: ((value: Date | number) => string) | undefined;
    readonly yTickFormat?: ((value: number) => string) | undefined;
    readonly yAxisSide?: "left" | "right" | undefined;
    readonly numYTicks?: number | undefined;
    readonly xTickValues?: ReadonlyArray<Date | number> | undefined;
    readonly referenceLines?: ReadonlyArray<AreaReferenceLine> | undefined;
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
    readonly width?: number | undefined;
    readonly ariaLabel?: string | undefined;
    /** Opt into synced crosshairs with sibling charts sharing this id (needs ChartSyncProvider). */
    readonly syncId?: string | undefined;
    /** Enable range compare (Δ + % per series): drag across the chart, or click a point and move. */
    readonly scrubbable?: boolean | undefined;
}

const DEFAULT_MARGIN = { top: 16, right: 24, bottom: 28, left: 90 };

type AreaYScale = ReturnType<typeof scaleLinear<number>>;
type AreaXScale = CartesianXScale;

interface AreaSeriesLayerProps<Datum> {
    readonly data: ReadonlyArray<Datum>;
    readonly series: ReadonlyArray<AreaSeries<Datum>>;
    readonly stacked: boolean | undefined;
    readonly xAccessor: (d: Datum) => Date | number;
    readonly xScale: AreaXScale;
    readonly yScale: AreaYScale;
    readonly width: number;
    readonly height: number;
    readonly marginLeft: number;
    readonly marginTop: number;
    readonly innerWidth: number;
    readonly gradId: string;
    readonly revealId: string;
}

/**
 * The expensive part of the chart: every series path (monotone curve fit over
 * N points). Isolated behind React.memo so hover/scrub state changes in
 * AreaChartInner — which fire on every pointermove — re-render only the cheap
 * crosshair/tooltip overlays, never the paths. All props are referentially
 * stable across those renders (scales are memoized, xAccessor is the stable
 * wrapper), so pointermove renders hit the memo cache.
 *
 * Each series is its own `<svg>` inside an HTML entrance wrapper, all inside
 * one sweep reveal (see chartEntrance.tsx), stacked between the grid layer
 * and the accessible frame. The static `<clipPath>` keeps the plot-area clip
 * the reveal rect used to leave behind once it reached full width.
 */
function AreaSeriesLayerInner<Datum>({
    data,
    series,
    stacked,
    xAccessor,
    xScale,
    yScale,
    width,
    height,
    marginLeft,
    marginTop,
    innerWidth,
    gradId,
    revealId,
}: AreaSeriesLayerProps<Datum>) {
    const seriesSvg = (clipId: string, defs: ReactNode, mark: ReactNode) => (
        <svg width={width} height={height} aria-hidden="true" focusable="false">
            <Group left={marginLeft} top={marginTop}>
                <defs>
                    <clipPath id={clipId}>
                        <rect
                            x={0}
                            y={-marginTop}
                            width={innerWidth}
                            height={height}
                        />
                    </clipPath>
                    {defs}
                </defs>
                <g clipPath={`url(#${clipId})`}>{mark}</g>
            </Group>
        </svg>
    );

    return (
        <ChartReveal
            width={width}
            height={height}
            plotLeft={marginLeft}
            plotWidth={innerWidth}
        >
            {stacked ? (
                <AreaStack<Datum>
                    keys={series.map((s) => s.key)}
                    // visx takes a mutable array; the prop is a ReadonlyArray that visx never writes to.
                    data={data as Datum[]}
                    curve={curveMonotoneX}
                    value={(d, key) => {
                        const s = series.find((x) => x.key === key);
                        return s ? (s.accessor(d) ?? 0) : 0;
                    }}
                    x={(d) => xScale(xAccessor(d.data))}
                    y0={(d) => yScale(d[0])}
                    y1={(d) => yScale(d[1])}
                >
                    {({ stacks, path }) =>
                        stacks.map((stack, i) => {
                            const color = series[i]?.color ?? getChartColor(i);
                            return (
                                <ChartEntrance
                                    key={`stack-${stack.key}`}
                                    effect="rise"
                                    duration={durations.slow}
                                    delay={i * 0.04}
                                    width={width}
                                    height={height}
                                >
                                    {seriesSvg(
                                        `${revealId}-stack-${stack.key}`,
                                        null,
                                        <path
                                            d={path(stack) || ""}
                                            fill={color}
                                            fillOpacity={0.55}
                                            stroke={color}
                                            strokeOpacity={0.95}
                                            strokeWidth={1.5}
                                        />,
                                    )}
                                </ChartEntrance>
                            );
                        })
                    }
                </AreaStack>
            ) : (
                series.map((s, i) => {
                    const color = s.color ?? getChartColor(i);
                    return (
                        <ChartEntrance
                            key={s.key}
                            effect="fade"
                            duration={durations.slow}
                            delay={i * 0.04}
                            width={width}
                            height={height}
                        >
                            {seriesSvg(
                                `${revealId}-${s.key}`,
                                <linearGradient
                                    id={`${gradId}-${s.key}`}
                                    x1="0"
                                    y1="0"
                                    x2="0"
                                    y2="1"
                                >
                                    <stop offset="0%" stopColor={color} stopOpacity={0.22} />
                                    <stop offset="100%" stopColor={color} stopOpacity={0} />
                                </linearGradient>,
                                <>
                                    {s.fillOpacity !== 0 && (
                                        <AreaClosed<Datum>
                                            // visx takes a mutable array; the prop is a ReadonlyArray that visx never writes to.
                                            data={data as Datum[]}
                                            x={(d) => xScale(xAccessor(d))}
                                            y={(d) =>
                                                yScale(s.accessor(d) ?? 0)
                                            }
                                            yScale={yScale}
                                            curve={curveMonotoneX}
                                            fill={`url(#${gradId}-${s.key})`}
                                            fillOpacity={s.fillOpacity ?? 1}
                                        />
                                    )}
                                    <LinePath<Datum>
                                        // visx takes a mutable array; the prop is a ReadonlyArray that visx never writes to.
                                        data={data as Datum[]}
                                        x={(d) => xScale(xAccessor(d))}
                                        y={(d) => yScale(s.accessor(d) ?? 0)}
                                        curve={curveMonotoneX}
                                        stroke={color}
                                        strokeWidth={s.strokeWidth ?? 2}
                                        strokeDasharray={
                                            s.dashed ? "5 4" : undefined
                                        }
                                        fill="none"
                                    />
                                </>,
                            )}
                        </ChartEntrance>
                    );
                })
            )}
        </ChartReveal>
    );
}

// memo() erases the generic signature; the cast restores it for callers.
const AreaSeriesLayer = memo(
    AreaSeriesLayerInner,
) as typeof AreaSeriesLayerInner;

export function AreaChart<Datum>(props: AreaChartProps<Datum>) {
    const { height = 280, width } = props;
    return (
        <ResponsiveCartesianFrame width={width} height={height}>
            {(size) => <AreaChartInner {...props} {...size} />}
        </ResponsiveCartesianFrame>
    );
}

interface InnerProps<Datum> extends AreaChartProps<Datum> {
    readonly width: number;
    readonly height: number;
}

function AreaChartInner<Datum>({
    data,
    xAccessor,
    series,
    stacked,
    yDomain,
    xIsDate = true,
    xTickFormat,
    yTickFormat,
    yAxisSide = "left",
    numYTicks = 5,
    xTickValues,
    referenceLines,
    tooltipTitle,
    tooltipValueFormat,
    margin = DEFAULT_MARGIN,
    width,
    height,
    ariaLabel,
    syncId,
    scrubbable = false,
}: InnerProps<Datum>) {
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
        if (stacked) {
            const stackMax = max(data, (d) =>
                sum(series, (s) => s.accessor(d) ?? 0),
            );
            const stackMin = min(data, (d) =>
                sum(series, (s) => s.accessor(d) ?? 0),
            );
            return scaleLinear({
                range: [innerHeight, 0],
                domain: [Math.min(0, stackMin ?? 0), stackMax ?? 0],
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
            for (const r of referenceLines) values.push(r.y);
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
    }, [data, innerHeight, referenceLines, series, stacked, yDomain]);

    const bisect = useMemo(() => {
        const bisectX = bisector<Datum, Date | number>((d) =>
            stableXAccessor(d),
        );
        return (array: ArrayLike<Datum>, x: Date | number) =>
            bisectX.center(array, x);
    }, [stableXAccessor]);

    const [hoverIndex, setHoverIndex] = useState<number | null>(null);
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
            setHoverIndex(idx);
            publishHover(Number(stableXAccessor(datum)));
            scrub.hover(idx);
        },
        [indexAtClientX, publishHover, stableXAccessor, data, scrub],
    );

    const handleLeave = useCallback(() => {
        overlayRectRef.current = null;
        setHoverIndex(null);
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
            setHoverIndex(idx);
            publishHover(Number(stableXAccessor(datum)));
        },
        [publishHover, stableXAccessor, data],
    );
    const { onKeyDown: handleKeyDown, onBlur: handleBlur } =
        useChartKeyboardNav({
            pointCount: data.length,
            index: hoverIndex,
            onIndexChange: stepToIndex,
            onClear: handleLeave,
            scrub: scrubbable ? scrub : undefined,
        });

    // Mirror a sibling chart's hover when not hovered locally (nearest point).
    const syncedIndex = useMemo(() => {
        if (hoverIndex != null || syncedX == null) return null;
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
    }, [hoverIndex, syncedX, data, stableXAccessor]);

    const effectiveIndex = hoverIndex ?? syncedIndex;
    const hoverDatum = effectiveIndex != null ? data[effectiveIndex] : null;

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
    const tooltipTop = margin.top;

    const titleOf = (datum: Datum) =>
        tooltipTitle
            ? tooltipTitle(datum)
            : formatHoverTitle(xAccessor(datum), appSettings.dateFormat);

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

    // useId: deterministic per render position (stable snapshots), unique per
    // chart instance — replaces the old Math.random() suffix.
    const reactId = useId();
    const gradId = `area-grad-${reactId}`;
    const revealId = `${gradId}-reveal`;

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

            {/* Stacked or unstacked series paths — memoized so pointermove
                renders never regenerate them (see AreaSeriesLayer). */}
            <AreaSeriesLayer
                data={data}
                series={series}
                stacked={stacked}
                xAccessor={stableXAccessor}
                xScale={xScale}
                yScale={yScale}
                width={width}
                height={height}
                marginLeft={margin.left}
                marginTop={margin.top}
                innerWidth={innerWidth}
                gradId={gradId}
                revealId={revealId}
            />

            <CartesianChartFrame
                className="relative"
                width={width}
                height={height}
                ariaLabel={
                    ariaLabel ??
                    summarizeSeriesChart(
                        t,
                        "chart.aria.kind.area",
                        data.length,
                        series.map((s) => s.label),
                    )
                }
                pointCount={data.length}
                onKeyDown={handleKeyDown}
                onBlur={handleBlur}
            >
                <Group left={margin.left} top={margin.top}>
                    {/* Reference lines */}
                    {referenceLines?.map((r, i) => {
                        const y = yScale(r.y);
                        const color = r.color ?? CHART_NEUTRAL.label;
                        return (
                            <g key={`ref-${i}`}>
                                <Line
                                    from={{ x: 0, y }}
                                    to={{ x: innerWidth, y }}
                                    stroke={color}
                                    strokeWidth={1}
                                    strokeDasharray={
                                        r.dashed === false ? undefined : "4 4"
                                    }
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

                    {/* Scrub range band */}
                    {scrubbed ? (
                        <ScrubBand
                            xStart={xScale(stableXAccessor(scrubbed.startDatum))}
                            xEnd={xScale(stableXAccessor(scrubbed.endDatum))}
                            innerHeight={innerHeight}
                            rows={scrubbed.rows}
                            // Stacked bands sit on cumulative values; dots on
                            // the raw values would float off the marks.
                            startMarkers={
                                stacked
                                    ? undefined
                                    : scrubbed.rows.map((r) => ({
                                          key: r.key,
                                          y: yScale(r.start),
                                          color: r.color,
                                      }))
                            }
                            endMarkers={
                                stacked
                                    ? undefined
                                    : scrubbed.rows.map((r) => ({
                                          key: r.key,
                                          y: yScale(r.end),
                                          color: r.color,
                                      }))
                            }
                        />
                    ) : null}

                    {/* Crosshair */}
                    {hoverDatum != null ? (
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
                            pointerEvents="none"
                        />
                    ) : null}

                    {/* Axes */}
                    <BottomAxis
                        scale={xScale}
                        top={innerHeight}
                        numTicks={Math.max(2, Math.floor(innerWidth / 90))}
                        tickValues={xTickValues}
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

                    {/* Hover capture */}
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
                    xStart={
                        margin.left + xScale(stableXAccessor(scrubbed.startDatum))
                    }
                    xEnd={margin.left + xScale(stableXAccessor(scrubbed.endDatum))}
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
                top={tooltipTop}
                title={hoverDatum != null ? titleOf(hoverDatum) : undefined}
                items={tooltipItems}
            />
        </div>
    );
}

// App date format, not the browser locale — an nl-app user with an en-US
// browser otherwise got US date order in tooltips.
function formatHoverTitle(x: Date | number, appDateFormat: string): string {
    if (x instanceof Date) return formatDateWithAppSettings(x, appDateFormat);
    return String(x);
}
