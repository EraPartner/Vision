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
}

export function ChartPeriodSelector<P extends string>({
    periods,
    value,
    onChange,
    labels,
    className,
    size = "md",
}: ChartPeriodSelectorProps<P>) {
    const pad = size === "sm" ? "px-2 py-1" : "px-3 py-1.5";
    return (
        <div className={cn("flex w-fit gap-1 rounded-lg bg-muted p-1", className)} role="tablist">
            {periods.map((p) => {
                const active = p === value;
                return (
                    <button
                        key={p}
                        type="button"
                        role="tab"
                        aria-selected={active}
                        onClick={() => onChange(p)}
                        className={cn(
                            "rounded-md text-xs font-medium transition-[color,background-color,box-shadow]",
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
