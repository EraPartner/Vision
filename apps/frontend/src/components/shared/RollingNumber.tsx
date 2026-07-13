import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import { prefersReducedMotion } from "@/utils/prefersReducedMotion";

const REEL = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"];

/** Money-treatment styling per segment kind (mirrors components/shared/Money). */
type SegmentKind = "currency" | "minor" | "plain";

interface Segment {
    text: string;
    kind: SegmentKind;
}

const SEGMENT_CLASS: Record<SegmentKind, string | undefined> = {
    currency: "text-[0.85em] font-medium opacity-85 self-start mt-[0.04em] mr-[0.06em]",
    minor: "text-[0.88em] opacity-75",
    plain: undefined,
};

/**
 * Collapse formatToParts output into styled runs. Adjacent same-kind parts are
 * merged (integer + group + integer → one plain run) so digit reels stay under
 * ONE parent span and keep their position-from-right identity when the value
 * grows a digit (999 → 1.000).
 */
function toSegments(parts: Intl.NumberFormatPart[]): Segment[] {
    const segments: Segment[] = [];
    for (const part of parts) {
        const kind: SegmentKind =
            part.type === "currency" ? "currency"
                : part.type === "decimal" || part.type === "fraction" ? "minor"
                    : "plain";
        const last = segments[segments.length - 1];
        if (last && last.kind === kind) last.text += part.value;
        else segments.push({ text: part.value, kind });
    }
    return segments;
}

interface RollingNumberProps {
    /** Fully formatted display string (e.g. "€1.234,56" or "1.2K"). Ignored when `parts` is set. */
    value?: string;
    /**
     * Intl.NumberFormat.formatToParts output. When set, the odometer keeps the
     * Money micro-typography: the currency symbol renders small and raised and
     * the decimals render reduced/muted, while digits still ride the reels.
     */
    parts?: Intl.NumberFormatPart[];
    className?: string;
}

/**
 * Odometer-style number display: each digit is a vertical reel of 0-9 that
 * slides to the target digit on mount and whenever the value changes;
 * non-digit characters (currency symbols, separators) render statically.
 * Reels are keyed by position-from-the-right so digits keep identity across
 * length changes (999 → 1.000). Screen readers get the plain string via
 * aria-label; the reels are aria-hidden.
 */
export function RollingNumber({ value, parts, className }: RollingNumberProps) {
    // Reels start at 0 and roll to the target after first paint.
    const [settled, setSettled] = useState(false);
    useEffect(() => {
        const raf = requestAnimationFrame(() => setSettled(true));
        return () => cancelAnimationFrame(raf);
    }, []);

    const segments: Segment[] = parts ? toSegments(parts) : [{ text: value ?? "", kind: "plain" }];
    const full = segments.map((s) => s.text).join("");

    if (prefersReducedMotion()) {
        if (!parts) {
            return <span className={cn("tabular-nums", className)}>{full}</span>;
        }
        return (
            <span className={cn("inline-flex items-baseline tabular-nums whitespace-nowrap", className)}>
                {segments.map((seg, i) => (
                    <span key={i} className={SEGMENT_CLASS[seg.kind]}>{seg.text}</span>
                ))}
            </span>
        );
    }

    const renderChars = (text: string, charsBefore: number) =>
        text.split("").map((ch, i) => {
            const keyFromRight = full.length - (charsBefore + i);
            if (!/\d/.test(ch)) {
                return (
                    <span key={`s-${keyFromRight}-${ch}`} aria-hidden="true" className="inline-block">
                        {ch}
                    </span>
                );
            }
            const digit = settled ? Number(ch) : 0;
            return (
                <span
                    key={`d-${keyFromRight}`}
                    aria-hidden="true"
                    className="inline-block h-[1em] overflow-hidden"
                >
                    <span
                        className="flex flex-col transition-transform duration-[600ms] ease-[var(--ease-out-expo)]"
                        style={{ transform: `translateY(calc(${digit} * -1em))` }}
                    >
                        {REEL.map((d) => (
                            <span key={d} className="h-[1em] leading-[1em]">
                                {d}
                            </span>
                        ))}
                    </span>
                </span>
            );
        });

    let charsBefore = 0;
    return (
        <span
            className={cn(
                "inline-flex tabular-nums leading-none",
                parts && "items-baseline whitespace-nowrap",
                className,
            )}
            aria-label={full}
            role="img"
        >
            {segments.map((seg, si) => {
                const start = charsBefore;
                charsBefore += seg.text.length;
                if (seg.kind === "plain") {
                    // No wrapper — plain runs render exactly as before so reel
                    // keys stay direct children and survive re-segmentation.
                    return renderChars(seg.text, start);
                }
                return (
                    <span key={`seg-${si}-${seg.kind}`} aria-hidden="true" className={cn("inline-flex", SEGMENT_CLASS[seg.kind])}>
                        {renderChars(seg.text, start)}
                    </span>
                );
            })}
        </span>
    );
}
