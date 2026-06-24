import { ArrowDownRight, ArrowRight, ArrowUpRight } from "lucide-react";
import { cn } from "@/lib/utils";

interface DeltaPillProps {
    /** Signed numeric delta; sign decides tint + arrow direction. */
    value: number;
    /** Pre-formatted display text (e.g. "+3,2 %", "−€120"). */
    label: string;
    /** Invert semantics (e.g. spending: down = good). */
    invert?: boolean;
    className?: string;
}

/**
 * Standardized change chip: tinted translucent pill + direction arrow.
 * Replaces ad-hoc colored delta text so every +/− reads the same way.
 */
export function DeltaPill({ value, label, invert = false, className }: DeltaPillProps) {
    const direction = value > 0 ? "up" : value < 0 ? "down" : "flat";
    const positive = invert ? value < 0 : value > 0;
    const negative = invert ? value > 0 : value < 0;

    const Icon = direction === "up" ? ArrowUpRight : direction === "down" ? ArrowDownRight : ArrowRight;
    const tone = positive
        ? "bg-gain/12 text-gain ring-gain/25"
        : negative
            ? "bg-loss/12 text-loss ring-loss/25"
            : "bg-muted-foreground/10 text-muted-foreground ring-border/40";

    return (
        <span
            className={cn(
                "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium tabular-nums ring-1 ring-inset",
                tone,
                className,
            )}
        >
            <Icon aria-hidden="true" className="h-3 w-3" />
            {label}
        </span>
    );
}
