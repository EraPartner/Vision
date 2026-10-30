import { useCallback, useReducer } from "react";
import type { PercentFormatter } from "@/hooks/useCurrencyFormatter";

export interface ScrubRange {
    startIndex: number;
    endIndex: number;
}

/**
 * - `drag`: button held, the head follows the pointer.
 * - `follow`: a click anchored a point, the head follows the hover.
 * - `pinned`: the range is fixed until the next click, Escape or leave.
 */
type ScrubPhase = "idle" | "drag" | "follow" | "pinned";

interface ScrubState {
    readonly phase: ScrubPhase;
    readonly anchor: number | null;
    readonly head: number | null;
    /** The current drag started on a pinned range: a plain click dismisses it. */
    readonly fromPinned: boolean;
}

type ScrubAction =
    | { readonly type: "press"; readonly index: number }
    | { readonly type: "hover"; readonly index: number }
    | { readonly type: "release" }
    | { readonly type: "begin"; readonly index: number }
    | { readonly type: "move"; readonly index: number }
    | { readonly type: "clear" };

const IDLE: ScrubState = {
    phase: "idle",
    anchor: null,
    head: null,
    fromPinned: false,
};

function scrubReducer(state: ScrubState, action: ScrubAction): ScrubState {
    switch (action.type) {
        case "press":
            if (state.phase === "follow") {
                // Second click of click-move-click: pin, or cancel on the anchor.
                return action.index === state.anchor
                    ? IDLE
                    : { ...state, phase: "pinned", head: action.index };
            }
            return {
                phase: "drag",
                anchor: action.index,
                head: action.index,
                fromPinned: state.phase === "pinned",
            };
        case "hover":
            return state.phase === "drag" || state.phase === "follow"
                ? state.head === action.index
                    ? state
                    : { ...state, head: action.index }
                : state;
        case "release":
            if (state.phase !== "drag") return state;
            if (state.head !== state.anchor) return { ...state, phase: "pinned" };
            // A click without a drag: dismiss a pinned range, else anchor here.
            return state.fromPinned ? IDLE : { ...state, phase: "follow" };
        case "begin":
            return {
                phase: "drag",
                anchor: action.index,
                head: action.index,
                fromPinned: false,
            };
        case "move":
            return state.anchor === null ? state : { ...state, head: action.index };
        case "clear":
            return state.phase === "idle" ? state : IDLE;
    }
}

/**
 * Range-compare state for time-series charts (Apple-Stocks style). The chart
 * owns hit-testing (x → index); this hook owns the gesture:
 *
 * - press, drag, release: compare the dragged range; it stays on screen after
 *   release until the next click, Escape or the pointer leaving the chart.
 * - click, move, click: the first click anchors a point, the range follows
 *   the pointer, the second click pins it.
 *
 * Either direction works; `range` is normalized (start ≤ end), so the change
 * always reads earlier → later.
 */
export function useChartScrub() {
    const [state, dispatch] = useReducer(scrubReducer, IDLE);

    const press = useCallback((index: number) => {
        dispatch({ type: "press", index });
    }, []);
    const hover = useCallback((index: number) => {
        dispatch({ type: "hover", index });
    }, []);
    const release = useCallback(() => {
        dispatch({ type: "release" });
    }, []);
    // Keyboard path (Shift+←/→): anchor, then extend; any other key ends it.
    const begin = useCallback((index: number) => {
        dispatch({ type: "begin", index });
    }, []);
    const move = useCallback((index: number) => {
        dispatch({ type: "move", index });
    }, []);
    const end = useCallback(() => {
        dispatch({ type: "clear" });
    }, []);

    const { anchor, head } = state;
    const range: ScrubRange | null =
        anchor !== null && head !== null && anchor !== head
            ? {
                  startIndex: Math.min(anchor, head),
                  endIndex: Math.max(anchor, head),
              }
            : null;

    return {
        scrubbing: anchor !== null,
        anchorIndex: anchor,
        range,
        press,
        hover,
        release,
        begin,
        move,
        end,
    };
}

/** Δ readout text: absolute change + percent (percent omitted when start is 0). */
export function formatScrubDelta(
    startValue: number,
    endValue: number,
    formatValue: (v: number) => string,
    formatPercent: PercentFormatter,
): string {
    const delta = endValue - startValue;
    const sign = delta > 0 ? "+" : delta < 0 ? "−" : "±";
    // Some formatters sign their output themselves (e.g. relative-performance
    // "+x %"); strip any leading sign so ours is the only one.
    const abs = formatValue(Math.abs(delta)).replace(/^[+\-−±]\s?/, "");
    if (startValue === 0) return `Δ ${sign}${abs}`;
    const pct = (delta / Math.abs(startValue)) * 100;
    const pctText = `${pct > 0 ? "+" : pct < 0 ? "−" : ""}${formatPercent(Math.abs(pct), { digits: 1 })}`;
    return `Δ ${sign}${abs} (${pctText})`;
}

export interface ScrubSeries<Datum> {
    readonly key: string;
    readonly label?: string | undefined;
    readonly color: string;
    readonly value: (datum: Datum) => number | null | undefined;
}

export interface ScrubRow {
    readonly key: string;
    readonly label: string | undefined;
    readonly color: string;
    readonly start: number;
    readonly end: number;
}

/** Start/end values of every series with a finite value at both ends. */
export function scrubRows<Datum>(
    series: ReadonlyArray<ScrubSeries<Datum>>,
    startDatum: Datum,
    endDatum: Datum,
): ScrubRow[] {
    const rows: ScrubRow[] = [];
    for (const s of series) {
        const start = s.value(startDatum);
        const end = s.value(endDatum);
        if (start == null || end == null) continue;
        if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
        rows.push({ key: s.key, label: s.label, color: s.color, start, end });
    }
    return rows;
}

export interface ScrubView<Datum> {
    readonly startDatum: Datum;
    readonly endDatum: Datum;
    readonly rows: ScrubRow[];
    /** False while only a point is anchored (start and end are the same datum). */
    readonly isRange: boolean;
}

/** What to draw for the current scrub: the range, or just the anchored point. */
export function scrubView<Datum>(
    scrub: { readonly range: ScrubRange | null; readonly anchorIndex: number | null },
    data: ReadonlyArray<Datum>,
    series: ReadonlyArray<ScrubSeries<Datum>>,
): ScrubView<Datum> | null {
    const startIndex = scrub.range?.startIndex ?? scrub.anchorIndex;
    const endIndex = scrub.range?.endIndex ?? scrub.anchorIndex;
    if (startIndex === null || endIndex === null) return null;
    const startDatum = data[startIndex];
    const endDatum = data[endIndex];
    if (startDatum === undefined || endDatum === undefined) return null;
    return {
        startDatum,
        endDatum,
        rows: scrubRows(series, startDatum, endDatum),
        isRange: scrub.range !== null,
    };
}
