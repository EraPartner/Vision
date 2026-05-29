/**
 * StackedBarChart — visx + framer-motion stacked bar chart (vertical).
 */
import { Group } from "@visx/group";
import { summarizeSeriesChart } from "./chartAria";
import { ParentSize } from "@visx/responsive";
import { scaleBand, scaleLinear } from "@visx/scale";
import { BarStack } from "@visx/shape";
import { motion, useReducedMotion } from "framer-motion";
import { useCallback, useMemo, useState } from "react";

import { BottomAxis, LeftAxis } from "./ChartAxis";
import { ChartTooltip, type ChartTooltipDatum } from "./ChartTooltip";
import { CHART_NEUTRAL, getChartColor } from "./palette";
import { durations, easings } from "@/lib/motion";

export interface StackedBarSeries<Datum> {
    readonly key: string;
    readonly label?: string;
    readonly accessor: (datum: Datum) => number;
    readonly color?: string;
}

export interface StackedBarChartProps<Datum> {
    readonly data: ReadonlyArray<Datum>;
    readonly categoryAccessor: (datum: Datum) => string;
    readonly series: ReadonlyArray<StackedBarSeries<Datum>>;
    readonly height?: number;
    readonly barRadius?: number;
    readonly maxBarSize?: number;
    readonly categoryTickFormat?: (label: string) => string;
    readonly valueTickFormat?: (value: number) => string;
    readonly tooltipTitle?: (datum: Datum) => string;
    readonly tooltipValueFormat?: (value: number, seriesKey: string) => string;
    readonly margin?: { top: number; right: number; bottom: number; left: number };
    readonly ariaLabel?: string;
}

const DEFAULT_MARGIN = { top: 16, right: 16, bottom: 36, left: 48 };

export function StackedBarChart<Datum>(props: StackedBarChartProps<Datum>) {
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
    categoryAccessor,
    series,
    barRadius = 4,
    maxBarSize,
    categoryTickFormat,
    valueTickFormat,
    tooltipTitle,
    tooltipValueFormat,
    margin = DEFAULT_MARGIN,
    width,
    height,
    ariaLabel,
}: StackedBarChartProps<Datum> & { width: number; height: number }) {
    const reduce = useReducedMotion();

    const innerWidth = Math.max(0, width - margin.left - margin.right);
    const innerHeight = Math.max(0, height - margin.top - margin.bottom);

    const categories = useMemo(
        () => data.map((d) => categoryAccessor(d)),
        [data, categoryAccessor],
    );

    const totals = useMemo(
        () =>
            data.map((d) => series.reduce((sum, s) => sum + (s.accessor(d) ?? 0), 0)),
        [data, series],
    );

    const categoryScale = useMemo(
        () =>
            scaleBand({
                range: [0, innerWidth],
                domain: categories,
                padding: 0.25,
            }),
        [categories, innerWidth],
    );

    const valueScale = useMemo(
        () =>
            scaleLinear({
                range: [innerHeight, 0],
                domain: [0, Math.max(1, ...totals) * 1.08],
                nice: true,
            }),
        [innerHeight, totals],
    );

    const seriesKeys = useMemo(() => series.map((s) => s.key), [series]);
    const colorLookup = useMemo(() => {
        const m = new Map<string, string>();
        series.forEach((s, i) => m.set(s.key, s.color ?? getChartColor(i)));
        return m;
    }, [series]);

    type BarRow = Record<string, number> & { __datum: Datum; __category: string };
    const rows: BarRow[] = useMemo(
        () =>
            data.map((d) => {
                const row = {
                    __datum: d,
                    __category: categoryAccessor(d),
                } as BarRow;
                for (const s of series) row[s.key] = s.accessor(d) ?? 0;
                return row;
            }),
        [categoryAccessor, data, series],
    );

    const [hover, setHover] = useState<{ datum: Datum; x: number; y: number } | null>(null);

    const handleEnter = useCallback(
        (datum: Datum, x: number, y: number) => setHover({ datum, x, y }),
        [],
    );
    const handleLeave = useCallback(() => setHover(null), []);

    const tooltipItems: ChartTooltipDatum[] = useMemo(() => {
        if (!hover) return [];
        return series.map((s, i) => {
            const v = s.accessor(hover.datum);
            return {
                label: s.label ?? s.key,
                color: s.color ?? getChartColor(i),
                value: tooltipValueFormat ? tooltipValueFormat(v, s.key) : String(v),
            };
        });
    }, [hover, series, tooltipValueFormat]);

    const baseline = valueScale(0) ?? innerHeight;

    return (
        <div style={{ position: "relative", width, height }}>
            <svg width={width} height={height} role="img" aria-label={ariaLabel ?? summarizeSeriesChart("Stacked bar chart", data.length, series.map((s) => s.label))}>
                <Group left={margin.left} top={margin.top}>
                    {valueScale.ticks(5).map((tick) => (
                        <line
                            key={`grid-${tick}`}
                            x1={0}
                            x2={innerWidth}
                            y1={valueScale(tick)}
                            y2={valueScale(tick)}
                            stroke={CHART_NEUTRAL.grid}
                            strokeOpacity={0.35}
                            strokeDasharray="2 4"
                        />
                    ))}

                    <BarStack<BarRow, string>
                        data={rows}
                        keys={seriesKeys}
                        x={(d) => d.__category}
                        xScale={categoryScale}
                        yScale={valueScale}
                        color={(key) => colorLookup.get(key) ?? CHART_NEUTRAL.primary}
                    >
                        {(stacks) =>
                            stacks.map((stack) =>
                                stack.bars.map((bar) => {
                                    const bw = Math.min(
                                        bar.width,
                                        maxBarSize ?? Number.POSITIVE_INFINITY,
                                    );
                                    const bx = bar.x + (bar.width - bw) / 2;
                                    return (
                                        <motion.rect
                                            key={`sb-${stack.index}-${bar.index}`}
                                            x={bx}
                                            width={bw}
                                            rx={barRadius}
                                            fill={bar.color}
                                            initial={
                                                reduce
                                                    ? { y: bar.y, height: bar.height }
                                                    : { y: baseline, height: 0 }
                                            }
                                            animate={{ y: bar.y, height: bar.height }}
                                            transition={{
                                                duration: reduce ? 0 : durations.normal,
                                                ease: easings.outExpo,
                                                delay:
                                                    (bar.index * 0.02 + stack.index * 0.03),
                                            }}
                                            onPointerEnter={() =>
                                                handleEnter(
                                                    bar.bar.data.__datum,
                                                    bx + bw / 2,
                                                    bar.y,
                                                )
                                            }
                                            onPointerLeave={handleLeave}
                                        />
                                    );
                                }),
                            )
                        }
                    </BarStack>

                    <BottomAxis
                        scale={categoryScale}
                        top={innerHeight}
                        tickFormat={
                            categoryTickFormat
                                ? (v) => categoryTickFormat(String(v))
                                : undefined
                        }
                    />
                    <LeftAxis
                        scale={valueScale}
                        tickFormat={
                            valueTickFormat ? (v) => valueTickFormat(v as number) : undefined
                        }
                    />
                </Group>
            </svg>

            <ChartTooltip
                open={hover != null}
                left={hover ? margin.left + hover.x : 0}
                top={hover ? margin.top + hover.y : 0}
                title={
                    hover
                        ? tooltipTitle
                            ? tooltipTitle(hover.datum)
                            : categoryAccessor(hover.datum)
                        : undefined
                }
                items={tooltipItems}
            />
        </div>
    );
}
