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
import { useCallback, useMemo, useRef, useState } from "react";

import { BottomAxis, LeftAxis, RightAxis } from "./ChartAxis";
import { ChartTooltip, type ChartTooltipDatum } from "./ChartTooltip";
import { CHART_NEUTRAL, getChartColor } from "./palette";
import { durations, easings } from "@/lib/motion";
import { useLanguage } from "@/contexts/LanguageContext";

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
}

const DEFAULT_MARGIN = { top: 16, right: 24, bottom: 28, left: 90 };

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
}: InnerProps<Datum>) {
    const { t } = useLanguage();
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

    const handleMove = useCallback(
        (event: React.PointerEvent<SVGRectElement>) => {
            const rect = event.currentTarget.getBoundingClientRect();
            const x = event.clientX - rect.left;
            const x0 = xScale.invert(x);
            const idx = bisect(data, x0 as never);
            if (idx >= 0 && idx < data.length) setHoverIndex(idx);
        },
        [bisect, data, xScale],
    );

    const handleLeave = useCallback(() => setHoverIndex(null), []);

    const hoverDatum = hoverIndex != null ? data[hoverIndex] : null;

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

    const gradId = useMemo(() => `area-grad-${Math.random().toString(36).slice(2, 8)}`, []);

    return (
        <div style={{ position: "relative", width, height }}>
            <svg width={width} height={height} role="img" aria-label={ariaLabel ?? summarizeSeriesChart(t, 'chart.aria.kind.area', data.length, series.map((s) => s.label))}>
                <Group left={margin.left} top={margin.top}>
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

                    {/* Stacked or unstacked */}
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
                        onPointerMove={handleMove}
                        onPointerLeave={handleLeave}
                    />
                </Group>
            </svg>

            <ChartTooltip
                open={hoverDatum != null}
                left={tooltipLeft}
                top={tooltipTop}
                title={
                    hoverDatum && tooltipTitle
                        ? tooltipTitle(hoverDatum)
                        : hoverDatum
                          ? formatHoverTitle(xAccessor(hoverDatum))
                          : undefined
                }
                items={tooltipItems}
            />
        </div>
    );
}

function formatHoverTitle(x: Date | number): string {
    if (x instanceof Date) return x.toLocaleDateString();
    return String(x);
}
