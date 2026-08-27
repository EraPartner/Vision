/**
 * DonutChart — hollow pie with optional center content.
 */
import { Group } from "@visx/group";
import { summarizeProportionChart } from "./chartAria";
import { Pie } from "@visx/shape";
import { ParentSize } from "@visx/responsive";
import { AnimatePresence, m, useReducedMotion } from "framer-motion";
import { useCallback, useState, type ReactNode } from "react";

import { getChartColor } from "./palette";
import { durations, easings } from "@/lib/motion";
import { useLanguage } from "@/contexts/LanguageContext";
import type { PieDatum } from "./PieChart";
import { useChartKeyboardNav } from "./keyboardNav";

type DonutDatum = PieDatum & { readonly to?: string };

export interface DonutChartProps {
    readonly data: ReadonlyArray<DonutDatum>;
    readonly height?: number;
    readonly innerRadiusRatio?: number;
    readonly padAngle?: number;
    readonly center?: ReactNode;
    readonly tooltipValueFormat?: (value: number) => string;
    readonly ariaLabel?: string;
    readonly onNavigate?: (to: string) => void;
}

export function DonutChart(props: DonutChartProps) {
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

function Inner({
    data,
    innerRadiusRatio = 0.6,
    padAngle = 0.025,
    center,
    tooltipValueFormat,
    width,
    height,
    ariaLabel,
    onNavigate,
}: DonutChartProps & { width: number; height: number }) {
    const { t } = useLanguage();
    const reduce = useReducedMotion();
    const outer = Math.min(width, height) / 2 - 8;
    const inner = outer * innerRadiusRatio;
    const cx = width / 2;
    const cy = height / 2;

    const [hoverIndex, setHoverIndex] = useState<number | null>(null);
    const safeHoverIndex =
        hoverIndex != null && hoverIndex < data.length ? hoverIndex : null;
    const hover =
        safeHoverIndex == null
            ? null
            : {
                  ...data[safeHoverIndex],
                  color:
                      data[safeHoverIndex].color ??
                      getChartColor(safeHoverIndex),
              };
    const handleLeave = useCallback(() => setHoverIndex(null), []);
    const keyboardNav = useChartKeyboardNav({
        pointCount: data.length,
        index: safeHoverIndex,
        onIndexChange: setHoverIndex,
        onClear: handleLeave,
    });

    const formatValue = (v: number) =>
        tooltipValueFormat ? tooltipValueFormat(v) : String(v);
    const hasLinks = data.some((datum) => Boolean(datum.to));

    return (
        <div style={{ position: "relative", width, height }}>
            <svg
                width={width}
                height={height}
                role={hasLinks ? "group" : "img"}
                aria-label={
                    ariaLabel ??
                    summarizeProportionChart(
                        t,
                        "chart.aria.kind.donut",
                        data.map((d) => d.name),
                    )
                }
                tabIndex={!hasLinks && data.length > 0 ? 0 : undefined}
                onKeyDown={!hasLinks ? keyboardNav.onKeyDown : undefined}
                onBlur={!hasLinks ? keyboardNav.onBlur : undefined}
            >
                <Group top={cy} left={cx}>
                    <Pie
                        data={data as DonutDatum[]}
                        pieValue={(d) => d.value}
                        outerRadius={outer}
                        innerRadius={inner}
                        padAngle={padAngle}
                    >
                        {(pie) =>
                            pie.arcs.map((arc, i) => {
                                const color =
                                    arc.data.color ?? getChartColor(i);
                                const d = pie.path(arc) ?? "";
                                const path = (
                                    <m.path
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
                                        whileHover={
                                            reduce
                                                ? undefined
                                                : { scale: 1.045 }
                                        }
                                        transition={{
                                            duration: reduce
                                                ? 0
                                                : durations.slow,
                                            ease: easings.outExpo,
                                            delay: i * 0.04,
                                        }}
                                        onPointerEnter={() => setHoverIndex(i)}
                                        onPointerLeave={handleLeave}
                                        style={{
                                            cursor: arc.data.to
                                                ? "pointer"
                                                : "default",
                                            transformBox: "fill-box",
                                            transformOrigin: "center",
                                        }}
                                    />
                                );
                                return arc.data.to ? (
                                    <a
                                        key={`arc-${i}`}
                                        href={arc.data.to}
                                        aria-label={`${arc.data.name}: ${formatValue(arc.data.value)}`}
                                        onClick={(event) => {
                                            if (
                                                event.button === 0 &&
                                                !event.metaKey &&
                                                !event.ctrlKey &&
                                                !event.shiftKey &&
                                                !event.altKey &&
                                                onNavigate
                                            ) {
                                                event.preventDefault();
                                                onNavigate(arc.data.to!);
                                            }
                                        }}
                                    >
                                        {path}
                                    </a>
                                ) : (
                                    path
                                );
                            })
                        }
                    </Pie>
                </Group>
            </svg>

            {/* Center morph: hovering a slice swaps the hollow's content for
                that slice's name + value — the donut is its own tooltip. */}
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
                <AnimatePresence mode="wait" initial={false}>
                    <m.div
                        key={hover ? `h-${hover.name}` : "default"}
                        initial={
                            reduce
                                ? { opacity: 1 }
                                : { opacity: 0, scale: 0.96 }
                        }
                        animate={{ opacity: 1, scale: 1 }}
                        exit={reduce ? { opacity: 1 } : { opacity: 0 }}
                        transition={{
                            duration: reduce ? 0 : durations.fast,
                            ease: easings.outExpo,
                        }}
                        style={{ maxWidth: inner * 1.7, textAlign: "center" }}
                    >
                        {hover ? (
                            <div>
                                <div className="flex items-center justify-center gap-1.5 text-xs text-muted-foreground">
                                    <span
                                        aria-hidden="true"
                                        className="inline-block h-2 w-2 shrink-0 rounded-full"
                                        style={{
                                            backgroundColor:
                                                hover.color ?? undefined,
                                        }}
                                    />
                                    <span className="truncate">
                                        {hover.name}
                                    </span>
                                </div>
                                <div className="font-display text-lg font-semibold tabular-nums text-foreground">
                                    {formatValue(hover.value)}
                                </div>
                            </div>
                        ) : (
                            (center ?? null)
                        )}
                    </m.div>
                </AnimatePresence>
            </div>
        </div>
    );
}
