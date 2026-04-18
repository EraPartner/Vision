/**
 * ChartTooltip — glass-thick tooltip surface for visx charts.
 *
 * Renders absolute-positioned tooltip with backdrop blur, inset border,
 * motion-driven entry (respects prefers-reduced-motion).
 */
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import type { CSSProperties, ReactNode } from "react";

import { durations, easings } from "@/lib/motion";
import { cn } from "@/lib/utils";

export interface ChartTooltipDatum {
    readonly label: string;
    readonly value: string | number;
    readonly color?: string;
}

export interface ChartTooltipProps {
    readonly open: boolean;
    readonly left: number;
    readonly top: number;
    readonly title?: string;
    readonly items?: ReadonlyArray<ChartTooltipDatum>;
    readonly children?: ReactNode;
    readonly className?: string;
}

export function ChartTooltip({
    open,
    left,
    top,
    title,
    items,
    children,
    className,
}: ChartTooltipProps) {
    const reduce = useReducedMotion();

    const style: CSSProperties = {
        position: "absolute",
        left,
        top,
        transform: "translate(-50%, calc(-100% - 12px))",
        pointerEvents: "none",
        zIndex: 40,
    };

    return (
        <AnimatePresence>
            {open ? (
                <motion.div
                    key="chart-tooltip"
                    style={style}
                    initial={reduce ? { opacity: 1 } : { opacity: 0, y: 4, scale: 0.98 }}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    exit={reduce ? { opacity: 0 } : { opacity: 0, y: 2, scale: 0.98 }}
                    transition={{
                        duration: reduce ? 0 : durations.fast,
                        ease: easings.outExpo,
                    }}
                    className={cn(
                        "glass-thick min-w-[140px] max-w-[260px] rounded-xl border border-border/60 px-3 py-2 text-xs shadow-glass-elevated",
                        "ring-1 ring-inset ring-white/10",
                        className,
                    )}
                >
                    {title ? (
                        <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                            {title}
                        </div>
                    ) : null}
                    {items && items.length > 0 ? (
                        <ul className="space-y-1">
                            {items.map((item, idx) => (
                                <li
                                    key={`${item.label}-${idx}`}
                                    className="flex items-center justify-between gap-3"
                                >
                                    <span className="flex items-center gap-2 text-foreground/80">
                                        {item.color ? (
                                            <span
                                                className="inline-block size-2 rounded-full"
                                                style={{ background: item.color }}
                                            />
                                        ) : null}
                                        <span>{item.label}</span>
                                    </span>
                                    <span className="font-medium tabular-nums text-foreground">
                                        {item.value}
                                    </span>
                                </li>
                            ))}
                        </ul>
                    ) : null}
                    {children}
                </motion.div>
            ) : null}
        </AnimatePresence>
    );
}
