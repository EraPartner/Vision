/**
 * BarChart — visx + framer-motion bar chart.
 * Supports vertical (default) and horizontal layouts, single or grouped series.
 * Per-datum color override via optional colorForIndex prop.
 */
import { Group } from "@visx/group";
import { summarizeSeriesChart } from "./chartAria";
import { ParentSize } from "@visx/responsive";
import { scaleBand, scaleLinear } from "@visx/scale";
import { motion, useReducedMotion } from "framer-motion";
import { memo, useCallback, useMemo, useRef, useState } from "react";

import { BottomAxis, LeftAxis } from "./ChartAxis";
import { ChartTooltip, type ChartTooltipDatum } from "./ChartTooltip";
import { CHART_NEUTRAL, getChartColor } from "./palette";
import { durations, easings } from "@/lib/motion";
import { useLanguage } from "@/contexts/LanguageContext";

export interface BarSeries<Datum> {
    readonly key: string;
    readonly label?: string;
    readonly accessor: (datum: Datum) => number;
    readonly color?: string;
}

/** A line overlay drawn on top of the bars (e.g. rolling average). */
export interface BarOverlay<Datum> {
    readonly key: string;
    readonly label?: string;
    /** Return null to skip a point (gap in the line). */
    readonly accessor: (datum: Datum) => number | null;
    readonly color?: string;
    readonly strokeWidth?: number;
    readonly strokeDasharray?: string;
}

export interface BarChartProps<Datum> {
    readonly data: ReadonlyArray<Datum>;
    readonly categoryAccessor: (datum: Datum) => string;
    readonly series: ReadonlyArray<BarSeries<Datum>>;
    readonly overlays?: ReadonlyArray<BarOverlay<Datum>>;
    readonly height?: number;
    readonly layout?: "vertical" | "horizontal";
    readonly barRadius?: number;
    readonly maxBarSize?: number;
    readonly categoryTickFormat?: (label: string) => string;
    readonly valueTickFormat?: (value: number) => string;
    readonly tooltipTitle?: (datum: Datum) => string;
    readonly tooltipValueFormat?: (value: number, seriesKey: string) => string;
    readonly colorForIndex?: (index: number, datum: Datum) => string;
    readonly margin?: { top: number; right: number; bottom: number; left: number };
    readonly yDomain?: readonly [number, number];
    readonly ariaLabel?: string;
}

const DEFAULT_MARGIN_V = { top: 16, right: 16, bottom: 36, left: 90 };
const DEFAULT_MARGIN_H = { top: 16, right: 32, bottom: 28, left: 140 };

export function BarChart<Datum>(props: BarChartProps<Datum>) {
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

function buildOverlayPath<Datum>(
    data: ReadonlyArray<Datum>,
    accessor: (d: Datum) => number | null,
    categoryAccessor: (d: Datum) => string,
    categoryScale: { (value: string): number | undefined; bandwidth(): number },
    valueScale: ReturnType<typeof scaleLinear>,
): string {
    let path = "";
    let inSegment = false;
    for (const datum of data) {
        const val = accessor(datum);
        if (val === null) {
            inSegment = false;
            continue;
        }
        const cat = categoryAccessor(datum);
        const x = (categoryScale(cat) ?? 0) + categoryScale.bandwidth() / 2;
        const y = valueScale(val) ?? 0;
        path += inSegment ? `L${x},${y}` : `M${x},${y}`;
        inSegment = true;
    }
    return path;
}

type BarValueScale = ReturnType<typeof scaleLinear<number>>;
type BarBandScale = ReturnType<typeof scaleBand<string>>;

interface BarLayerProps<Datum> {
    readonly data: ReadonlyArray<Datum>;
    readonly series: ReadonlyArray<BarSeries<Datum>>;
    readonly overlays: ReadonlyArray<BarOverlay<Datum>> | undefined;
    readonly layout: "vertical" | "horizontal";
    readonly barRadius: number;
    readonly maxBarSize: number | undefined;
    readonly categoryAccessor: (d: Datum) => string;
    /** Always defined (stable wrapper); returns undefined when no override was passed. */
    readonly colorForIndex: (index: number, datum: Datum) => string | undefined;
    readonly categoryScale: BarBandScale;
    readonly seriesScale: BarBandScale;
    readonly valueScale: BarValueScale;
    readonly baseline: number;
    readonly reduce: boolean | null;
    readonly onEnter: (datum: Datum, x: number, y: number) => void;
    readonly onLeave: () => void;
}

/**
 * Bars + overlay lines behind React.memo: hover state changes in Inner fire
 * on every bar pointerenter/leave and must not re-render N×S motion.rects
 * (plus the overlay path rebuild). All props are referentially stable across
 * those renders.
 */
function BarLayerInner<Datum>({
    data,
    series,
    overlays,
    layout,
    barRadius,
    maxBarSize,
    categoryAccessor,
    colorForIndex,
    categoryScale,
    seriesScale,
    valueScale,
    baseline,
    reduce,
    onEnter,
    onLeave,
}: BarLayerProps<Datum>) {
    return (
        <>
            {data.map((d, di) => {
                const cat = categoryAccessor(d);
                const c0 = categoryScale(cat) ?? 0;

                return series.map((s, si) => {
                    const v = s.accessor(d);
                    const color = colorForIndex(di, d) ?? s.color ?? getChartColor(si);

                    if (layout === "vertical") {
                        const bw = Math.min(
                            seriesScale.bandwidth(),
                            maxBarSize ?? Number.POSITIVE_INFINITY,
                        );
                        const bandOffset = (seriesScale.bandwidth() - bw) / 2;
                        const x =
                            c0 + (seriesScale(s.key) ?? 0) + bandOffset;
                        const yTop = valueScale(Math.max(v, 0)) ?? 0;
                        const yBot = valueScale(Math.min(v, 0)) ?? baseline;
                        const h = Math.max(0, yBot - yTop);
                        return (
                            <motion.rect
                                key={`b-${di}-${s.key}`}
                                x={x}
                                width={bw}
                                rx={barRadius}
                                fill={color}
                                initial={
                                    reduce
                                        ? { y: yTop, height: h }
                                        : { y: baseline, height: 0 }
                                }
                                animate={{ y: yTop, height: h }}
                                transition={{
                                    duration: reduce ? 0 : durations.normal,
                                    ease: easings.outExpo,
                                    delay: (di * series.length + si) * 0.015,
                                }}
                                onPointerEnter={() =>
                                    onEnter(d, x + bw / 2, yTop)
                                }
                                onPointerLeave={onLeave}
                            />
                        );
                    }

                    // horizontal
                    const bh = Math.min(
                        seriesScale.bandwidth(),
                        maxBarSize ?? Number.POSITIVE_INFINITY,
                    );
                    const bandOffset = (seriesScale.bandwidth() - bh) / 2;
                    const y = c0 + (seriesScale(s.key) ?? 0) + bandOffset;
                    const xStart = valueScale(Math.min(v, 0)) ?? 0;
                    const xEnd = valueScale(Math.max(v, 0)) ?? 0;
                    const w = Math.max(0, xEnd - xStart);
                    return (
                        <motion.rect
                            key={`b-${di}-${s.key}`}
                            y={y}
                            height={bh}
                            rx={barRadius}
                            fill={color}
                            initial={
                                reduce
                                    ? { x: xStart, width: w }
                                    : { x: baseline, width: 0 }
                            }
                            animate={{ x: xStart, width: w }}
                            transition={{
                                duration: reduce ? 0 : durations.normal,
                                ease: easings.outExpo,
                                delay: (di * series.length + si) * 0.015,
                            }}
                            onPointerEnter={() =>
                                onEnter(d, xStart + w, y + bh / 2)
                            }
                            onPointerLeave={onLeave}
                        />
                    );
                });
            })}

            {/* Overlay lines (e.g. rolling averages) — vertical layout only */}
            {layout === "vertical" && overlays?.map((ov) => {
                const pathD = buildOverlayPath(
                    data, ov.accessor, categoryAccessor, categoryScale, valueScale,
                );
                if (!pathD) return null;

                // Dot markers for each non-null point
                const dots = data.flatMap((datum) => {
                    const val = ov.accessor(datum);
                    if (val === null) return [];
                    const cat = categoryAccessor(datum);
                    const cx = (categoryScale(cat) ?? 0) + categoryScale.bandwidth() / 2;
                    const cy = valueScale(val) ?? 0;
                    return [{ cx, cy }];
                });

                const stroke = ov.color ?? "hsl(var(--accent))";
                return (
                    <g key={`ov-${ov.key}`}>
                        <path
                            d={pathD}
                            fill="none"
                            stroke={stroke}
                            strokeWidth={ov.strokeWidth ?? 2}
                            strokeDasharray={ov.strokeDasharray}
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            style={{ pointerEvents: "none" }}
                        />
                        {dots.map(({ cx, cy }, i) => (
                            <circle
                                key={`dot-${ov.key}-${i}`}
                                cx={cx}
                                cy={cy}
                                r={3}
                                fill={stroke}
                                stroke="var(--background, #fff)"
                                strokeWidth={1.5}
                                style={{ pointerEvents: "none" }}
                            />
                        ))}
                    </g>
                );
            })}
        </>
    );
}

// memo() erases the generic signature; the cast restores it for callers.
const BarLayer = memo(BarLayerInner) as typeof BarLayerInner;

function Inner<Datum>({
    data,
    categoryAccessor,
    series,
    overlays,
    layout = "vertical",
    barRadius = 4,
    maxBarSize,
    categoryTickFormat,
    valueTickFormat,
    tooltipTitle,
    tooltipValueFormat,
    ariaLabel,
    colorForIndex,
    margin,
    yDomain,
    width,
    height,
}: BarChartProps<Datum> & { width: number; height: number }) {
    const { t } = useLanguage();
    const reduce = useReducedMotion();

    const effMargin =
        margin ?? (layout === "horizontal" ? DEFAULT_MARGIN_H : DEFAULT_MARGIN_V);
    const innerWidth = Math.max(0, width - effMargin.left - effMargin.right);
    const innerHeight = Math.max(0, height - effMargin.top - effMargin.bottom);

    // Same inline-prop stabilizers as the other chart primitives — keep the
    // scales and the memoized bar layer valid across consumer re-renders.
    const categoryAccessorRef = useRef(categoryAccessor);
    categoryAccessorRef.current = categoryAccessor;
    const stableCategoryAccessor = useCallback((d: Datum) => categoryAccessorRef.current(d), []);

    const colorForIndexRef = useRef(colorForIndex);
    colorForIndexRef.current = colorForIndex;
    const stableColorForIndex = useCallback(
        (index: number, datum: Datum) => colorForIndexRef.current?.(index, datum),
        [],
    );

    const categories = useMemo(() => data.map((d) => stableCategoryAccessor(d)), [data, stableCategoryAccessor]);

    const valueDomain = useMemo(() => {
        if (yDomain) return yDomain;
        const values: number[] = [];
        for (const d of data) {
            for (const s of series) values.push(s.accessor(d));
            if (overlays) {
                for (const ov of overlays) {
                    const v = ov.accessor(d);
                    if (v !== null) values.push(v);
                }
            }
        }
        const lo = values.length ? Math.min(0, ...values) : 0;
        const hi = values.length ? Math.max(0, ...values) : 1;
        const pad = (hi - lo) * 0.08 || 1;
        return [lo, hi + pad] as const;
    }, [data, series, overlays, yDomain]);

    const categoryScale = useMemo(
        () =>
            scaleBand({
                range: layout === "vertical" ? [0, innerWidth] : [0, innerHeight],
                domain: categories,
                padding: 0.25,
            }),
        [categories, innerHeight, innerWidth, layout],
    );

    const seriesScale = useMemo(
        () =>
            scaleBand({
                range: [0, categoryScale.bandwidth()],
                domain: series.map((s) => s.key),
                padding: 0.12,
            }),
        [categoryScale, series],
    );

    const valueScale = useMemo(
        () =>
            scaleLinear({
                range: layout === "vertical" ? [innerHeight, 0] : [0, innerWidth],
                domain: valueDomain as [number, number],
                nice: true,
            }),
        [innerHeight, innerWidth, layout, valueDomain],
    );

    const [hover, setHover] = useState<{
        datum: Datum;
        x: number;
        y: number;
    } | null>(null);

    const handleEnter = useCallback(
        (datum: Datum, x: number, y: number) => setHover({ datum, x, y }),
        [],
    );
    const handleLeave = useCallback(() => setHover(null), []);

    const tooltipItems: ChartTooltipDatum[] = useMemo(() => {
        if (!hover) return [];
        const seriesItems = series.map((s, i) => {
            const v = s.accessor(hover.datum);
            return {
                label: s.label ?? s.key,
                color: s.color ?? getChartColor(i),
                value: tooltipValueFormat ? tooltipValueFormat(v, s.key) : String(v),
            };
        });
        const overlayItems: ChartTooltipDatum[] = (overlays ?? []).flatMap((ov, i) => {
            const v = ov.accessor(hover.datum);
            if (v === null) return [];
            return [{
                label: ov.label ?? ov.key,
                color: ov.color ?? getChartColor(series.length + i),
                value: tooltipValueFormat ? tooltipValueFormat(v, ov.key) : v.toFixed(0),
            }];
        });
        return [...seriesItems, ...overlayItems];
    }, [hover, series, overlays, tooltipValueFormat]);

    const baseline = layout === "vertical" ? valueScale(0) ?? innerHeight : valueScale(0) ?? 0;

    return (
        <div style={{ position: "relative", width, height }}>
            <svg width={width} height={height} role="img" aria-label={ariaLabel ?? summarizeSeriesChart(t, 'chart.aria.kind.bar', data.length, series.map((s) => s.label))}>
                <Group left={effMargin.left} top={effMargin.top}>
                    {valueScale.ticks(5).map((tick) =>
                        layout === "vertical" ? (
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
                        ) : (
                            <line
                                key={`grid-${tick}`}
                                x1={valueScale(tick)}
                                x2={valueScale(tick)}
                                y1={0}
                                y2={innerHeight}
                                stroke={CHART_NEUTRAL.grid}
                                strokeOpacity={0.35}
                                strokeDasharray="2 4"
                            />
                        ),
                    )}

                    {/* Bars + overlays — memoized so hover enter/leave renders
                        never re-render every bar (see BarLayer). */}
                    <BarLayer
                        data={data}
                        series={series}
                        overlays={overlays}
                        layout={layout}
                        barRadius={barRadius}
                        maxBarSize={maxBarSize}
                        categoryAccessor={stableCategoryAccessor}
                        colorForIndex={stableColorForIndex}
                        categoryScale={categoryScale}
                        seriesScale={seriesScale}
                        valueScale={valueScale}
                        baseline={baseline}
                        reduce={reduce}
                        onEnter={handleEnter}
                        onLeave={handleLeave}
                    />

                    {layout === "vertical" ? (
                        <>
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
                        </>
                    ) : (
                        <>
                            <BottomAxis
                                scale={valueScale}
                                top={innerHeight}
                                tickFormat={
                                    valueTickFormat
                                        ? (v) => valueTickFormat(v as number)
                                        : undefined
                                }
                            />
                            <LeftAxis
                                scale={categoryScale}
                                tickFormat={
                                    categoryTickFormat
                                        ? (v) => categoryTickFormat(String(v))
                                        : undefined
                                }
                            />
                        </>
                    )}
                </Group>
            </svg>

            <ChartTooltip
                open={hover != null}
                left={hover ? effMargin.left + hover.x : 0}
                top={hover ? effMargin.top + hover.y : 0}
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
