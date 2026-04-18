/**
 * ChartLegend — compact legend for multi-series charts.
 */
import { cn } from "@/lib/utils";

export interface ChartLegendItem {
    readonly label: string;
    readonly color: string;
    readonly dashed?: boolean;
}

export interface ChartLegendProps {
    readonly items: ReadonlyArray<ChartLegendItem>;
    readonly className?: string;
    readonly align?: "start" | "center" | "end";
}

export function ChartLegend({ items, className, align = "start" }: ChartLegendProps) {
    const justify =
        align === "center" ? "justify-center" : align === "end" ? "justify-end" : "justify-start";

    return (
        <ul
            className={cn(
                "flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground",
                justify,
                className,
            )}
        >
            {items.map((item, idx) => (
                <li key={`${item.label}-${idx}`} className="flex items-center gap-2">
                    {item.dashed ? (
                        <span
                            className="inline-block h-[2px] w-4"
                            style={{
                                backgroundImage: `linear-gradient(to right, ${item.color} 50%, transparent 50%)`,
                                backgroundSize: "6px 2px",
                            }}
                        />
                    ) : (
                        <span
                            className="inline-block size-2.5 rounded-sm"
                            style={{ background: item.color }}
                        />
                    )}
                    <span>{item.label}</span>
                </li>
            ))}
        </ul>
    );
}
