/**
 * Sparkline — tiny trend line with draw-in motion.
 */
import { curveMonotoneX } from "@visx/curve";
import { ParentSize } from "@visx/responsive";
import { scaleLinear } from "@visx/scale";
import { LinePath } from "@visx/shape";
import { motion, useReducedMotion } from "framer-motion";
import { useMemo } from "react";

import { CHART_NEUTRAL } from "./palette";
import { durations, easings } from "@/lib/motion";

export interface SparklineProps {
    readonly data: ReadonlyArray<number>;
    readonly height?: number;
    readonly color?: string;
    readonly strokeWidth?: number;
    readonly fillArea?: boolean;
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
}: SparklineProps & { width: number; height: number }) {
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
        <svg width={width} height={height} role="img">
            {fillArea ? (
                <motion.path
                    d={buildArea(data, xScale, yScale, height)}
                    fill={color}
                    fillOpacity={0.15}
                    initial={reduce ? { opacity: 1 } : { opacity: 0 }}
                    animate={{ opacity: 1 }}
                    transition={{
                        duration: reduce ? 0 : durations.slow,
                        ease: easings.outExpo,
                    }}
                />
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
        </svg>
    );
}

function buildArea(
    data: ReadonlyArray<number>,
    xScale: (v: number) => number,
    yScale: (v: number) => number,
    height: number,
): string {
    if (data.length === 0) return "";
    const segments: string[] = [];
    data.forEach((v, i) => {
        const x = xScale(i);
        const y = yScale(v);
        segments.push(`${i === 0 ? "M" : "L"}${x},${y}`);
    });
    const lastX = xScale(data.length - 1);
    const firstX = xScale(0);
    segments.push(`L${lastX},${height}`);
    segments.push(`L${firstX},${height}`);
    segments.push("Z");
    return segments.join(" ");
}
