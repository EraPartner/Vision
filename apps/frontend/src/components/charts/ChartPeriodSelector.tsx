/**
 * ChartPeriodSelector — segmented time-range control shared by every chart that
 * scopes its data to a window (Performance, Net Worth, …). One look, one feel.
 */
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
    const pad = size === "sm" ? "px-2 py-1" : "px-3 py-1.5";
    return (
        <div
            role="group"
            aria-label={ariaLabel}
            aria-labelledby={ariaLabelledBy}
            className={cn(
                "flex w-fit max-w-full gap-1 overflow-x-auto rounded-lg bg-muted p-1",
                className,
            )}
        >
            {periods.map((p) => {
                const active = p === value;
                return (
                    <button
                        key={p}
                        type="button"
                        aria-pressed={active}
                        onClick={() => onChange(p)}
                        className={cn(
                            "relative min-h-10 min-w-10 shrink-0 rounded-md text-xs font-medium transition-[color,background-color,box-shadow]",
                            pad,
                            active
                                ? "bg-background text-foreground shadow-sm"
                                : "text-muted-foreground hover:text-foreground",
                        )}
                    >
                        {labels[p]}
                    </button>
                );
            })}
        </div>
    );
}
