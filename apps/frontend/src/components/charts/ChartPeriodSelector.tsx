/**
 * ChartPeriodSelector — the time-range picker shared by every chart that
 * scopes its data to a window (Portfolio, Net worth, …). Built on the
 * SegmentedControl primitive (ADR-179) so it reads as one radio group with
 * the gliding pill, instead of a row of toggle buttons.
 */
import {
    SegmentedControl,
    SegmentedControlItem,
} from "@/components/ui/segmented-control";
import { cn } from "@/lib/utils";

export interface ChartPeriodSelectorProps<P extends string> {
    readonly periods: ReadonlyArray<P>;
    readonly value: P;
    readonly onChange: (period: P) => void;
    readonly labels: Readonly<Record<P, string>>;
    readonly className?: string;
    readonly size?: "sm" | "md";
    readonly "aria-label"?: string;
    readonly "aria-labelledby"?: string;
}

export function ChartPeriodSelector<P extends string>({
    periods,
    value,
    onChange,
    labels,
    className,
    size = "md",
    "aria-label": ariaLabel,
    "aria-labelledby": ariaLabelledBy,
}: ChartPeriodSelectorProps<P>) {
    return (
        <SegmentedControl
            value={value}
            onValueChange={(next) => onChange(next as P)}
            size={size === "sm" ? "sm" : "default"}
            aria-label={ariaLabel}
            aria-labelledby={ariaLabelledBy}
            className={cn("w-fit", className)}
        >
            {periods.map((p) => (
                <SegmentedControlItem
                    key={p}
                    value={p}
                    className={size === "sm" ? "px-2.5 type-footnote" : undefined}
                >
                    {labels[p]}
                </SegmentedControlItem>
            ))}
        </SegmentedControl>
    );
}
