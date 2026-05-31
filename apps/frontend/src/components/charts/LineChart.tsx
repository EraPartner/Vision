/**
 * LineChart — visx + framer-motion multi-series line chart.
 */
import { curveMonotoneX } from "@visx/curve";
import { summarizeSeriesChart } from "./chartAria";
import { Group } from "@visx/group";
import { ParentSize } from "@visx/responsive";
import { scaleLinear, scaleTime } from "@visx/scale";
import { Line, LinePath } from "@visx/shape";
import { bisector, extent } from "d3-array";
import { motion, useReducedMotion } from "framer-motion";
import { useCallback, useMemo, useState } from "react";

import { BottomAxis, LeftAxis, RightAxis } from "./ChartAxis";
import { ChartTooltip, type ChartTooltipDatum } from "./ChartTooltip";
import { CHART_NEUTRAL, getChartColor } from "./palette";
import { durations, easings } from "@/lib/motion";
import { useLanguage } from "@/contexts/LanguageContext";

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
    readonly margin?: { top: number; right: number; bottom: number; left: number };
    readonly yDomain?: readonly [number, number];
    readonly ariaLabel?: string;
}

const DEFAULT_MARGIN = { top: 16, right: 24, bottom: 28, left: 90 };

export function LineChart<Datum>(props: LineChartProps<Datum>) {
    const { height = 280 } = props;
    return (
        <div style={{ width: "100%", height }}>
            <ParentSize>
                {({ width: w, height: h }) =>
                    w > 0 && h > 0 ? <Inner {...props} width={w} height={h} /> : null
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
}: LineChartProps<Datum> & { width: number; height: number }) {
    const { t } = useLanguage();
    const reduce = useReducedMotion();

    const innerWidth = Math.max(0, width - margin.left - margin.right);
    const innerHeight = Math.max(0, height - margin.top - margin.bottom);

    const xScale = useMemo(() => {
        const xs = data.map((d) => xAccessor(d));
        if (xIsDate) {
            const [lo, hi] = extent(xs as Date[]);
            return scaleTime({
                range: [0, innerWidth],
                domain: [lo ?? new Date(), hi ?? new Date()],
            });
        }
        const nums = xs as number[];
        return scaleLinear({
            range: [0, innerWidth],
            domain: [Math.min(...nums), Math.max(...nums)],
        });
    }, [data, innerWidth, xAccessor, xIsDate]);

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
        const lo = values.length ? Math.min(...values) : 0;
        const hi = values.length ? Math.max(...values) : 1;
        const pad = (hi - lo) * 0.08 || 1;
        return scaleLinear({
            range: [innerHeight, 0],
            domain: [lo - pad, hi + pad],
            nice: true,
        });
    }, [data, innerHeight, referenceLines, series, yDomain]);

    const bisect = useMemo(
        () => bisector<Datum, Date | number>((d) => xAccessor(d) as Date).center,
        [xAccessor],
    );

    const [hoverIdx, setHoverIdx] = useState<number | null>(null);

    const handleMove = useCallback(
        (event: React.PointerEvent<SVGRectElement>) => {
            const rect = event.currentTarget.getBoundingClientRect();
            const x = event.clientX - rect.left;
            const x0 = xScale.invert(x);
            const idx = bisect(data, x0 as never);
            if (idx >= 0 && idx < data.length) setHoverIdx(idx);
        },
        [bisect, data, xScale],
    );

    const handleLeave = useCallback(() => setHoverIdx(null), []);
    const hoverDatum = hoverIdx != null ? data[hoverIdx] : null;

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

    return (
        <div style={{ position: "relative", width, height }}>
            <svg width={width} height={height} role="img" aria-label={ariaLabel ?? summarizeSeriesChart(t, 'chart.aria.kind.line', data.length, series.map((s) => s.label))}>
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

                    {series.map((s, i) => {
                        const color = s.color ?? getChartColor(i);
                        const connectNulls = s.connectNulls !== false;
                        const filtered = connectNulls
                            ? (data as Datum[])
                            : (data as Datum[]).filter((d) => {
                                  const v = s.accessor(d);
                                  return v != null && Number.isFinite(v);
                              });
                        return (
                            <motion.g
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
                            </motion.g>
                        );
                    })}

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
                                from={{ x: xScale(xAccessor(hoverDatum) as never) ?? 0, y: 0 }}
                                to={{
                                    x: xScale(xAccessor(hoverDatum) as never) ?? 0,
                                    y: innerHeight,
                                }}
                                stroke={CHART_NEUTRAL.label}
                                strokeWidth={1}
                                strokeDasharray="3 3"
                                strokeOpacity={0.5}
                            />
                            {series.map((s, i) => {
                                const v = s.accessor(hoverDatum);
                                if (v == null || !Number.isFinite(v)) return null;
                                const color = s.color ?? getChartColor(i);
                                return (
                                    <circle
                                        key={`dot-${s.key}`}
                                        cx={xScale(xAccessor(hoverDatum) as never) ?? 0}
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
                            xTickFormat ? (v) => xTickFormat(v as Date | number) : undefined
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
                top={margin.top}
                title={
                    hoverDatum && tooltipTitle
                        ? tooltipTitle(hoverDatum)
                        : hoverDatum
                          ? formatTitle(xAccessor(hoverDatum))
                          : undefined
                }
                items={tooltipItems}
            />
        </div>
    );
}

function formatTitle(x: Date | number): string {
    if (x instanceof Date) return x.toLocaleDateString();
    return String(x);
}
