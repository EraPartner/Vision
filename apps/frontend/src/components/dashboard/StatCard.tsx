import { type ReactNode } from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { CardSheen } from "@/components/shared/CardSheen";
import { RollingNumber } from "@/components/shared/RollingNumber";
import { DeltaPill } from "@/components/shared/DeltaPill";
import { TrendHue, type TrendTone } from "@/components/shared/TrendHue";
import { cn } from "@/lib/utils";
import { LucideIcon } from "lucide-react";

/**
 * The app's ONE stat tile. Every KPI/summary card composes this — page-specific
 * content, shared anatomy (title + trend-toned icon chip, odometer value,
 * DeltaPill / hint line). `size="compact"` is the dense 4-6-up summary rows on
 * the portfolio asset pages; the default size is the dashboard/overview tile.
 */

const statHeaderVariants = cva(
    "flex flex-row items-center justify-between space-y-0",
    {
        variants: {
            size: {
                default: "pb-3",
                compact: "pb-1 pt-3 px-4",
            },
        },
        defaultVariants: { size: "default" },
    },
);

const statTitleVariants = cva("text-muted-foreground", {
    variants: {
        size: {
            default: "text-sm font-semibold",
            compact: "text-xs font-medium",
        },
    },
    defaultVariants: { size: "default" },
});

const statChipVariants = cva("flex items-center justify-center shrink-0", {
    variants: {
        size: {
            default: "h-10 w-10 rounded-xl shadow-[0_2px_8px_-2px_hsl(var(--primary)/0.25)]",
            compact: "h-6 w-6 rounded-md",
        },
    },
    defaultVariants: { size: "default" },
});

const statContentVariants = cva("", {
    variants: {
        size: {
            default: "",
            compact: "pb-3 px-4",
        },
    },
    defaultVariants: { size: "default" },
});

const statValueVariants = cva("font-bold tabular-nums", {
    variants: {
        size: {
            default: "text-3xl",
            compact: "text-xl",
        },
    },
    defaultVariants: { size: "default" },
});

type StatCardSize = NonNullable<VariantProps<typeof statValueVariants>["size"]>;

interface StatCardProps {
    title: string;
    /** Formatted display value. Strings get the odometer treatment; nodes (e.g. <Money/>) render as-is. */
    value?: ReactNode;
    /** Raw numeric value for the count-up animation. If omitted, value is shown statically. */
    numericValue?: number;
    change?: string;
    changeType?: "positive" | "negative" | "neutral";
    /** Hint line under the value (rendered after the change pill when both are set). */
    subtitle?: ReactNode;
    icon?: LucideIcon;
    trend?: "income" | "expense" | "up" | "down" | "neutral";
    /** Format function that turns numeric → display string (e.g. currency formatter) */
    formatValue?: (n: number) => string;
    /** Full unabbreviated value shown as tooltip when the displayed value is compact */
    titleValue?: string;
    /** Override the headline value colour (e.g. "text-primary" for a featured total). Defaults to neutral foreground. */
    valueClassName?: string;
    size?: StatCardSize;
    /** Render a skeleton in the value slot while the data is still loading. */
    loading?: boolean;
    className?: string;
    /** Extra content below the value block (secondary pill rows etc.). */
    children?: ReactNode;
}

export function StatCard({
    title, value, numericValue, change, changeType = "neutral", subtitle,
    icon: Icon, trend = "neutral", formatValue, titleValue,
    valueClassName = "text-foreground", size = "default", loading = false,
    className, children,
}: StatCardProps) {
    const normalisedTrend = trend === "up" ? "income" : trend === "down" ? "expense" : trend;

    const tone: TrendTone = normalisedTrend === "income" ? "gain" : normalisedTrend === "expense" ? "loss" : "neutral";

    const iconBg = {
        income: "bg-gradient-to-br from-gain/20 to-gain/10 text-gain",
        expense: "bg-gradient-to-br from-loss/20 to-loss/10 text-loss",
        neutral: "bg-gradient-to-br from-primary/20 to-primary/10 text-primary",
    }[normalisedTrend] ?? "bg-gradient-to-br from-primary/20 to-primary/10 text-primary";

    const displayValue = numericValue !== undefined && formatValue
        ? formatValue(numericValue)
        : value;

    return (
        <Card variant="interactive" className={cn("glass-elevated group relative overflow-hidden h-full", className)}>
            <TrendHue tone={tone} />
            <CardSheen animated />
            <CardHeader className={statHeaderVariants({ size })}>
                <CardTitle className={statTitleVariants({ size })}>{title}</CardTitle>
                {Icon && (
                    <div className={cn(statChipVariants({ size }), iconBg)}>
                        <Icon className={size === "compact" ? "h-3.5 w-3.5" : "h-5 w-5"} />
                    </div>
                )}
            </CardHeader>
            <CardContent className={statContentVariants({ size })}>
                <div className={cn(statValueVariants({ size }), valueClassName)}>
                    {loading ? (
                        <Skeleton className={size === "compact" ? "h-6 w-20" : "h-9 w-28"} />
                    ) : typeof displayValue === "string" ? (
                        <span title={titleValue}>
                            <RollingNumber value={displayValue} />
                        </span>
                    ) : (
                        <span title={titleValue}>{displayValue}</span>
                    )}
                </div>
                {change && (
                    <div className={size === "compact" ? "mt-1" : "mt-2"}>
                        <DeltaPill
                            value={changeType === "positive" ? 1 : changeType === "negative" ? -1 : 0}
                            label={change}
                        />
                    </div>
                )}
                {subtitle && (
                    <p className={cn("text-xs text-muted-foreground", size === "compact" ? "mt-0.5" : "mt-2")}>{subtitle}</p>
                )}
                {children}
            </CardContent>
        </Card>
    );
}
