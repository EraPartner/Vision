/**
 * StackedBarChart — visx + framer-motion stacked bar chart (vertical).
 */
import { sum } from "d3-array";
import { Group } from "@visx/group";
import { summarizeSeriesChart } from "./chartAria";
import { ParentSize } from "@visx/responsive";
import { scaleBand, scaleLinear } from "@visx/scale";
import { BarStack } from "@visx/shape";
import { m, useReducedMotion } from "framer-motion";
import { memo, useCallback, useMemo, useRef, useState } from "react";

import { BottomAxis, LeftAxis } from "./ChartAxis";
import { ChartTooltip, type ChartTooltipDatum } from "./ChartTooltip";
import { CHART_NEUTRAL, getChartColor } from "./palette";
import { durations, easings } from "@/lib/motion";
import { useLanguage } from "@/stores/hydration/LanguageHydration";
import { useChartKeyboardNav } from "./keyboardNav";

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
    readonly margin?: {
        top: number;
        right: number;
        bottom: number;
        left: number;
    };
    readonly ariaLabel?: string;
}

const DEFAULT_MARGIN = { top: 16, right: 16, bottom: 36, left: 48 };

type StackRow<Datum> = Record<string, number> & {
    __datum: Datum;
    __category: string;
};

interface StackedBarLayerProps<Datum> {
    readonly rows: StackRow<Datum>[];
    readonly seriesKeys: string[];
    readonly categoryScale: ReturnType<typeof scaleBand<string>>;
    readonly valueScale: ReturnType<typeof scaleLinear<number>>;
    readonly colorLookup: Map<string, string>;
    readonly barRadius: number;
    readonly maxBarSize: number | undefined;
    readonly baseline: number;
    readonly reduce: boolean | null;
    readonly onEnter: (datum: Datum, x: number, y: number) => void;
    readonly onLeave: () => void;
}

/**
 * The BarStack (stack layout + N×S m.rects) behind React.memo: hover
 * state changes in Inner fire on every segment pointerenter/leave and must
 * not recompute the stack. All props are referentially stable across those
 * renders.
 */
function StackedBarLayerInner<Datum>({
    rows,
    seriesKeys,
    categoryScale,
    valueScale,
    colorLookup,
    barRadius,
    maxBarSize,
    baseline,
    reduce,
    onEnter,
    onLeave,
}: StackedBarLayerProps<Datum>) {
    return (
        <BarStack<StackRow<Datum>, string>
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
                            <m.rect
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
                                    // Clamp the stagger tail: past ~0.4s the
                                    // entrance is imperceptible, so long ranges
                                    // don't run seconds of settle animation.
                                    delay: Math.min(
                                        bar.index * 0.02 + stack.index * 0.03,
                                        0.4,
                                    ),
                                }}
                                onPointerEnter={() =>
                                    onEnter(
                                        bar.bar.data.__datum,
                                        bx + bw / 2,
                                        bar.y,
                                    )
                                }
                                onPointerLeave={onLeave}
                            />
                        );
                    }),
                )
            }
        </BarStack>
    );
}

// memo() erases the generic signature; the cast restores it for callers.
const StackedBarLayer = memo(
    StackedBarLayerInner,
) as typeof StackedBarLayerInner;

export function StackedBarChart<Datum>(props: StackedBarChartProps<Datum>) {
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
    const { t } = useLanguage();
    const reduce = useReducedMotion();

    const innerWidth = Math.max(0, width - margin.left - margin.right);
    const innerHeight = Math.max(0, height - margin.top - margin.bottom);

    // Same inline-prop stabilizer as the other chart primitives — keeps the
    // scales, rows, and the memoized stack layer valid across consumer re-renders.
    const categoryAccessorRef = useRef(categoryAccessor);
    categoryAccessorRef.current = categoryAccessor;
    const stableCategoryAccessor = useCallback(
        (d: Datum) => categoryAccessorRef.current(d),
        [],
    );

    const categories = useMemo(
        () => data.map((d) => stableCategoryAccessor(d)),
        [data, stableCategoryAccessor],
    );

    const totals = useMemo(
        () => data.map((d) => sum(series, (s) => s.accessor(d) ?? 0)),
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

    const rows: StackRow<Datum>[] = useMemo(
        () =>
            data.map((d) => {
                const row = {
                    __datum: d,
                    __category: stableCategoryAccessor(d),
                } as StackRow<Datum>;
                for (const s of series) row[s.key] = s.accessor(d) ?? 0;
                return row;
            }),
        [stableCategoryAccessor, data, series],
    );

    const [hover, setHover] = useState<{
        index: number;
        x: number;
        y: number;
    } | null>(null);

    const handleEnter = useCallback(
        (datum: Datum, x: number, y: number) => {
            const index = data.indexOf(datum);
            if (index >= 0) setHover({ index, x, y });
        },
        [data],
    );
    const handleLeave = useCallback(() => setHover(null), []);
    const hoverIndex = hover && hover.index < data.length ? hover.index : null;
    const hoverDatum = hoverIndex == null ? null : data[hoverIndex];
    const handleKeyboardIndex = useCallback(
        (index: number) => {
            const x = categoryScale(categories[index]) ?? 0;
            setHover({ index, x: x + categoryScale.bandwidth() / 2, y: 0 });
        },
        [categories, categoryScale, data],
    );
    const keyboardNav = useChartKeyboardNav({
        pointCount: data.length,
        index: hoverIndex,
        onIndexChange: handleKeyboardIndex,
        onClear: handleLeave,
    });

    const tooltipItems: ChartTooltipDatum[] = useMemo(() => {
        if (!hoverDatum) return [];
        return series.map((s, i) => {
            const v = s.accessor(hoverDatum);
            return {
                label: s.label ?? s.key,
                color: s.color ?? getChartColor(i),
                value: tooltipValueFormat
                    ? tooltipValueFormat(v, s.key)
                    : String(v),
            };
        });
    }, [hoverDatum, series, tooltipValueFormat]);

    const baseline = valueScale(0) ?? innerHeight;

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
                        "chart.aria.kind.stackedBar",
                        data.length,
                        series.map((s) => s.label),
                    )
                }
                tabIndex={data.length > 0 ? 0 : undefined}
                onKeyDown={keyboardNav.onKeyDown}
                onBlur={keyboardNav.onBlur}
            >
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

                    {/* Stack layout + rects — memoized so hover enter/leave
                        renders never recompute the stack (see StackedBarLayer). */}
                    <StackedBarLayer
                        rows={rows}
                        seriesKeys={seriesKeys}
                        categoryScale={categoryScale}
                        valueScale={valueScale}
                        colorLookup={colorLookup}
                        barRadius={barRadius}
                        maxBarSize={maxBarSize}
                        baseline={baseline}
                        reduce={reduce}
                        onEnter={handleEnter}
                        onLeave={handleLeave}
                    />

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
                            valueTickFormat
                                ? (v) => valueTickFormat(v as number)
                                : undefined
                        }
                    />
                </Group>
            </svg>

            <ChartTooltip
                open={hoverDatum != null}
                left={hover ? margin.left + hover.x : 0}
                top={hover ? margin.top + hover.y : 0}
                title={
                    hoverDatum
                        ? tooltipTitle
                            ? tooltipTitle(hoverDatum)
                            : categoryAccessor(hoverDatum)
                        : undefined
                }
                items={tooltipItems}
            />
        </div>
    );
}
