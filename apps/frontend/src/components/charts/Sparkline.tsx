/**
 * Sparkline — tiny trend line with draw-in motion.
 */
import { curveMonotoneX } from "@visx/curve";
import { summarizeSparkline } from "./chartAria";
import { ParentSize } from "@visx/responsive";
import { scaleLinear } from "@visx/scale";
import { Area, LinePath } from "@visx/shape";
import { motion, useReducedMotion } from "framer-motion";
import { useMemo } from "react";

import { CHART_NEUTRAL } from "./palette";
import { durations, easings } from "@/lib/motion";
import { useLanguage } from "@/contexts/LanguageContext";

export interface SparklineProps {
    readonly data: ReadonlyArray<number>;
    readonly height?: number;
    readonly color?: string;
    readonly strokeWidth?: number;
    readonly fillArea?: boolean;
    readonly ariaLabel?: string;
    /** Highlight the point at this index (scrub indicator: hairline + dot). */
    readonly activeIndex?: number;
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
    const reduce = useReducedMotion();

    const xScale = useMemo(
        () => scaleLinear({ range: [0, width], domain: [0, Math.max(1, data.length - 1)] }),
        [data.length, width],
    );

    const yScale = useMemo(() => {
        const lo = Math.min(...data);
        const hi = Math.max(...data);
        const pad = (hi - lo) * 0.1 || 1;
        return scaleLinear({
            range: [height - 2, 2],
            domain: [lo - pad, hi + pad],
        });
    }, [data, height]);

    return (
        <svg width={width} height={height} role="img" aria-label={ariaLabel ?? summarizeSparkline(t, data)}>
            {fillArea ? (
                <motion.g
                    initial={reduce ? { opacity: 1 } : { opacity: 0 }}
                    animate={{ opacity: 1 }}
                    transition={{
                        duration: reduce ? 0 : durations.slow,
                        ease: easings.outExpo,
                    }}
                >
                    <Area<number>
                        data={data as number[]}
                        x={(_, i) => xScale(i) ?? 0}
                        y0={height}
                        y1={(v) => yScale(v) ?? 0}
                        curve={curveMonotoneX}
                        fill={color}
                        fillOpacity={0.15}
                    />
                </motion.g>
            ) : null}
            <motion.g
                initial={reduce ? { opacity: 1 } : { opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{
                    duration: reduce ? 0 : durations.normal,
                    ease: easings.outExpo,
                }}
            >
                <LinePath<number>
                    data={data as number[]}
                    x={(_, i) => xScale(i) ?? 0}
                    y={(v) => yScale(v) ?? 0}
                    curve={curveMonotoneX}
                    stroke={color}
                    strokeWidth={strokeWidth}
                    fill="none"
                />
            </motion.g>
            {activeIndex !== undefined && activeIndex >= 0 && activeIndex < data.length && (
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
                        cy={yScale(data[activeIndex])}
                        r={3.5}
                        fill={color}
                        stroke="hsl(var(--background))"
                        strokeWidth={1.5}
                    />
                </g>
            )}
        </svg>
    );
}

