/**
 * Keyboard access for per-point chart values: mirrors the pointer hover/scrub
 * interactions of the chart primitives onto the keyboard, reusing each chart's
 * existing tooltip/readout rendering (no new visual affordances — focus shows
 * the app's global `:focus-visible` ring).
 *
 * One shared key map so every chart behaves identically:
 *
 *   ←/→        step one data point (clamped at the ends)
 *   Home/End   jump to the first/last point
 *   Shift+←/→  extend a range-compare scrub (charts that pass `scrub`)
 *   Escape     clear the highlight and any scrub range
 *
 * Losing focus (blur) also clears, so no tooltip lingers on an unfocused
 * chart. Purely additive: pointer paths are untouched, and the handler calls
 * preventDefault only on keys it actually consumes (arrows/Home/End would
 * otherwise scroll the page). A range or anchor claims Escape ahead of an
 * enclosing dialog, so the next Escape closes the dialog.
 */
import { useCallback, useEffect, useRef } from "react";
import type { KeyboardEvent } from "react";

/** The subset of `useChartScrub` needed for Shift+arrow range compare. */
export interface ChartKeyboardScrub {
    readonly scrubbing: boolean;
    /** The moving end of the range, which Shift+arrow extends from. */
    readonly headIndex: number | null;
    readonly begin: (index: number) => void;
    readonly move: (index: number) => void;
    readonly end: () => void;
}

export interface ChartKeyboardNavOptions {
    /** Number of data points. 0 disables all handling (callers must also drop tabIndex so there is no dead tab stop). */
    readonly pointCount: number;
    /** Currently highlighted index, or null when nothing is highlighted. */
    readonly index: number | null;
    /** Highlight a point — reuse the chart's existing hover path. */
    readonly onIndexChange: (index: number) => void;
    /** Clear the highlight and any scrub (Escape and blur) — reuse the chart's pointer-leave path. */
    readonly onClear: () => void;
    /** Range-compare scrub state; pass only when the chart is scrubbable. */
    readonly scrub?: ChartKeyboardScrub | undefined;
}

export function useChartKeyboardNav({
    pointCount,
    index,
    onIndexChange,
    onClear,
    scrub,
}: ChartKeyboardNavOptions) {
    const frameRef = useRef<SVGSVGElement>(null);
    const scrubbing = scrub?.scrubbing ?? false;

    useEffect(() => {
        if (!scrubbing) return;
        // Radix dismisses from a document capture listener, before onKeyDown
        // runs, and skips it when the event is already defaultPrevented.
        const claimEscape = (event: globalThis.KeyboardEvent) => {
            if (
                event.key === "Escape" &&
                event.target instanceof Node &&
                frameRef.current?.contains(event.target)
            ) {
                event.preventDefault();
            }
        };
        window.addEventListener("keydown", claimEscape, { capture: true });
        return () => {
            window.removeEventListener("keydown", claimEscape, {
                capture: true,
            });
        };
    }, [scrubbing]);

    const onKeyDown = useCallback(
        (event: KeyboardEvent) => {
            if (pointCount <= 0) return;
            const last = pointCount - 1;
            const { key } = event;

            if (key === "Escape") {
                if (index !== null || scrub?.scrubbing) {
                    event.preventDefault();
                    onClear();
                }
                return;
            }

            const extending =
                event.shiftKey &&
                scrub !== undefined &&
                (key === "ArrowRight" || key === "ArrowLeft");
            const from = extending && scrub.scrubbing ? scrub.headIndex : index;

            let next: number;
            if (key === "ArrowRight") next = from === null ? 0 : Math.min(last, from + 1);
            else if (key === "ArrowLeft") next = from === null ? last : Math.max(0, from - 1);
            else if (key === "Home") next = 0;
            else if (key === "End") next = last;
            else return;

            event.preventDefault();
            if (extending) {
                // Shift+arrow = keyboard scrub: anchor on the first press, extend after.
                if (!scrub.scrubbing) scrub.begin(index ?? (key === "ArrowRight" ? 0 : last));
                scrub.move(next);
            } else if (scrub?.scrubbing) {
                // Plain navigation ends a scrub (keyboard-extended or pointer-pinned).
                scrub.end();
            }
            onIndexChange(next);
        },
        [pointCount, index, onIndexChange, onClear, scrub],
    );

    const onBlur = useCallback(() => {
        onClear();
    }, [onClear]);

    return { onKeyDown, onBlur, frameRef };
}
