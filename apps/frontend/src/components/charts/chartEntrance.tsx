/**
 * Compositor-driven chart entrance animations.
 *
 * Series marks used to animate as Framer `m.*` SVG children: an opacity,
 * translate or clip-width change on an element inside an `<svg>` invalidates
 * the whole `<svg>` paint, so every chart re-rastered every frame of its
 * entrance. Here each animated mark lives in its own `<svg>` inside an HTML
 * wrapper, and the wrapper runs a CSS keyframe (`index.css`, "Chart entrance")
 * on `opacity`/`transform` only. The SVG rasters once and the compositor
 * animates the wrapper.
 *
 * Timing and easing match the Framer transitions they replace: durations and
 * delays come from `lib/motion.ts`, the curve is `--ease-out-expo` (the CSS
 * twin of `easings.outExpo`). `prefers-reduced-motion: reduce` turns every
 * keyframe off in CSS, which is what `useReducedMotion()` did before. A CSS
 * animation runs when its element is inserted, so, as with Framer's
 * `initial`, it plays on mount and on a key-based remount, never on a
 * re-render.
 */
import {
    type CSSProperties,
    type ReactNode,
    useLayoutEffect,
    useRef,
    useState,
} from "react";

import { durations } from "@/lib/motion";

/** A layer that covers the chart box without taking part in hit testing. */
const LAYER_STYLE: CSSProperties = {
    position: "absolute",
    left: 0,
    top: 0,
    pointerEvents: "none",
};

interface ChartLayerSvgProps {
    readonly width: number;
    readonly height: number;
    readonly children: ReactNode;
}

/**
 * A decorative SVG stacked under or over the chart's accessible frame. The
 * frame `<svg>` keeps the role, label, focus and pointer handling.
 */
export function ChartLayerSvg({ width, height, children }: ChartLayerSvgProps) {
    return (
        <svg
            width={width}
            height={height}
            aria-hidden="true"
            focusable="false"
            style={LAYER_STYLE}
        >
            {children}
        </svg>
    );
}

interface ChartEntranceProps {
    /** `fade`: opacity 0 → 1. `rise`: opacity 0 → 1 plus translateY 12px → 0. */
    readonly effect: "fade" | "rise";
    /** Seconds, from `durations`. */
    readonly duration: number;
    /** Seconds. */
    readonly delay?: number | undefined;
    readonly width: number;
    readonly height: number;
    readonly children: ReactNode;
}

/** One series mark's entrance, on an HTML wrapper the compositor can animate. */
export function ChartEntrance({
    effect,
    duration,
    delay = 0,
    width,
    height,
    children,
}: ChartEntranceProps) {
    return (
        <div
            className={
                effect === "rise" ? "chart-entrance-rise" : "chart-entrance-fade"
            }
            style={{
                ...LAYER_STYLE,
                width,
                height,
                animationDuration: `${duration}s`,
                animationDelay: `${delay}s`,
            }}
        >
            {children}
        </div>
    );
}

/** Horizontal translation (px) out of a CSS `transform` value; 0 when idle. */
function translateXOf(transform: string): number {
    const match = /^matrix\(([^)]*)\)$/.exec(transform);
    const tx = match?.[1]?.split(",")[4];
    const value = tx === undefined ? NaN : Number.parseFloat(tx);
    return Number.isFinite(value) ? value : 0;
}

interface ChartRevealProps {
    readonly width: number;
    readonly height: number;
    /** Left edge of the plot area (the chart's left margin). */
    readonly plotLeft: number;
    /** Width of the plot area; the sweep ends at `plotLeft + plotWidth`. */
    readonly plotWidth: number;
    readonly children: ReactNode;
}

const sweepVars = (
    width: number,
    plotLeft: number,
    fromWidth: number,
    toWidth: number,
) =>
    ({
        "--chart-reveal-from": `${plotLeft + fromWidth - width}px`,
        "--chart-reveal-to": `${plotLeft + toWidth - width}px`,
    }) as CSSProperties;

/**
 * Left-to-right sweep reveal with a hard vertical edge, replacing the
 * animated `<clipPath>` rect whose width tweened 0 → plot width over
 * `durations.page`.
 *
 * Instead of animating a clip (not composited for SVG), an `overflow: hidden`
 * wrapper slides left by the unrevealed width while its child slides back
 * right by the same amount: the content stays put and the wrapper's right
 * edge sweeps across it. Both are `transform` animations with the same timing,
 * so the compositor runs them and their sum is zero every frame. The visible
 * edge is at `plotLeft + plotWidth × ease(t)`, exactly where the rect's right
 * edge was. The resting clip to the plot area stays a static `<clipPath>` in
 * each series `<svg>`.
 *
 * Framer re-tweened the rect whenever the plot width changed (a resize), from
 * its current width to the new one. That is kept: a wider plot sweeps the
 * newly exposed strip in from wherever the edge currently is; a narrower one
 * needs no sweep because the static clip already ends at the new width.
 */
export function ChartReveal({
    width,
    height,
    plotLeft,
    plotWidth,
    children,
}: ChartRevealProps) {
    const clipRef = useRef<HTMLDivElement>(null);
    const previous = useRef({ width, plotWidth });
    // Mount sweep, written once; later sweeps are set on the element below so
    // a re-render never rewrites a running animation's endpoints.
    const [mountVars] = useState(() => sweepVars(width, plotLeft, 0, plotWidth));

    useLayoutEffect(() => {
        const prev = previous.current;
        previous.current = { width, plotWidth };
        const el = clipRef.current;
        if (!el || plotWidth === prev.plotWidth) return;
        // Where the edge is now: the old plot width, or less mid-sweep.
        const edge = prev.width + translateXOf(getComputedStyle(el).transform);
        const fromWidth = Math.min(prev.plotWidth, edge - plotLeft);
        const vars = sweepVars(
            width,
            plotLeft,
            Math.min(fromWidth, plotWidth),
            plotWidth,
        ) as Record<string, string>;
        for (const [name, value] of Object.entries(vars)) {
            el.style.setProperty(name, value);
        }
        if (fromWidth < plotWidth) {
            // A new animation-name restarts the keyframes (a/b are identical).
            el.dataset.sweep = el.dataset.sweep === "b" ? "a" : "b";
        }
    }, [width, plotWidth, plotLeft]);

    return (
        <div
            ref={clipRef}
            className="chart-reveal"
            style={{
                ...LAYER_STYLE,
                ...mountVars,
                width,
                height,
                animationDuration: `${durations.page}s`,
            }}
        >
            <div
                className="chart-reveal-content"
                style={{
                    ...LAYER_STYLE,
                    width,
                    height,
                    animationDuration: `${durations.page}s`,
                }}
            >
                {children}
            </div>
        </div>
    );
}
