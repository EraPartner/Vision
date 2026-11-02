import { bisector } from "d3-array";
import {
    type PointerEvent,
    useCallback,
    useEffect,
    useMemo,
    useReducer,
    useRef,
} from "react";
import type { PercentFormatter } from "@/hooks/useCurrencyFormatter";
import type { CartesianXScale } from "./CartesianChartFrame";

export interface ScrubRange {
    startIndex: number;
    endIndex: number;
}

/**
 * - `drag`: button held, the head follows the pointer.
 * - `follow`: a click anchored a point, the head follows the hover.
 * - `pinned`: the range is fixed until the next click, Escape or blur.
 */
type ScrubPhase = "idle" | "drag" | "follow" | "pinned";

interface ScrubState {
    readonly phase: ScrubPhase;
    readonly anchor: number | null;
    readonly head: number | null;
    /** Client x of the press that set the anchor; null for a keyboard anchor. */
    readonly anchorX: number | null;
    /** The current drag started on a pinned range: a plain click dismisses it. */
    readonly fromPinned: boolean;
}

type ScrubAction =
    | { readonly type: "press"; readonly index: number; readonly x: number }
    | { readonly type: "hover"; readonly index: number; readonly x: number }
    | { readonly type: "release" }
    | { readonly type: "begin"; readonly index: number }
    | { readonly type: "move"; readonly index: number }
    | { readonly type: "clear" };

const IDLE: ScrubState = {
    phase: "idle",
    anchor: null,
    head: null,
    anchorX: null,
    fromPinned: false,
};

/** Pixels a press may wander and still be a click, on any data density. */
const CLICK_SLOP_PX = 4;

function nearAnchor(state: ScrubState, x: number): boolean {
    return (
        state.anchorX !== null && Math.abs(x - state.anchorX) <= CLICK_SLOP_PX
    );
}

function scrubReducer(state: ScrubState, action: ScrubAction): ScrubState {
    switch (action.type) {
        case "press":
            if (state.phase === "follow") {
                // Second click of click-move-click: pin, or cancel on the anchor.
                return action.index === state.anchor ||
                    nearAnchor(state, action.x)
                    ? IDLE
                    : { ...state, phase: "pinned", head: action.index };
            }
            return {
                phase: "drag",
                anchor: action.index,
                head: action.index,
                anchorX: action.x,
                fromPinned: state.phase === "pinned",
            };
        case "hover": {
            if (state.phase !== "drag" && state.phase !== "follow") return state;
            const head =
                state.phase === "drag" && nearAnchor(state, action.x)
                    ? state.anchor
                    : action.index;
            return head === state.head ? state : { ...state, head };
        }
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
                anchorX: null,
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
 *   release until the next click, Escape or blur.
 * - click, move, click: the first click anchors a point, the range follows
 *   the pointer, the second click pins it.
 *
 * Leaving the chart keeps both: a drag may end outside the plot, a touch
 * leaves on every lift, and an anchor survives brushing past the edge.
 *
 * Either direction works; `range` is normalized (start ≤ end), so the change
 * always reads earlier → later. The range is held as indices, so it is dropped
 * when `data` moves to another timeline.
 */
export function useChartScrub<Datum>(
    data: ReadonlyArray<Datum>,
    xAccessor: (datum: Datum) => Date | number,
) {
    const [state, dispatch] = useReducer(scrubReducer, IDLE);

    const first = data[0];
    const last = data.at(-1);
    const timeline =
        first === undefined || last === undefined
            ? "empty"
            : `${data.length}:${Number(xAccessor(first))}:${Number(xAccessor(last))}`;
    useEffect(() => {
        dispatch({ type: "clear" });
    }, [timeline]);

    const press = useCallback((index: number, x: number) => {
        dispatch({ type: "press", index, x });
    }, []);
    // useReducer has no eager bailout: dispatch only when a move can matter.
    const tracking = state.phase === "drag" || state.phase === "follow";
    const hover = useCallback(
        (index: number, x: number) => {
            if (tracking) dispatch({ type: "hover", index, x });
        },
        [tracking],
    );
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
        headIndex: head,
        range,
        press,
        hover,
        release,
        begin,
        move,
        end,
    };
}

type ChartScrub = ReturnType<typeof useChartScrub>;

interface ChartPointerOptions<Datum> {
    readonly data: ReadonlyArray<Datum>;
    readonly xAccessor: (datum: Datum) => Date | number;
    readonly xScale: CartesianXScale;
    readonly scrub: ChartScrub;
    readonly scrubbable: boolean;
    readonly onHover: (index: number) => void;
    readonly onHoverEnd: () => void;
}

/** Handlers for a chart's hover-capture rect: hit-testing, hover and the scrub gesture. */
export function useChartPointer<Datum>({
    data,
    xAccessor,
    xScale,
    scrub,
    scrubbable,
    onHover,
    onHoverEnd,
}: ChartPointerOptions<Datum>) {
    const bisectX = useMemo(
        () => bisector<Datum, Date | number>((d) => xAccessor(d)),
        [xAccessor],
    );

    // Cache the overlay rect for the duration of a hover session instead of
    // calling getBoundingClientRect on every pointermove (forced layout per
    // frame). Cleared on pointerleave so the next hover re-measures.
    const overlayRectRef = useRef<DOMRect | null>(null);
    // The pointer holding a press: a second finger must not steer or end it.
    const pressedPointerRef = useRef<number | null>(null);

    const indexAt = (event: PointerEvent<SVGRectElement>) => {
        const rect = (overlayRectRef.current ??=
            event.currentTarget.getBoundingClientRect());
        const idx = bisectX.center(data, xScale.invert(event.clientX - rect.left));
        return idx >= 0 && idx < data.length ? idx : null;
    };
    const isOtherPointer = (event: PointerEvent<SVGRectElement>) =>
        pressedPointerRef.current !== null &&
        pressedPointerRef.current !== event.pointerId;

    return {
        onPointerMove: (event: PointerEvent<SVGRectElement>) => {
            if (isOtherPointer(event)) return;
            const idx = indexAt(event);
            if (idx == null) return;
            onHover(idx);
            scrub.hover(idx, event.clientX);
        },
        onPointerLeave: (event: PointerEvent<SVGRectElement>) => {
            if (isOtherPointer(event)) return;
            overlayRectRef.current = null;
            onHoverEnd();
        },
        onPointerDown: (event: PointerEvent<SVGRectElement>) => {
            // ctrlKey: macOS ctrl-click opens the context menu, so no release follows.
            if (!scrubbable || !event.isPrimary) return;
            if (event.button !== 0 || event.ctrlKey) return;
            const idx = indexAt(event);
            if (idx == null) return;
            // Keep receiving moves while the button is held outside the plot.
            event.currentTarget.setPointerCapture(event.pointerId);
            pressedPointerRef.current = event.pointerId;
            scrub.press(idx, event.clientX);
        },
        onPointerUp: (event: PointerEvent<SVGRectElement>) => {
            if (pressedPointerRef.current !== event.pointerId) return;
            pressedPointerRef.current = null;
            scrub.release();
        },
        // The browser took the press (a touch that became a scroll).
        onPointerCancel: (event: PointerEvent<SVGRectElement>) => {
            if (isOtherPointer(event)) return;
            overlayRectRef.current = null;
            onHoverEnd();
            if (pressedPointerRef.current === null) return;
            pressedPointerRef.current = null;
            scrub.end();
        },
    };
}

/** Δ readout text: absolute change, plus percent when `formatPercent` is given and start is not 0. */
export function formatScrubDelta(
    startValue: number,
    endValue: number,
    formatValue: (v: number) => string,
    formatPercent: PercentFormatter | undefined,
): string {
    const delta = endValue - startValue;
    const sign = delta > 0 ? "+" : delta < 0 ? "−" : "±";
    // Some formatters sign their output themselves (e.g. relative-performance
    // "+x %"); strip any leading sign so ours is the only one.
    const abs = formatValue(Math.abs(delta)).replace(/^[+\-−±]\s?/, "");
    if (startValue === 0 || !formatPercent) return `Δ ${sign}${abs}`;
    const pct = (delta / Math.abs(startValue)) * 100;
    const pctText = `${pct > 0 ? "+" : pct < 0 ? "−" : ""}${formatPercent(Math.abs(pct), { digits: 1 })}`;
    return `Δ ${sign}${abs} (${pctText})`;
}

export interface ScrubSeries<Datum> {
    readonly key: string;
    readonly label?: string | undefined;
    readonly color: string;
    readonly value: (datum: Datum) => number | null | undefined;
    /** The chart's main series: it leads the readout and tints the band. */
    readonly primary?: boolean | undefined;
}

export interface ScrubRow<Datum = unknown> {
    readonly key: string;
    readonly label: string | undefined;
    readonly color: string;
    readonly start: number;
    readonly end: number;
    /** The data points `start` and `end` were read from. */
    readonly startDatum: Datum;
    readonly endDatum: Datum;
    /** The series has no value at an end of the range, so its change spans less. */
    readonly partial: boolean;
}

function readPoint<Datum>(series: ScrubSeries<Datum>, datum: Datum | undefined) {
    if (datum === undefined) return undefined;
    const value = series.value(datum);
    return value != null && Number.isFinite(value) ? { datum, value } : undefined;
}

/**
 * First and last value of every series inside the range. A series without a
 * value at an end (another market's calendar, actuals that stop today) reads
 * its nearest one inside the range and is marked `partial`.
 */
export function scrubRows<Datum>(
    series: ReadonlyArray<ScrubSeries<Datum>>,
    data: ReadonlyArray<Datum>,
    startIndex: number,
    endIndex: number,
): ScrubRow<Datum>[] {
    const rows: ScrubRow<Datum>[] = [];
    for (const s of series) {
        let start: ReturnType<typeof readPoint<Datum>>;
        for (let i = startIndex; i <= endIndex && !start; i++) {
            start = readPoint(s, data[i]);
        }
        let end: ReturnType<typeof readPoint<Datum>>;
        for (let i = endIndex; i >= startIndex && !end; i--) {
            end = readPoint(s, data[i]);
        }
        if (!start || !end) continue;
        // One value inside a real range has no change to report.
        if (start.datum === end.datum && startIndex !== endIndex) continue;
        rows.push({
            key: s.key,
            label: s.label,
            color: s.color,
            start: start.value,
            end: end.value,
            startDatum: start.datum,
            endDatum: end.datum,
            partial:
                start.datum !== data[startIndex] ||
                end.datum !== data[endIndex],
        });
    }
    return rows;
}

export interface ScrubView<Datum> {
    readonly startDatum: Datum;
    readonly endDatum: Datum;
    /** Rows in readout order: the primary series first. */
    readonly rows: ScrubRow<Datum>[];
    /** The row the band is tinted by; undefined when no series stands for the chart. */
    readonly lead: ScrubRow<Datum> | undefined;
    /** More than one series is plotted, so a row needs its name. */
    readonly labelled: boolean;
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
    const rows = scrubRows(series, data, startIndex, endIndex);
    const primary = series.find((s) => s.primary);
    const lead = primary
        ? rows.find((row) => row.key === primary.key)
        : series.length === 1
          ? rows[0]
          : undefined;
    return {
        startDatum,
        endDatum,
        rows: lead ? [lead, ...rows.filter((row) => row !== lead)] : rows,
        lead,
        labelled: series.length > 1,
        isRange: scrub.range !== null,
    };
}

export interface ScrubMarker {
    readonly key: string;
    readonly x: number;
    readonly y: number;
    readonly color: string;
}

/** Value dots for one end of the range, on the data point each row read. */
export function scrubMarkers<Datum>(
    rows: ReadonlyArray<ScrubRow<Datum>>,
    end: "start" | "end",
    x: (datum: Datum) => number,
    y: (value: number, row: ScrubRow<Datum>) => number | undefined,
): ScrubMarker[] {
    const markers: ScrubMarker[] = [];
    for (const row of rows) {
        const markerY = y(row[end], row);
        if (markerY === undefined) continue;
        markers.push({
            key: row.key,
            x: x(end === "start" ? row.startDatum : row.endDatum),
            y: markerY,
            color: row.color,
        });
    }
    return markers;
}
