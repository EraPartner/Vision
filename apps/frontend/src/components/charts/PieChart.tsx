/**
 * PieChart — visx + framer-motion pie chart with optional labels.
 */
import { Group } from "@visx/group";
import { summarizeProportionChart } from "./chartAria";
import { Pie } from "@visx/shape";
import { ParentSize } from "@visx/responsive";
import { motion, useReducedMotion } from "framer-motion";
import { useCallback, useMemo, useState } from "react";

import { ChartTooltip } from "./ChartTooltip";
import { getChartColor } from "./palette";
import { durations, easings } from "@/lib/motion";

export interface PieDatum {
    readonly name: string;
    readonly value: number;
    readonly color?: string;
}

export interface PieChartProps {
    readonly data: ReadonlyArray<PieDatum>;
    readonly height?: number;
    readonly padAngle?: number;
    readonly showLabels?: boolean;
    readonly labelFormat?: (datum: PieDatum, percent: number) => string;
    readonly tooltipValueFormat?: (value: number) => string;
    readonly ariaLabel?: string;
}

export function PieChart(props: PieChartProps) {
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

function Inner({
    data,
    padAngle = 0.025,
    showLabels = false,
    labelFormat,
    tooltipValueFormat,
    width,
    height,
    ariaLabel,
}: PieChartProps & { width: number; height: number }) {
    const reduce = useReducedMotion();
    const radius = Math.min(width, height) / 2 - 8;
    const centerX = width / 2;
    const centerY = height / 2;

    const total = useMemo(() => data.reduce((s, d) => s + d.value, 0), [data]);
    const [hover, setHover] = useState<{ datum: PieDatum; x: number; y: number } | null>(null);

    const handleLeave = useCallback(() => setHover(null), []);

    return (
        <div style={{ position: "relative", width, height }}>
            <svg width={width} height={height} role="img" aria-label={ariaLabel ?? summarizeProportionChart("Pie chart", data.map((d) => d.name))}>
                <Group top={centerY} left={centerX}>
                    <Pie
                        data={data as PieDatum[]}
                        pieValue={(d) => d.value}
                        outerRadius={radius}
                        innerRadius={0}
                        padAngle={padAngle}
                    >
                        {(pie) =>
                            pie.arcs.map((arc, i) => {
                                const color = arc.data.color ?? getChartColor(i);
                                const d = pie.path(arc) ?? "";
                                const [cx, cy] = pie.path.centroid(arc);
                                const pct = total > 0 ? arc.data.value / total : 0;
                                const showLabel = showLabels && pct > 0.04;
                                return (
                                    <g key={`arc-${i}`}>
                                        <motion.path
                                            d={d}
                                            fill={color}
                                            stroke="hsl(var(--background))"
                                            strokeWidth={1.5}
                                            initial={
                                                reduce
                                                    ? { opacity: 1, scale: 1 }
                                                    : { opacity: 0, scale: 0.92 }
                                            }
                                            animate={{ opacity: 1, scale: 1 }}
                                            transition={{
                                                duration: reduce ? 0 : durations.slow,
                                                ease: easings.outExpo,
                                                delay: i * 0.04,
                                            }}
                                            onPointerEnter={(e) => {
                                                const rect =
                                                    e.currentTarget.ownerSVGElement?.getBoundingClientRect();
                                                if (!rect) return;
                                                setHover({
                                                    datum: arc.data,
                                                    x: centerX + cx,
                                                    y: centerY + cy,
                                                });
                                            }}
                                            onPointerLeave={handleLeave}
                                            style={{ cursor: "pointer" }}
                                        />
                                        {showLabel ? (
                                            <text
                                                x={cx}
                                                y={cy}
                                                dy=".33em"
                                                fontSize={11}
                                                textAnchor="middle"
                                                fill="hsl(var(--background))"
                                                pointerEvents="none"
                                            >
                                                {labelFormat
                                                    ? labelFormat(arc.data, pct)
                                                    : `${(pct * 100).toFixed(0)}%`}
                                            </text>
                                        ) : null}
                                    </g>
                                );
                            })
                        }
                    </Pie>
                </Group>
            </svg>

            <ChartTooltip
                open={hover != null}
                left={hover?.x ?? 0}
                top={hover?.y ?? 0}
                title={hover?.datum.name}
                items={
                    hover
                        ? [
                              {
                                  label: hover.datum.name,
                                  color: hover.datum.color,
                                  value: tooltipValueFormat
                                      ? tooltipValueFormat(hover.datum.value)
                                      : String(hover.datum.value),
                              },
                          ]
                        : []
                }
            />
        </div>
    );
}
