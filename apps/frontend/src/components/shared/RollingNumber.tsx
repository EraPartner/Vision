import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";

const REEL = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"];

function prefersReducedMotion(): boolean {
    return (
        typeof window !== "undefined" &&
        typeof window.matchMedia === "function" &&
        window.matchMedia("(prefers-reduced-motion: reduce)").matches
    );
}

interface RollingNumberProps {
    /** Fully formatted display string (e.g. "€1.234,56" or "1.2K"). */
    value: string;
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
export function RollingNumber({ value, className }: RollingNumberProps) {
    // Reels start at 0 and roll to the target after first paint.
    const [settled, setSettled] = useState(false);
    useEffect(() => {
        const raf = requestAnimationFrame(() => setSettled(true));
        return () => cancelAnimationFrame(raf);
    }, []);

    if (prefersReducedMotion()) {
        return <span className={cn("tabular-nums", className)}>{value}</span>;
    }

    const chars = value.split("");
    return (
        <span
            className={cn("inline-flex tabular-nums leading-none", className)}
            aria-label={value}
            role="img"
        >
            {chars.map((ch, i) => {
                const keyFromRight = chars.length - i;
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
            })}
        </span>
    );
}
