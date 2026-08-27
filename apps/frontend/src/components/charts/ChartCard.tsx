/**
 * ChartCard — the single chrome wrapper for every chart in the app.
 *
 * Standardizes the header (title + description left, controls right),
 * the body padding, and the legend placement (below the chart) so charts read
 * as one family regardless of which primitive (Area/Bar/Line/…) they render.
 *
 * Conventions enforced here so individual pages don't re-decide them:
 *  - title sizing/typography (font-display, text-lg)
 *  - description tone + spacing
 *  - right-aligned controls slot (period selector, series toggles, …)
 *  - legend rendered with the shared ChartLegend, below the chart
 */
import * as React from "react";
import {
    Card,
    CardContent,
    CardHeader,
    CardTitle,
    CardDescription,
} from "@/components/ui/card";
import { ChartLegend, type ChartLegendItem } from "./ChartLegend";
import { cn } from "@/lib/utils";

export interface ChartCardProps {
    readonly title: React.ReactNode;
    readonly description?: React.ReactNode;
    /** Right-aligned controls (period selector, toggles). */
    readonly actions?: React.ReactNode;
    /** Legend items rendered with the shared ChartLegend, below the chart. */
    readonly legend?: ReadonlyArray<ChartLegendItem>;
    readonly legendAlign?: "start" | "center" | "end";
    readonly children: React.ReactNode;
    readonly className?: string;
    readonly headerClassName?: string;
    readonly contentClassName?: string;
    readonly titleClassName?: string;
}

export function ChartCard({
    title,
    description,
    actions,
    legend,
    legendAlign = "start",
    children,
    className,
    headerClassName,
    contentClassName,
    titleClassName,
}: ChartCardProps) {
    return (
        <Card className={className}>
            <CardHeader className={cn("pb-4", headerClassName)}>
                <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                        <CardTitle variant="sm" className={titleClassName}>
                            <span className="truncate">{title}</span>
                        </CardTitle>
                        {description ? (
                            <CardDescription className="mt-0.5">
                                {description}
                            </CardDescription>
                        ) : null}
                    </div>
                    {actions ? (
                        <div className="flex shrink-0 items-center gap-1 self-start">
                            {actions}
                        </div>
                    ) : null}
                </div>
            </CardHeader>
            <CardContent className={contentClassName}>
                {children}
                {legend && legend.length > 0 ? (
                    <ChartLegend
                        className="mt-3"
                        items={legend}
                        align={legendAlign}
                    />
                ) : null}
            </CardContent>
        </Card>
    );
}
