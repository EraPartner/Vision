import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export interface KeyValueRow {
    key: string;
    label: ReactNode;
    value: ReactNode;
    /** Colour class for the value (`text-loss`, `text-gain`, `text-primary`…). */
    tone?: string;
    /** Draws the row as a total: heavier label, separated from the rows above. */
    emphasis?: boolean;
}

interface KeyValueRowsProps {
    rows: KeyValueRow[];
    className?: string;
}

/**
 * Label/value rows inside a card, on the Portfolio page's definition-list
 * pattern: hairline dividers, footnote label, body value in tabular figures.
 */
export function KeyValueRows({ rows, className }: KeyValueRowsProps) {
    return (
        <dl className={cn("divide-y divide-border/50", className)}>
            {rows.map((row) => (
                <div
                    key={row.key}
                    className={cn(
                        "flex items-center justify-between gap-3 py-2",
                        row.emphasis && "pt-3",
                    )}
                >
                    <dt
                        className={cn(
                            row.emphasis
                                ? "type-body font-medium text-foreground"
                                : "type-footnote text-label-secondary",
                        )}
                    >
                        {row.label}
                    </dt>
                    <dd
                        className={cn(
                            "shrink-0 tabular-nums",
                            row.emphasis
                                ? "type-headline"
                                : "type-body font-medium",
                            row.tone ?? "text-foreground",
                        )}
                    >
                        {row.value}
                    </dd>
                </div>
            ))}
        </dl>
    );
}
