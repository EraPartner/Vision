/**
 * LineChart — visx + framer-motion multi-series line chart.
 */
import { curveMonotoneX } from "@visx/curve";
import { summarizeSeriesChart } from "./chartAria";
import { Group } from "@visx/group";
import { ParentSize } from "@visx/responsive";
import { scaleLinear, scaleTime } from "@visx/scale";
import { Line, LinePath } from "@visx/shape";
import { bisector, extent, max, min } from "d3-array";
import { m, useReducedMotion } from "framer-motion";
import { memo, useCallback, useMemo, useRef, useState } from "react";

import { BottomAxis, LeftAxis, RightAxis } from "./ChartAxis";
import { useChartSync } from "./ChartSyncContext";
import { useChartKeyboardNav } from "./keyboardNav";
import { formatScrubDelta, useChartScrub } from "./scrub";
import { ChartTooltip, type ChartTooltipDatum } from "./ChartTooltip";
import { CHART_NEUTRAL, getChartColor } from "./palette";
import { durations, easings } from "@/lib/motion";
import { cn } from "@/lib/utils";
import { useLanguage } from "@/contexts/LanguageContext";
import { useAppSettings } from "@/contexts/AppSettingsContext";
import { formatDateWithAppSettings } from "@/lib/dateUtils";
import { usePercentFormatter } from "@/hooks/useCurrencyFormatter";

export interface LineSeries<Datum> {
    readonly key: string;
    readonly label?: string;
    readonly accessor: (datum: Datum) => number | null | undefined;
    readonly color?: string;
    readonly dashed?: boolean;
    readonly strokeWidth?: number;
    readonly connectNulls?: boolean;
}

export interface LineReferenceLine {
    readonly y?: number;
    readonly x?: Date | number;
    readonly label?: string;
    readonly color?: string;
    readonly dashed?: boolean;
}

export interface LineChartProps<Datum> {
    readonly data: ReadonlyArray<Datum>;
    readonly xAccessor: (datum: Datum) => Date | number;
    readonly series: ReadonlyArray<LineSeries<Datum>>;
    readonly height?: number;
    readonly xIsDate?: boolean;
    readonly xTickFormat?: (value: Date | number) => string;
    readonly yTickFormat?: (value: number) => string;
    readonly yAxisSide?: "left" | "right";
    readonly numYTicks?: number;
    readonly referenceLines?: ReadonlyArray<LineReferenceLine>;
    readonly tooltipTitle?: (datum: Datum) => string;
    readonly tooltipValueFormat?: (value: number, seriesKey: string) => string;
    readonly margin?: {
        top: number;
        right: number;
        bottom: number;
        left: number;
    };
    readonly yDomain?: readonly [number, number];
    readonly ariaLabel?: string;
    /** Opt into synced crosshairs with sibling charts sharing this id (needs ChartSyncProvider). */
    readonly syncId?: string;
    /** Enable pointer-drag range compare (Δ + %) on the primary series. */
    readonly scrubbable?: boolean;
}

const DEFAULT_MARGIN = { top: 16, right: 24, bottom: 28, left: 90 };

type LineYScale = ReturnType<typeof scaleLinear<number>>;
type LineXScale =
    | ReturnType<typeof scaleTime<number>>
    | ReturnType<typeof scaleLinear<number>>;

interface LineSeriesLayerProps<Datum> {
    readonly data: ReadonlyArray<Datum>;
    readonly series: ReadonlyArray<LineSeries<Datum>>;
    readonly xAccessor: (d: Datum) => Date | number;
    readonly xScale: LineXScale;
    readonly yScale: LineYScale;
    readonly reduce: boolean | null;
}

/**
 * Series paths behind React.memo: hover state changes in Inner fire per
 * pointermove and must not re-run the per-series filtering + monotone curve
 * fits below. All props are referentially stable across those renders.
 */
function LineSeriesLayerInner<Datum>({
    data,
    series,
    xAccessor,
    xScale,
    yScale,
    reduce,
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
                    : (data as Datum[]);
                return (
                    <m.g
                        key={s.key}
                        initial={reduce ? { opacity: 1 } : { opacity: 0 }}
                        animate={{ opacity: 1 }}
                        transition={{
                            duration: reduce ? 0 : durations.slow,
                            ease: easings.outExpo,
                            delay: i * 0.05,
                        }}
                    >
                        <LinePath<Datum>
                            data={filtered}
                            x={(d) => xScale(xAccessor(d) as never) ?? 0}
                            y={(d) => yScale(s.accessor(d) ?? 0) ?? 0}
                            curve={curveMonotoneX}
                            stroke={color}
                            strokeWidth={s.strokeWidth ?? 2}
                            strokeDasharray={s.dashed ? "5 4" : undefined}
                            fill="none"
                            defined={(d) => {
                                const v = s.accessor(d);
                                return v != null && Number.isFinite(v);
                            }}
                        />
                    </m.g>
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
        <div style={{ width: "100%", height }}>
            <ParentSize>
                {({ width: w, height: h }) =>
                    w > 0 && h > 0 ? (
                        <Inner {...props} width={w} height={h} />
                    ) : null
                }
            </ParentSize>
        </div>
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
    const reduce = useReducedMotion();

    const innerWidth = Math.max(0, width - margin.left - margin.right);
    const innerHeight = Math.max(0, height - margin.top - margin.bottom);

    // Prevent inline xAccessor props from invalidating memoized derivations every
    // render (same stabilizer as AreaChart) — without it, a consumer re-render
    // with an inline accessor rebuilds the scale, the bisector, and every path.
    const xAccessorRef = useRef(xAccessor);
    xAccessorRef.current = xAccessor;
    const stableXAccessor = useCallback(
        (d: Datum) => xAccessorRef.current(d),
        [],
    );

    const xScale = useMemo(() => {
        const xs = data.map((d) => stableXAccessor(d));
        if (xIsDate) {
            const [lo, hi] = extent(xs as Date[]);
            return scaleTime({
                range: [0, innerWidth],
                domain: [lo ?? new Date(), hi ?? new Date()],
            });
        }
        const nums = xs as number[];
        // The only live numeric-x caller (ForecastInner) feeds dayNum = i+1, so
        // nums is finite: d3 min/max equal Math.min/max(...) here and avoid the
        // spread stack-size hazard. (`?? 0` only guards the unreachable empty case.)
        return scaleLinear({
            range: [0, innerWidth],
            domain: [min(nums) ?? 0, max(nums) ?? 0],
        });
    }, [data, innerWidth, stableXAccessor, xIsDate]);

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
        const lo = values.length ? (min(values) as number) : 0;
        const hi = values.length ? (max(values) as number) : 1;
        const pad = (hi - lo) * 0.08 || 1;
        return scaleLinear({
            range: [innerHeight, 0],
            domain: [lo - pad, hi + pad],
            nice: true,
        });
    }, [data, innerHeight, referenceLines, series, yDomain]);

    const bisect = useMemo(
        () =>
            bisector<Datum, Date | number>((d) => stableXAccessor(d) as Date)
                .center,
        [stableXAccessor],
    );

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
            const idx = bisect(data, x0 as never);
            return idx >= 0 && idx < data.length ? idx : null;
        },
        [bisect, data, xScale],
    );

    const handleMove = useCallback(
        (event: React.PointerEvent<SVGRectElement>) => {
            const idx = indexAtClientX(event);
            if (idx == null) return;
            setHoverIdx(idx);
            publishHover(Number(stableXAccessor(data[idx])));
            if (scrub.scrubbing) scrub.move(idx);
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
            setHoverIdx(idx);
            publishHover(Number(stableXAccessor(data[idx])));
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
        if (hoverIdx != null || syncedX == null || data.length === 0)
            return null;
        // Only mirror when the synced x falls inside this chart's domain —
        // disjoint timelines (history vs forecast) must not pin to an edge.
        const lo = Number(stableXAccessor(data[0]));
        const hi = Number(stableXAccessor(data[data.length - 1]));
        if (syncedX < Math.min(lo, hi) || syncedX > Math.max(lo, hi))
            return null;
        let best = 0;
        let bestDist = Infinity;
        for (let i = 0; i < data.length; i++) {
            const dist = Math.abs(Number(stableXAccessor(data[i])) - syncedX);
            if (dist < bestDist) {
                bestDist = dist;
                best = i;
            }
        }
        return best;
    }, [hoverIdx, syncedX, data, stableXAccessor]);

    const effectiveIdx = hoverIdx ?? syncedIdx;
    const hoverDatum = effectiveIdx != null ? data[effectiveIdx] : null;

    const tooltipItems: ChartTooltipDatum[] = useMemo(() => {
        if (!hoverDatum) return [];
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
            ? margin.left + (xScale(xAccessor(hoverDatum) as never) ?? 0)
            : 0;

    return (
        <div style={{ position: "relative", width, height }}>
            <svg
                width={width}
                height={height}
                role="img"
                aria-label={
                    ariaLabel ??
                    summarizeSeriesChart(
                        t,
                        "chart.aria.kind.line",
                        data.length,
                        series.map((s) => s.label),
                    )
                }
                tabIndex={data.length > 0 ? 0 : undefined}
                onKeyDown={handleKeyDown}
                onBlur={handleBlur}
            >
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

                    {/* Series paths — memoized so pointermove renders never
                        regenerate them (see LineSeriesLayer). */}
                    <LineSeriesLayer
                        data={data}
                        series={series}
                        xAccessor={stableXAccessor}
                        xScale={xScale}
                        yScale={yScale}
                        reduce={reduce}
                    />

                    {referenceLines?.map((r, i) => {
                        const color = r.color ?? CHART_NEUTRAL.label;
                        const dashAttr = r.dashed === false ? undefined : "4 4";
                        if (r.x != null) {
                            const x = xScale(r.x as never) ?? 0;
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
                                    x:
                                        xScale(
                                            xAccessor(hoverDatum) as never,
                                        ) ?? 0,
                                    y: 0,
                                }}
                                to={{
                                    x:
                                        xScale(
                                            xAccessor(hoverDatum) as never,
                                        ) ?? 0,
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
                                        cx={
                                            xScale(
                                                xAccessor(hoverDatum) as never,
                                            ) ?? 0
                                        }
                                        cy={yScale(v) ?? 0}
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

                    {scrub.range
                        ? (() => {
                              const xA =
                                  xScale(
                                      xAccessor(
                                          data[scrub.range.startIndex],
                                      ) as never,
                                  ) ?? 0;
                              const xB =
                                  xScale(
                                      xAccessor(
                                          data[scrub.range.endIndex],
                                      ) as never,
                                  ) ?? 0;
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
            </svg>

            {scrub.range
                ? (() => {
                      const first = series[0];
                      const a = first?.accessor(data[scrub.range.startIndex]);
                      const b = first?.accessor(data[scrub.range.endIndex]);
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
                          (xScale(
                              xAccessor(data[scrub.range.startIndex]) as never,
                          ) ?? 0);
                      const xB =
                          margin.left +
                          (xScale(
                              xAccessor(data[scrub.range.endIndex]) as never,
                          ) ?? 0);
                      const mid = (xA + xB) / 2;
                      const rising = b - a > 0;
                      return (
                          <div
                              className={cn(
                                  "pointer-events-none absolute z-10 -translate-x-1/2 whitespace-nowrap rounded-full border border-border/60 bg-card px-2.5 py-1 text-xs font-semibold tabular-nums shadow-sm",
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
                top={margin.top}
                title={
                    hoverDatum && tooltipTitle
                        ? tooltipTitle(hoverDatum)
                        : hoverDatum
                          ? formatTitle(
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
function formatTitle(x: Date | number, appDateFormat: string): string {
    if (x instanceof Date) return formatDateWithAppSettings(x, appDateFormat);
    return String(x);
}
