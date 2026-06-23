import { useCallback, useState } from "react";

export interface ScrubRange {
    startIndex: number;
    endIndex: number;
}

/**
 * Pointer-drag scrub state for time-series charts (Apple-Stocks style
 * range compare). The chart owns hit-testing (x → index); this hook owns
 * the drag lifecycle. Range is normalized (start ≤ end).
 */
export function useChartScrub() {
    const [anchor, setAnchor] = useState<number | null>(null);
    const [head, setHead] = useState<number | null>(null);

    const begin = useCallback((index: number) => {
        setAnchor(index);
        setHead(index);
    }, []);

    const move = useCallback((index: number) => {
        setHead(index);
    }, []);

    const end = useCallback(() => {
        setAnchor(null);
        setHead(null);
    }, []);

    const range: ScrubRange | null =
        anchor !== null && head !== null && anchor !== head
            ? { startIndex: Math.min(anchor, head), endIndex: Math.max(anchor, head) }
            : null;

    return { scrubbing: anchor !== null, range, begin, move, end };
}

/** Δ readout text: absolute change + percent (percent omitted when start is 0). */
export function formatScrubDelta(
    startValue: number,
    endValue: number,
    formatValue: (v: number) => string,
): string {
    const delta = endValue - startValue;
    const sign = delta > 0 ? "+" : delta < 0 ? "−" : "±";
    // Some formatters sign their output themselves (e.g. relative-performance
    // "+x %"); strip any leading sign so ours is the only one.
    const abs = formatValue(Math.abs(delta)).replace(/^[+\-−±]\s?/, "");
    if (startValue === 0) return `Δ ${sign}${abs}`;
    const pct = (delta / Math.abs(startValue)) * 100;
    const pctText = `${pct > 0 ? "+" : pct < 0 ? "−" : ""}${Math.abs(pct).toFixed(1)}%`;
    return `Δ ${sign}${abs} (${pctText})`;
}
