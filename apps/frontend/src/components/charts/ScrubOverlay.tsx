/**
 * Range-compare overlay for the time-series chart primitives: the band drawn
 * inside the plot and the Δ readout above it. State lives in `scrub.ts`.
 */
import type { PercentFormatter } from "@/hooks/useCurrencyFormatter";
import { cn } from "@/lib/utils";
import { CHART_NEUTRAL } from "./palette";
import { formatScrubDelta, type ScrubRow } from "./scrub";

const GAIN = "hsl(var(--gain))";
const LOSS = "hsl(var(--loss))";

function trendColor(rows: ReadonlyArray<ScrubRow>): string {
    const first = rows[0];
    if (!first || first.end === first.start) return CHART_NEUTRAL.label;
    return first.end > first.start ? GAIN : LOSS;
}

export interface ScrubMarker {
    readonly key: string;
    readonly y: number;
    readonly color: string;
}

interface ScrubBandProps {
    /** Plot x of the range start and end (equal while only anchored). */
    readonly xStart: number;
    readonly xEnd: number;
    readonly innerHeight: number;
    readonly rows: ReadonlyArray<ScrubRow>;
    /** Value dots at the start and end of the range. */
    readonly startMarkers?: ReadonlyArray<ScrubMarker> | undefined;
    readonly endMarkers?: ReadonlyArray<ScrubMarker> | undefined;
}

/** The selected range inside the plot: a tinted band, edge hairlines and value dots. */
export function ScrubBand({
    xStart,
    xEnd,
    innerHeight,
    rows,
    startMarkers,
    endMarkers,
}: ScrubBandProps) {
    const color = trendColor(rows);
    const left = Math.min(xStart, xEnd);
    const width = Math.abs(xEnd - xStart);
    const edges = width > 0 ? [xStart, xEnd] : [xStart];
    const markers = width > 0 ? [startMarkers, endMarkers] : [startMarkers];
    return (
        <g pointerEvents="none" data-testid="chart-scrub-band">
            {width > 0 ? (
                <rect
                    x={left}
                    y={0}
                    width={width}
                    height={innerHeight}
                    fill={color}
                    fillOpacity={0.1}
                />
            ) : null}
            {edges.map((x, i) => (
                <line
                    key={`edge-${i}`}
                    x1={x}
                    x2={x}
                    y1={0}
                    y2={innerHeight}
                    stroke={color}
                    strokeOpacity={0.7}
                    strokeWidth={1}
                />
            ))}
            {markers.map((set, i) =>
                set?.map((m) => (
                    <circle
                        key={`dot-${i}-${m.key}`}
                        cx={edges[i]}
                        cy={m.y}
                        r={3.5}
                        fill={CHART_NEUTRAL.background}
                        stroke={m.color}
                        strokeWidth={2}
                    />
                )),
            )}
        </g>
    );
}

interface ScrubReadoutProps {
    /** Chart-box x of the range start and end. */
    readonly xStart: number;
    readonly xEnd: number;
    /** Chart-box width the readout must stay inside. */
    readonly width: number;
    readonly top: number;
    readonly startTitle: string;
    readonly endTitle: string;
    readonly rows: ReadonlyArray<ScrubRow>;
    readonly formatValue: (value: number, seriesKey: string) => string;
    readonly formatPercent: PercentFormatter;
    readonly fullEffects: boolean;
    /** Rows beyond this are summarized as "+N". */
    readonly maxRows?: number | undefined;
}

/** The Δ readout over the range: period, then change per series. */
export function ScrubReadout({
    xStart,
    xEnd,
    width,
    top,
    startTitle,
    endTitle,
    rows,
    formatValue,
    formatPercent,
    fullEffects,
    maxRows = 4,
}: ScrubReadoutProps) {
    if (rows.length === 0) return null;
    const mid = (xStart + xEnd) / 2;
    // Shift by the same share of the readout's width as `mid` is of the
    // chart's, so the readout tracks the range and never leaves the box.
    const share = width > 0 ? Math.min(100, Math.max(0, (mid / width) * 100)) : 50;
    const shown = rows.slice(0, maxRows);
    const hidden = rows.length - shown.length;
    const labelled = rows.length > 1;
    return (
        <div
            role="status"
            data-testid="chart-scrub-readout"
            className={cn(
                "pointer-events-none absolute left-0 z-10 whitespace-nowrap rounded-xl px-2.5 py-1.5 type-footnote tabular-nums",
                fullEffects
                    ? "glass-thick"
                    : "border border-border/60 bg-card shadow-elevation-1",
            )}
            // transform, not left: the readout follows the pointer, and a
            // transform moves it without relayout per move.
            style={{
                top,
                transform: `translateX(${mid}px) translateX(-${share}%)`,
            }}
        >
            <div className="text-label-secondary">
                {startTitle} – {endTitle}
            </div>
            {shown.map((row) => {
                const delta = row.end - row.start;
                return (
                    <div
                        key={row.key}
                        className="flex items-center gap-1.5 font-medium"
                    >
                        {labelled ? (
                            <>
                                <span
                                    aria-hidden="true"
                                    className="size-2 shrink-0 rounded-full"
                                    style={{ backgroundColor: row.color }}
                                />
                                <span className="text-label-secondary">
                                    {row.label ?? row.key}
                                </span>
                            </>
                        ) : null}
                        <span
                            className={
                                delta > 0
                                    ? "text-gain"
                                    : delta < 0
                                      ? "text-loss"
                                      : "text-foreground"
                            }
                        >
                            {formatScrubDelta(
                                row.start,
                                row.end,
                                (v) => formatValue(v, row.key),
                                formatPercent,
                            )}
                        </span>
                    </div>
                );
            })}
            {hidden > 0 ? (
                <div className="text-label-secondary">+{hidden}</div>
            ) : null}
        </div>
    );
}
