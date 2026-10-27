/**
 * Sparkline — tiny trend line with draw-in motion.
 */
import { curveMonotoneX } from "@visx/curve";
import { summarizeSparkline } from "./chartAria";
import { ParentSize } from "@visx/responsive";
import { scaleLinear } from "@visx/scale";
import { Area, LinePath } from "@visx/shape";
import { useMemo } from "react";

import { CHART_NEUTRAL } from "./palette";
import { ChartEntrance } from "./chartEntrance";
import { durations } from "@/lib/motion";
import { useLanguage } from "@/stores/hydration/LanguageHydration";

export interface SparklineProps {
    readonly data: ReadonlyArray<number>;
    readonly height?: number | undefined;
    readonly color?: string | undefined;
    readonly strokeWidth?: number | undefined;
    readonly fillArea?: boolean | undefined;
    readonly ariaLabel?: string | undefined;
    /** Highlight the point at this index (scrub indicator: hairline + dot). */
    readonly activeIndex?: number | undefined;
}

export function Sparkline(props: SparklineProps) {
    const { height = 32 } = props;
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

function Inner({
    data,
    color = CHART_NEUTRAL.primary,
    strokeWidth = 1.5,
    fillArea = false,
    width,
    height,
    ariaLabel,
    activeIndex,
}: SparklineProps & { width: number; height: number }) {
    const { t } = useLanguage();

    const xScale = useMemo(
        () => scaleLinear({ range: [0, width], domain: [0, Math.max(1, data.length - 1)] }),
        [data.length, width],
    );

    const yScale = useMemo(() => {
        const lo = Math.min(...data);
        const hi = Math.max(...data);
        const pad = hi !== lo ? (hi - lo) * 0.1 : 1;
        return scaleLinear({
            range: [height - 2, 2],
            domain: [lo - pad, hi + pad],
        });
    }, [data, height]);

    const activeValue = activeIndex === undefined ? undefined : data[activeIndex];

    return (
        <div style={{ position: "relative", width, height }}>
            {/* Area and line fade in as separate layers (chartEntrance.tsx);
                the labelled frame on top carries the scrub indicator. */}
            {fillArea ? (
                <ChartEntrance
                    effect="fade"
                    duration={durations.slow}
                    width={width}
                    height={height}
                >
                    <svg
                        width={width}
                        height={height}
                        aria-hidden="true"
                        focusable="false"
                    >
                        <Area<number>
                            // visx takes a mutable array; the prop is a ReadonlyArray that visx never writes to.
                            data={data as number[]}
                            x={(_, i) => xScale(i)}
                            y0={height}
                            y1={(v) => yScale(v)}
                            curve={curveMonotoneX}
                            fill={color}
                            fillOpacity={0.15}
                        />
                    </svg>
                </ChartEntrance>
            ) : null}
            <ChartEntrance
                effect="fade"
                duration={durations.normal}
                width={width}
                height={height}
            >
                <svg
                    width={width}
                    height={height}
                    aria-hidden="true"
                    focusable="false"
                >
                    <LinePath<number>
                        // visx takes a mutable array; the prop is a ReadonlyArray that visx never writes to.
                        data={data as number[]}
                        x={(_, i) => xScale(i)}
                        y={(v) => yScale(v)}
                        curve={curveMonotoneX}
                        stroke={color}
                        strokeWidth={strokeWidth}
                        fill="none"
                    />
                </svg>
            </ChartEntrance>
            <svg
                className="relative"
                width={width}
                height={height}
                role="img"
                aria-label={ariaLabel ?? summarizeSparkline(t, data)}
            >
                {activeIndex !== undefined && activeValue !== undefined && (
                    <g aria-hidden="true">
                        <line
                            x1={xScale(activeIndex)}
                            x2={xScale(activeIndex)}
                            y1={0}
                            y2={height}
                            stroke={color}
                            strokeOpacity={0.35}
                            strokeWidth={1}
                        />
                        <circle
                            cx={xScale(activeIndex)}
                            cy={yScale(activeValue)}
                            r={3.5}
                            fill={color}
                            stroke="hsl(var(--background))"
                            strokeWidth={1.5}
                        />
                    </g>
                )}
            </svg>
        </div>
    );
}

