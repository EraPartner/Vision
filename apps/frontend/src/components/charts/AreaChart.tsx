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
import { scaleLinear } from "@visx/scale";
import { AreaClosed, AreaStack, Line, LinePath } from "@visx/shape";
import { bisector, max, min, sum } from "d3-array";
import { m, useReducedMotion } from "framer-motion";
import { memo, useCallback, useId, useMemo, useRef, useState } from "react";

import { BottomAxis, LeftAxis, RightAxis } from "./ChartAxis";
import {
    CartesianChartFrame,
    type CartesianXScale,
    ResponsiveCartesianFrame,
    useCartesianFrame,
} from "./CartesianChartFrame";
import { useChartSync } from "./ChartSyncContext";
import { useChartKeyboardNav } from "./keyboardNav";
import { formatScrubDelta, useChartScrub } from "./scrub";
import { ChartTooltip, type ChartTooltipDatum } from "./ChartTooltip";
import { CHART_NEUTRAL, getChartColor } from "./palette";
import { durations, easings } from "@/lib/motion";
import { cn } from "@/lib/utils";
import { useLanguage } from "@/stores/hydration/LanguageHydration";
import { useAppSettings } from "@/stores/hydration/AppSettingsHydration";
import { formatDateWithAppSettings } from "@/lib/dateUtils";
import { usePercentFormatter } from "@/hooks/useCurrencyFormatter";

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
    /** Enable pointer-drag range compare (Δ + %) on the primary series. */
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
                    x={(d) => xScale(xAccessor(d.data)) ?? 0}
                    y0={(d) => yScale(d[0]) ?? 0}
                    y1={(d) => yScale(d[1]) ?? 0}
                >
                    {({ stacks, path }) =>
                        stacks.map((stack, i) => {
                            const color = series[i]?.color ?? getChartColor(i);
                            return (
                                <m.path
                                    key={`stack-${stack.key}`}
                                    d={path(stack) || ""}
                                    fill={color}
                                    fillOpacity={0.55}
                                    stroke={color}
                                    strokeOpacity={0.95}
                                    strokeWidth={1.5}
                                    initial={
                                        reduce
                                            ? { opacity: 1 }
                                            : { opacity: 0, y: 12 }
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
                            <m.g
                                initial={
                                    reduce ? { opacity: 1 } : { opacity: 0 }
                                }
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
                                        x={(d) => xScale(xAccessor(d)) ?? 0}
                                        y={(d) =>
                                            yScale(s.accessor(d) ?? 0) ?? 0
                                        }
                                        yScale={yScale}
                                        curve={curveMonotoneX}
                                        fill={`url(#${gradId}-${s.key})`}
                                        fillOpacity={s.fillOpacity ?? 1}
                                    />
                                )}
                                <LinePath<Datum>
                                    data={data as Datum[]}
                                    x={(d) => xScale(xAccessor(d)) ?? 0}
                                    y={(d) => yScale(s.accessor(d) ?? 0) ?? 0}
                                    curve={curveMonotoneX}
                                    stroke={color}
                                    strokeWidth={s.strokeWidth ?? 2}
                                    strokeDasharray={
                                        s.dashed ? "5 4" : undefined
                                    }
                                    fill="none"
                                />
                            </m.g>
                        </g>
                    );
                })
            )}
        </g>
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
    const reduce = useReducedMotion();

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
        const lo = values.length > 0 ? (min(values) as number) : 0;
        const hi = values.length > 0 ? (max(values) as number) : 1;
        const pad = hi !== lo ? (hi - lo) * 0.08 : 1;
        return scaleLinear({
            range: [innerHeight, 0],
            domain: [lo - pad, hi + pad],
            nice: true,
        });
    }, [data, innerHeight, referenceLines, series, stacked, yDomain]);

    const bisect = useMemo(
        () => bisector<Datum, Date | number>((d) => stableXAccessor(d)).center,
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
            ? margin.left + (xScale(xAccessor(hoverDatum)) ?? 0)
            : 0;
    const tooltipTop = margin.top;

    // useId: deterministic per render position (stable snapshots), unique per
    // chart instance — replaces the old Math.random() suffix.
    const reactId = useId();
    const gradId = `area-grad-${reactId}`;
    const revealId = `${gradId}-reveal`;

    return (
        <div style={{ position: "relative", width, height }}>
            <CartesianChartFrame
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
                    {/* Draw-in: horizontal sweep reveal (skipped under reduced motion) */}
                    <defs>
                        <clipPath id={revealId}>
                            <m.rect
                                x={0}
                                y={-margin.top}
                                height={height}
                                initial={
                                    reduce
                                        ? { width: innerWidth }
                                        : { width: 0 }
                                }
                                animate={{ width: innerWidth }}
                                transition={{
                                    duration: reduce ? 0 : durations.page,
                                    ease: easings.outExpo,
                                }}
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
                    {scrub.range
                        ? (() => {
                              const startDatum = data[scrub.range.startIndex];
                              const endDatum = data[scrub.range.endIndex];
                              if (
                                  startDatum === undefined ||
                                  endDatum === undefined
                              )
                                  return null;
                              const xA =
                                  xScale(stableXAccessor(startDatum)) ?? 0;
                              const xB = xScale(stableXAccessor(endDatum)) ?? 0;
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
                          })()
                        : null}

                    {/* Crosshair */}
                    {hoverDatum != null ? (
                        <Line
                            from={{
                                x: xScale(xAccessor(hoverDatum)) ?? 0,
                                y: 0,
                            }}
                            to={{
                                x: xScale(xAccessor(hoverDatum)) ?? 0,
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
                                ? (v) => xTickFormat(v as Date | number)
                                : undefined
                        }
                    />
                    {yAxisSide === "left" ? (
                        <LeftAxis
                            scale={yScale}
                            numTicks={numYTicks}
                            tickFormat={
                                yTickFormat
                                    ? (v) => yTickFormat(v as number)
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
                                    ? (v) => yTickFormat(v as number)
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
                        onPointerCancel={handleUp}
                    />
                </Group>
            </CartesianChartFrame>

            {scrub.range
                ? (() => {
                      const first = series[0];
                      const startDatum = data[scrub.range.startIndex];
                      const endDatum = data[scrub.range.endIndex];
                      if (
                          !first ||
                          startDatum === undefined ||
                          endDatum === undefined
                      )
                          return null;
                      const a = first.accessor(startDatum);
                      const b = first.accessor(endDatum);
                      if (
                          a == null ||
                          b == null ||
                          !Number.isFinite(a) ||
                          !Number.isFinite(b)
                      )
                          return null;
                      const fmt = (v: number) =>
                          tooltipValueFormat
                              ? tooltipValueFormat(v, first.key)
                              : String(Math.round(v * 100) / 100);
                      const xA =
                          margin.left +
                          (xScale(stableXAccessor(startDatum)) ?? 0);
                      const xB =
                          margin.left +
                          (xScale(stableXAccessor(endDatum)) ?? 0);
                      const mid = (xA + xB) / 2;
                      const rising = b - a > 0;
                      return (
                          <div
                              className={cn(
                                  "pointer-events-none absolute z-10 -translate-x-1/2 whitespace-nowrap rounded-full border border-border/60 bg-card px-2.5 py-1 type-footnote font-medium tabular-nums shadow-elevation-1",
                                  rising
                                      ? "text-gain"
                                      : b - a < 0
                                        ? "text-loss"
                                        : "text-foreground",
                              )}
                              style={{ left: mid, top: 2 }}
                          >
                              {formatScrubDelta(a, b, fmt, formatPercent)}
                          </div>
                      );
                  })()
                : null}

            <ChartTooltip
                open={hoverDatum != null && !scrub.range}
                left={tooltipLeft}
                top={tooltipTop}
                title={
                    hoverDatum != null && tooltipTitle
                        ? tooltipTitle(hoverDatum)
                        : hoverDatum != null
                          ? formatHoverTitle(
                                xAccessor(hoverDatum),
                                appSettings.dateFormat,
                            )
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
