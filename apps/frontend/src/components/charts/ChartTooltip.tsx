/**
 * ChartTooltip — glass-thick tooltip surface for visx charts.
 *
 * Renders into a portal with viewport-aware positioning:
 *  - Default placement: centered above the anchor point.
 *  - Flips to the left/right of the anchor when it would overflow the
 *    horizontal edge of the viewport.
 *  - Drops below the anchor (or clamps) when it would overflow the top.
 *  - Always clamps to the viewport so no content is ever hidden behind
 *    `overflow:hidden` ancestors.
 */
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { useLayoutEffect, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { createPortal } from "react-dom";

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

const GAP = 12;
const PAD = 8;

interface PositionInput {
    readonly anchorX: number;
    readonly anchorY: number;
    readonly tw: number;
    readonly th: number;
    readonly vw: number;
    readonly vh: number;
}

function computePosition({ anchorX, anchorY, tw, th, vw, vh }: PositionInput): {
    x: number;
    y: number;
} {
    let sidePlacement = false;

    // Default: centered above the anchor point
    let x = anchorX - tw / 2;
    let y = anchorY - th - GAP;

    // Horizontal flip when default centering overflows the right edge
    if (x + tw > vw - PAD) {
        sidePlacement = true;
        x = anchorX - tw - GAP;
        y = anchorY - th / 2;
    } else if (x < PAD) {
        sidePlacement = true;
        x = anchorX + GAP;
        y = anchorY - th / 2;
    }

    // Vertical fallback when above doesn't fit (only relevant for top placement)
    if (!sidePlacement && y < PAD) {
        const below = anchorY + GAP;
        if (below + th <= vh - PAD) {
            y = below;
        } else {
            y = PAD;
        }
    }

    // Final viewport clamps
    if (x + tw > vw - PAD) x = Math.max(PAD, vw - tw - PAD);
    if (x < PAD) x = PAD;
    if (y + th > vh - PAD) y = Math.max(PAD, vh - th - PAD);
    if (y < PAD) y = PAD;

    return { x, y };
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
    const anchorRef = useRef<HTMLSpanElement>(null);
    const tooltipRef = useRef<HTMLDivElement>(null);
    const [pos, setPos] = useState<{ x: number; y: number; ready: boolean }>({
        x: 0,
        y: 0,
        ready: false,
    });

    useLayoutEffect(() => {
        if (open) setPos((p) => (p.ready ? { ...p, ready: false } : p));
    }, [open]);

    useLayoutEffect(() => {
        if (!open) return;
        const tip = tooltipRef.current;
        const anchorParent = anchorRef.current?.parentElement;
        if (!tip || !anchorParent) return;

        const parentRect = anchorParent.getBoundingClientRect();
        const tw = tip.offsetWidth;
        const th = tip.offsetHeight;
        if (tw === 0 || th === 0) return;

        const next = computePosition({
            anchorX: parentRect.left + left,
            anchorY: parentRect.top + top,
            tw,
            th,
            vw: window.innerWidth,
            vh: window.innerHeight,
        });

        if (
            !pos.ready ||
            Math.abs(next.x - pos.x) > 0.5 ||
            Math.abs(next.y - pos.y) > 0.5
        ) {
            setPos({ x: next.x, y: next.y, ready: true });
        }
    });

    const tooltipStyle: CSSProperties = {
        position: "fixed",
        left: pos.x,
        top: pos.y,
        pointerEvents: "none",
        zIndex: 9999,
        visibility: pos.ready ? "visible" : "hidden",
    };

    const tooltipNode = (
        <AnimatePresence>
            {open ? (
                <motion.div
                    ref={tooltipRef}
                    key="chart-tooltip"
                    style={tooltipStyle}
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

    return (
        <>
            <span ref={anchorRef} aria-hidden="true" style={{ display: "none" }} />
            {typeof document !== "undefined"
                ? createPortal(tooltipNode, document.body)
                : tooltipNode}
        </>
    );
}
