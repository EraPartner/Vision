/**
 * AreaChart — visx + framer-motion area chart primitive.
 *
 * Features:
 *  - Single or multi series
 *  - Optional stacking
 *  - Token-only gradient fills
 *  - Motion-driven draw-in (respects prefers-reduced-motion)
 *  - Optional horizontal ReferenceLine
 *  - Crosshair tooltip powered by ChartTooltip
 */
import { curveMonotoneX } from "@visx/curve";
import { summarizeSeriesChart } from "./chartAria";
import { LinearGradient } from "@visx/gradient";
import { Group } from "@visx/group";
import { ParentSize } from "@visx/responsive";
import { scaleLinear, scaleTime } from "@visx/scale";
import { AreaClosed, AreaStack, Line, LinePath } from "@visx/shape";
import { bisector, extent, max, min } from "d3-array";
import { motion, useReducedMotion } from "framer-motion";
import { memo, useCallback, useId, useMemo, useRef, useState } from "react";

import { BottomAxis, LeftAxis, RightAxis } from "./ChartAxis";
import { useChartSync } from "./ChartSyncContext";
import { formatScrubDelta, useChartScrub } from "./scrub";
import { ChartTooltip, type ChartTooltipDatum } from "./ChartTooltip";
import { CHART_NEUTRAL, getChartColor } from "./palette";
import { durations, easings } from "@/lib/motion";
import { useLanguage } from "@/contexts/LanguageContext";
import { useAppSettings } from "@/contexts/AppSettingsContext";
import { formatDateWithAppSettings } from "@/components/shared/dateUtils";

export interface AreaSeries<Datum> {
    readonly key: string;
    readonly label?: string;
    readonly accessor: (datum: Datum) => number | null | undefined;
    readonly color?: string;
    readonly dashed?: boolean;
    readonly strokeWidth?: number;
    readonly fillOpacity?: number;
}

export interface AreaReferenceLine {
    readonly y: number;
    readonly label?: string;
    readonly color?: string;
    readonly dashed?: boolean;
}

export interface AreaChartProps<Datum> {
    readonly data: ReadonlyArray<Datum>;
    readonly xAccessor: (datum: Datum) => Date | number;
    readonly series: ReadonlyArray<AreaSeries<Datum>>;
    readonly height?: number;
    readonly stacked?: boolean;
    readonly yDomain?: readonly [number, number];
    readonly xIsDate?: boolean;
    readonly xTickFormat?: (value: Date | number) => string;
    readonly yTickFormat?: (value: number) => string;
    readonly yAxisSide?: "left" | "right";
    readonly numYTicks?: number;
    readonly xTickValues?: ReadonlyArray<Date | number>;
    readonly referenceLines?: ReadonlyArray<AreaReferenceLine>;
    readonly tooltipTitle?: (datum: Datum) => string;
    readonly tooltipValueFormat?: (value: number, seriesKey: string) => string;
    readonly margin?: { top: number; right: number; bottom: number; left: number };
    readonly width?: number;
    readonly ariaLabel?: string;
    /** Opt into synced crosshairs with sibling charts sharing this id (needs ChartSyncProvider). */
    readonly syncId?: string;
    /** Enable pointer-drag range compare (Δ + %) on the primary series. */
    readonly scrubbable?: boolean;
}

const DEFAULT_MARGIN = { top: 16, right: 24, bottom: 28, left: 90 };

type AreaYScale = ReturnType<typeof scaleLinear<number>>;
type AreaXScale = ReturnType<typeof scaleTime<number>> | ReturnType<typeof scaleLinear<number>>;

interface AreaSeriesLayerProps<Datum> {
    readonly data: ReadonlyArray<Datum>;
    readonly series: ReadonlyArray<AreaSeries<Datum>>;
    readonly stacked: boolean | undefined;
    readonly xAccessor: (d: Datum) => Date | number;
    readonly xScale: AreaXScale;
    readonly yScale: AreaYScale;
    readonly reduce: boolean | null;
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
 */
function AreaSeriesLayerInner<Datum>({
    data,
    series,
    stacked,
    xAccessor,
    xScale,
    yScale,
    reduce,
    gradId,
    revealId,
}: AreaSeriesLayerProps<Datum>) {
    return (
        <g clipPath={`url(#${revealId})`}>
        {stacked ? (
            <AreaStack<Datum>
                keys={series.map((s) => s.key)}
                data={data as Datum[]}
                curve={curveMonotoneX}
                value={(d, key) => {
                    const s = series.find((x) => x.key === key);
                    return s ? (s.accessor(d) ?? 0) : 0;
                }}
                x={(d) => xScale(xAccessor(d.data) as never) ?? 0}
                y0={(d) => yScale(d[0]) ?? 0}
                y1={(d) => yScale(d[1]) ?? 0}
            >
                {({ stacks, path }) =>
                    stacks.map((stack, i) => {
                        const s = series[i];
                        const color = s.color ?? getChartColor(i);
                        return (
                            <motion.path
                                key={`stack-${stack.key}`}
                                d={path(stack) || ""}
                                fill={color}
                                fillOpacity={0.55}
                                stroke={color}
                                strokeOpacity={0.95}
                                strokeWidth={1.5}
                                initial={
                                    reduce ? { opacity: 1 } : { opacity: 0, y: 12 }
                                }
                                animate={{ opacity: 1, y: 0 }}
                                transition={{
                                    duration: reduce ? 0 : durations.slow,
                                    ease: easings.outExpo,
                                    delay: i * 0.04,
                                }}
                            />
                        );
                    })
                }
            </AreaStack>
        ) : (
            series.map((s, i) => {
                const color = s.color ?? getChartColor(i);
                return (
                    <g key={s.key}>
                        <motion.g
                            initial={reduce ? { opacity: 1 } : { opacity: 0 }}
                            animate={{ opacity: 1 }}
                            transition={{
                                duration: reduce ? 0 : durations.slow,
                                ease: easings.outExpo,
                                delay: i * 0.04,
                            }}
                        >
                            {s.fillOpacity !== 0 && (
                                <AreaClosed<Datum>
                                    data={data as Datum[]}
                                    x={(d) => xScale(xAccessor(d) as never) ?? 0}
                                    y={(d) => yScale(s.accessor(d) ?? 0) ?? 0}
                                    yScale={yScale}
                                    curve={curveMonotoneX}
                                    fill={`url(#${gradId}-${s.key})`}
                                    fillOpacity={s.fillOpacity ?? 1}
                                />
                            )}
                            <LinePath<Datum>
                                data={data as Datum[]}
                                x={(d) => xScale(xAccessor(d) as never) ?? 0}
                                y={(d) => yScale(s.accessor(d) ?? 0) ?? 0}
                                curve={curveMonotoneX}
                                stroke={color}
                                strokeWidth={s.strokeWidth ?? 2}
                                strokeDasharray={s.dashed ? "5 4" : undefined}
                                fill="none"
                            />
                        </motion.g>
                    </g>
                );
            })
        )}
        </g>
    );
}

// memo() erases the generic signature; the cast restores it for callers.
const AreaSeriesLayer = memo(AreaSeriesLayerInner) as typeof AreaSeriesLayerInner;

export function AreaChart<Datum>(props: AreaChartProps<Datum>) {
    const { height = 280, width } = props;

    if (width !== undefined) {
        return <AreaChartInner {...props} width={width} height={height} />;
    }

    return (
        <div style={{ width: "100%", height }}>
            <ParentSize>
                {({ width: w, height: h }) =>
                    w > 0 && h > 0 ? (
                        <AreaChartInner {...props} width={w} height={h} />
                    ) : null
                }
            </ParentSize>
        </div>
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
    const reduce = useReducedMotion();

    const innerWidth = Math.max(0, width - margin.left - margin.right);
    const innerHeight = Math.max(0, height - margin.top - margin.bottom);

    // Prevent inline xAccessor props from invalidating memoized derivations every render.
    // The ref always tracks the latest accessor; the stable wrapper never changes identity.
    const xAccessorRef = useRef(xAccessor);
    xAccessorRef.current = xAccessor;
     
    const stableXAccessor = useCallback((d: Datum) => xAccessorRef.current(d), []);

    const xValues = useMemo(() => data.map((d) => stableXAccessor(d)), [data, stableXAccessor]);

    const xScale = useMemo(() => {
        if (xIsDate) {
            const [xMin, xMax] = extent(xValues as Date[]);
            return scaleTime({
                range: [0, innerWidth],
                domain: [xMin ?? new Date(), xMax ?? new Date()],
            });
        }
        const nums = xValues as number[];
        return scaleLinear({
            range: [0, innerWidth],
            domain: [Math.min(...nums), Math.max(...nums)],
        });
    }, [innerWidth, xIsDate, xValues]);

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
                series.reduce((sum, s) => sum + (s.accessor(d) ?? 0), 0),
            );
            const stackMin = min(data, (d) =>
                series.reduce((sum, s) => sum + (s.accessor(d) ?? 0), 0),
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
        const lo = values.length ? Math.min(...values) : 0;
        const hi = values.length ? Math.max(...values) : 1;
        const pad = (hi - lo) * 0.08 || 1;
        return scaleLinear({
            range: [innerHeight, 0],
            domain: [lo - pad, hi + pad],
            nice: true,
        });
    }, [data, innerHeight, referenceLines, series, stacked, yDomain]);

    const bisect = useMemo(
        () => bisector<Datum, Date | number>((d) => stableXAccessor(d) as Date).center,
        [stableXAccessor],
    );

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
            const idx = bisect(data, x0 as never);
            return idx >= 0 && idx < data.length ? idx : null;
        },
        [bisect, data, xScale],
    );

    const handleMove = useCallback(
        (event: React.PointerEvent<SVGRectElement>) => {
            const idx = indexAtClientX(event);
            if (idx == null) return;
            setHoverIndex(idx);
            publishHover(Number(stableXAccessor(data[idx])));
            if (scrub.scrubbing) scrub.move(idx);
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
            event.currentTarget.setPointerCapture(event.pointerId);
            scrub.begin(idx);
        },
        [scrubbable, indexAtClientX, scrub],
    );

    const handleUp = useCallback(() => scrub.end(), [scrub]);

    // Mirror a sibling chart's hover when not hovered locally (nearest point).
    const syncedIndex = useMemo(() => {
        if (hoverIndex != null || syncedX == null || data.length === 0) return null;
        // Only mirror when the synced x falls inside this chart's domain —
        // disjoint timelines (history vs forecast) must not pin to an edge.
        const lo = Number(stableXAccessor(data[0]));
        const hi = Number(stableXAccessor(data[data.length - 1]));
        if (syncedX < Math.min(lo, hi) || syncedX > Math.max(lo, hi)) return null;
        let best = 0;
        let bestDist = Infinity;
        for (let i = 0; i < data.length; i++) {
            const dist = Math.abs(Number(stableXAccessor(data[i])) - syncedX);
            if (dist < bestDist) { bestDist = dist; best = i; }
        }
        return best;
    }, [hoverIndex, syncedX, data, stableXAccessor]);

    const effectiveIndex = hoverIndex ?? syncedIndex;
    const hoverDatum = effectiveIndex != null ? data[effectiveIndex] : null;

    const tooltipItems: ChartTooltipDatum[] = useMemo(() => {
        if (!hoverDatum) return [];
        return series
            .map((s, i) => {
                const raw = s.accessor(hoverDatum);
                if (raw == null || !Number.isFinite(raw)) return null;
                return {
                    label: s.label ?? s.key,
                    color: s.color ?? getChartColor(i),
                    value: tooltipValueFormat ? tooltipValueFormat(raw, s.key) : String(raw),
                };
            })
            .filter((x): x is NonNullable<typeof x> => x !== null);
    }, [hoverDatum, series, tooltipValueFormat]);

    const tooltipLeft =
        hoverDatum != null ? margin.left + (xScale(xAccessor(hoverDatum) as never) ?? 0) : 0;
    const tooltipTop = margin.top;

    // useId: deterministic per render position (stable snapshots), unique per
    // chart instance — replaces the old Math.random() suffix.
    const reactId = useId();
    const gradId = `area-grad-${reactId}`;
    const revealId = `${gradId}-reveal`;

    return (
        <div style={{ position: "relative", width, height }}>
            <svg width={width} height={height} role="img" aria-label={ariaLabel ?? summarizeSeriesChart(t, 'chart.aria.kind.area', data.length, series.map((s) => s.label))}>
                <Group left={margin.left} top={margin.top}>
                    {/* Draw-in: horizontal sweep reveal (skipped under reduced motion) */}
                    <defs>
                        <clipPath id={revealId}>
                            <motion.rect
                                x={0}
                                y={-margin.top}
                                height={height}
                                initial={reduce ? { width: innerWidth } : { width: 0 }}
                                animate={{ width: innerWidth }}
                                transition={{ duration: reduce ? 0 : durations.page, ease: easings.outExpo }}
                            />
                        </clipPath>
                    </defs>
                    {series.map((s, i) => {
                        const color = s.color ?? getChartColor(i);
                        return (
                            <LinearGradient
                                key={`${gradId}-${s.key}`}
                                id={`${gradId}-${s.key}`}
                                from={color}
                                to={color}
                                fromOpacity={0.22}
                                toOpacity={0}
                            />
                        );
                    })}

                    {/* Grid */}
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

                    {/* Stacked or unstacked series paths — memoized so pointermove
                        renders never regenerate them (see AreaSeriesLayer). */}
                    <AreaSeriesLayer
                        data={data}
                        series={series}
                        stacked={stacked}
                        xAccessor={stableXAccessor}
                        xScale={xScale}
                        yScale={yScale}
                        reduce={reduce}
                        gradId={gradId}
                        revealId={revealId}
                    />

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
                                    strokeDasharray={r.dashed === false ? undefined : "4 4"}
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
                    {scrub.range ? (() => {
                        const xA = xScale(stableXAccessor(data[scrub.range.startIndex]) as never) ?? 0;
                        const xB = xScale(stableXAccessor(data[scrub.range.endIndex]) as never) ?? 0;
                        return (
                            <rect
                                x={Math.min(xA, xB)}
                                y={0}
                                width={Math.abs(xB - xA)}
                                height={innerHeight}
                                fill={CHART_NEUTRAL.label}
                                fillOpacity={0.08}
                                stroke={CHART_NEUTRAL.label}
                                strokeOpacity={0.25}
                                pointerEvents="none"
                            />
                        );
                    })() : null}

                    {/* Crosshair */}
                    {hoverDatum != null ? (
                        <Line
                            from={{ x: xScale(xAccessor(hoverDatum) as never) ?? 0, y: 0 }}
                            to={{
                                x: xScale(xAccessor(hoverDatum) as never) ?? 0,
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
                        tickValues={xTickValues as never}
                        tickFormat={
                            xTickFormat
                                ? (v) => xTickFormat(v as Date | number)
                                : undefined
                        }
                    />
                    {yAxisSide === "left" ? (
                        <LeftAxis
                            scale={yScale}
                            numTicks={numYTicks}
                            tickFormat={
                                yTickFormat ? (v) => yTickFormat(v as number) : undefined
                            }
                        />
                    ) : (
                        <RightAxis
                            scale={yScale}
                            left={innerWidth}
                            numTicks={numYTicks}
                            tickFormat={
                                yTickFormat ? (v) => yTickFormat(v as number) : undefined
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
                        style={scrubbable ? { touchAction: "none", cursor: "crosshair" } : undefined}
                        onPointerMove={handleMove}
                        onPointerLeave={handleLeave}
                        onPointerDown={handleDown}
                        onPointerUp={handleUp}
                        onPointerCancel={handleUp}
                    />
                </Group>
            </svg>

            {scrub.range ? (() => {
                const first = series[0];
                const a = first?.accessor(data[scrub.range.startIndex]);
                const b = first?.accessor(data[scrub.range.endIndex]);
                if (a == null || b == null || !Number.isFinite(a) || !Number.isFinite(b)) return null;
                const fmt = (v: number) =>
                    tooltipValueFormat ? tooltipValueFormat(v, first.key) : String(Math.round(v * 100) / 100);
                const xA = margin.left + (xScale(stableXAccessor(data[scrub.range.startIndex]) as never) ?? 0);
                const xB = margin.left + (xScale(stableXAccessor(data[scrub.range.endIndex]) as never) ?? 0);
                const mid = (xA + xB) / 2;
                const rising = b - a > 0;
                return (
                    <div
                        className={`glass-thick pointer-events-none absolute z-10 -translate-x-1/2 whitespace-nowrap rounded-full px-2.5 py-1 text-xs font-semibold tabular-nums ${rising ? "text-gain" : b - a < 0 ? "text-loss" : "text-foreground"}`}
                        style={{ left: mid, top: 2 }}
                    >
                        {formatScrubDelta(a, b, fmt)}
                    </div>
                );
            })() : null}

            <ChartTooltip
                open={hoverDatum != null && !scrub.range}
                left={tooltipLeft}
                top={tooltipTop}
                title={
                    hoverDatum && tooltipTitle
                        ? tooltipTitle(hoverDatum)
                        : hoverDatum
                          ? formatHoverTitle(xAccessor(hoverDatum), appSettings.dateFormat)
                          : undefined
                }
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
