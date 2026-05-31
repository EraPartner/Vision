/**
 * DonutChart — hollow pie with optional center content.
 */
import { Group } from "@visx/group";
import { summarizeProportionChart } from "./chartAria";
import { Pie } from "@visx/shape";
import { ParentSize } from "@visx/responsive";
import { motion, useReducedMotion } from "framer-motion";
import { useCallback, useState, type ReactNode } from "react";

import { ChartTooltip } from "./ChartTooltip";
import { getChartColor } from "./palette";
import { durations, easings } from "@/lib/motion";
import { useLanguage } from "@/contexts/LanguageContext";
import type { PieDatum } from "./PieChart";

export interface DonutChartProps {
    readonly data: ReadonlyArray<PieDatum>;
    readonly height?: number;
    readonly innerRadiusRatio?: number;
    readonly padAngle?: number;
    readonly center?: ReactNode;
    readonly tooltipValueFormat?: (value: number) => string;
    readonly ariaLabel?: string;
}

export function DonutChart(props: DonutChartProps) {
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
    innerRadiusRatio = 0.6,
    padAngle = 0.025,
    center,
    tooltipValueFormat,
    width,
    height,
    ariaLabel,
}: DonutChartProps & { width: number; height: number }) {
    const { t } = useLanguage();
    const reduce = useReducedMotion();
    const outer = Math.min(width, height) / 2 - 8;
    const inner = outer * innerRadiusRatio;
    const cx = width / 2;
    const cy = height / 2;

    const [hover, setHover] = useState<{ datum: PieDatum; x: number; y: number } | null>(null);
    const handleLeave = useCallback(() => setHover(null), []);

    return (
        <div style={{ position: "relative", width, height }}>
            <svg width={width} height={height} role="img" aria-label={ariaLabel ?? summarizeProportionChart(t, 'chart.aria.kind.donut', data.map((d) => d.name))}>
                <Group top={cy} left={cx}>
                    <Pie
                        data={data as PieDatum[]}
                        pieValue={(d) => d.value}
                        outerRadius={outer}
                        innerRadius={inner}
                        padAngle={padAngle}
                    >
                        {(pie) =>
                            pie.arcs.map((arc, i) => {
                                const color = arc.data.color ?? getChartColor(i);
                                const d = pie.path(arc) ?? "";
                                const [ax, ay] = pie.path.centroid(arc);
                                return (
                                    <motion.path
                                        key={`arc-${i}`}
                                        d={d}
                                        fill={color}
                                        stroke="hsl(var(--background))"
                                        strokeWidth={1.5}
                                        initial={
                                            reduce
                                                ? { opacity: 1 }
                                                : { opacity: 0, scale: 0.92 }
                                        }
                                        animate={{ opacity: 1, scale: 1 }}
                                        transition={{
                                            duration: reduce ? 0 : durations.slow,
                                            ease: easings.outExpo,
                                            delay: i * 0.04,
                                        }}
                                        onPointerEnter={() =>
                                            setHover({
                                                datum: arc.data,
                                                x: cx + ax,
                                                y: cy + ay,
                                            })
                                        }
                                        onPointerLeave={handleLeave}
                                        style={{ cursor: "pointer" }}
                                    />
                                );
                            })
                        }
                    </Pie>
                </Group>
            </svg>

            {center ? (
                <div
                    style={{
                        position: "absolute",
                        left: 0,
                        top: 0,
                        width,
                        height,
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        pointerEvents: "none",
                    }}
                >
                    {center}
                </div>
            ) : null}

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
