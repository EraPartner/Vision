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
import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
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

// Static style for the always-mounted positioner div. left/top/visibility are
// written imperatively in applyPosition(); React never renders a different
// value for them, so its prop diffing never overwrites those writes.
const POSITIONER_STYLE: CSSProperties = {
    position: "fixed",
    left: 0,
    top: 0,
    pointerEvents: "none",
    zIndex: 9999,
    visibility: "hidden",
};

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
    const positionerRef = useRef<HTMLDivElement | null>(null);
    const resizeObserverRef = useRef<ResizeObserver | null>(null);
    // Layout caches: the anchor parent's rect is read once per hover session
    // (and again after scroll/resize); the tooltip's size comes from the
    // ResizeObserver below. The per-frame path is then pure arithmetic plus
    // style writes — the previous version forced two synchronous reflows per
    // hover frame (getBoundingClientRect + offsetWidth in a dependency-less
    // layout effect, then a setPos re-render measuring again).
    const parentRectRef = useRef<DOMRect | null>(null);
    const tipSizeRef = useRef({ w: 0, h: 0 });
    const anchorPointRef = useRef({ left, top });
    anchorPointRef.current = { left, top };

    const applyPosition = useCallback(() => {
        const tip = positionerRef.current;
        const anchorParent = anchorRef.current?.parentElement;
        if (!tip || !anchorParent) return;

        parentRectRef.current ??= anchorParent.getBoundingClientRect();
        const parentRect = parentRectRef.current;
        const { w: tw, h: th } = tipSizeRef.current;
        // Zero size means the ResizeObserver hasn't delivered the initial
        // measurement yet; it fires before paint, calls back in here, and
        // flips the tooltip visible at the correct spot.
        if (tw === 0 || th === 0) return;

        const next = computePosition({
            anchorX: parentRect.left + anchorPointRef.current.left,
            anchorY: parentRect.top + anchorPointRef.current.top,
            tw,
            th,
            vw: window.innerWidth,
            vh: window.innerHeight,
        });

        tip.style.left = `${next.x}px`;
        tip.style.top = `${next.y}px`;
        tip.style.visibility = "visible";
    }, []);

    // The positioner shrink-wraps the tooltip content, so observing it tracks
    // content-driven size changes (new items, longer labels) without touching
    // offsetWidth/offsetHeight on the hover path.
    const setPositionerEl = useCallback(
        (el: HTMLDivElement | null) => {
            positionerRef.current = el;
            resizeObserverRef.current?.disconnect();
            resizeObserverRef.current = null;
            if (!el) return;
            const ro = new ResizeObserver((entries) => {
                const entry = entries[entries.length - 1];
                const box = entry?.borderBoxSize?.[0];
                tipSizeRef.current = box
                    ? { w: box.inlineSize, h: box.blockSize }
                    : { w: el.offsetWidth, h: el.offsetHeight };
                applyPosition();
            });
            ro.observe(el);
            resizeObserverRef.current = ro;
        },
        [applyPosition],
    );

    useLayoutEffect(() => {
        if (!open) {
            // The rect cache is per hover session; the chart may have moved
            // by the time the next hover starts.
            parentRectRef.current = null;
            return;
        }
        applyPosition();
    }, [open, left, top, applyPosition]);

    // Scroll/resize move the anchor without any prop changing — drop the rect
    // cache and reposition from the fresh one.
    useEffect(() => {
        if (!open) return;
        const invalidate = () => {
            parentRectRef.current = null;
            applyPosition();
        };
        window.addEventListener("resize", invalidate);
        window.addEventListener("scroll", invalidate, true);
        return () => {
            window.removeEventListener("resize", invalidate);
            window.removeEventListener("scroll", invalidate, true);
        };
    }, [open, applyPosition]);

    // Mid-hover layout shifts (an async widget above expands, an accordion
    // reflows) can move the anchor parent without firing scroll/resize, leaving
    // the cached rect stale. Observe the parent so those moves drop the cache
    // and reposition from a fresh rect.
    useEffect(() => {
        if (!open) return;
        const anchorParent = anchorRef.current?.parentElement;
        if (!anchorParent) return;
        const ro = new ResizeObserver(() => {
            parentRectRef.current = null;
            applyPosition();
        });
        ro.observe(anchorParent);
        return () => ro.disconnect();
    }, [open, applyPosition]);

    const tooltipNode = (
        <div ref={setPositionerEl} style={POSITIONER_STYLE}>
            <AnimatePresence>
                {open ? (
                    <motion.div
                        key="chart-tooltip"
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
        </div>
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
