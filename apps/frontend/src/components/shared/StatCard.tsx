import { type ReactNode } from "react";
import { CardSheen } from "@/components/shared/CardSheen";
import { cva, type VariantProps } from "class-variance-authority";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { RollingNumber } from "@/components/shared/RollingNumber";
import { DeltaPill } from "@/components/shared/DeltaPill";
import { TrendHue, type TrendTone } from "@/components/shared/TrendHue";
import { CompactValueDisclosure } from "@/components/shared/TouchDisclosure";
import { cn } from "@/lib/utils";
import { LucideIcon } from "lucide-react";
import { Link } from "react-router";

/**
 * The app's shared stat tile. Every KPI/summary card composes this — page-specific
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

const statChipVariants = cva("flex items-center justify-center shrink-0", {
    variants: {
        size: {
            default: "h-10 w-10 rounded-xl icon-tile-glow",
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
    /** Optional drill-down destination exposed as a full-surface native link. */
    to?: string;
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
    /** Full unabbreviated value shown in a tap/click/keyboard disclosure. */
    titleValue?: string;
    /**
     * Whether string values get the odometer (digit-reel) treatment. Defaults to
     * true for numeric KPIs. Set false for arbitrary text (e.g. a recipient name)
     * so spaces aren't collapsed and letters aren't run through the digit reels.
     */
    odometer?: boolean;
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
    title,
    to,
    value,
    numericValue,
    change,
    changeType = "neutral",
    subtitle,
    icon: Icon,
    trend = "neutral",
    formatValue,
    titleValue,
    odometer = true,
    valueClassName = "text-foreground",
    size = "default",
    loading = false,
    className,
    children,
}: StatCardProps) {
    const normalisedTrend =
        trend === "up" ? "income" : trend === "down" ? "expense" : trend;

    const tone: TrendTone =
        normalisedTrend === "income"
            ? "gain"
            : normalisedTrend === "expense"
              ? "loss"
              : "neutral";

    const iconBg =
        {
            income: "bg-gradient-to-br from-gain/20 to-gain/10 text-gain",
            expense: "bg-gradient-to-br from-loss/20 to-loss/10 text-loss",
            neutral:
                "bg-gradient-to-br from-primary/20 to-primary/10 text-primary",
        }[normalisedTrend] ??
        "bg-gradient-to-br from-primary/20 to-primary/10 text-primary";

    const displayValue =
        numericValue !== undefined && formatValue
            ? formatValue(numericValue)
            : value;

    return (
        <Card
            variant="interactive"
            className={cn(
                "glass-elevated group relative overflow-hidden h-full",
                className,
            )}
        >
            {to && (
                <Link
                    to={to}
                    aria-label={title}
                    className="absolute inset-0 z-10 rounded-[inherit] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70 focus-visible:ring-offset-2"
                />
            )}
            <TrendHue tone={tone} />
            <CardSheen animated />
            <div className={cn(to && "pointer-events-none relative z-20")}>
                <CardHeader className={statHeaderVariants({ size })}>
                    <CardTitle variant="label">{title}</CardTitle>
                    {Icon && (
                        <div className={cn(statChipVariants({ size }), iconBg)}>
                            <Icon
                                className={
                                    size === "compact"
                                        ? "h-3.5 w-3.5"
                                        : "h-5 w-5"
                                }
                            />
                        </div>
                    )}
                </CardHeader>
                <CardContent className={statContentVariants({ size })}>
                    {/* aria-busy, not role="status": stat cards come in rows of
                    four that all flip to `loading` together, and one live
                    region per card would announce "Loading" four times. The
                    page's stat grid carries the useLoadingSurfaceProps()
                    props and announces
                    once for the row. */}
                    <div
                        aria-busy={loading || undefined}
                        className={cn(
                            statValueVariants({ size }),
                            valueClassName,
                        )}
                    >
                        {loading ? (
                            <Skeleton
                                className={
                                    size === "compact" ? "h-6 w-20" : "h-9 w-28"
                                }
                            />
                        ) : (
                            <CompactValueDisclosure
                                fullValue={titleValue}
                                className={
                                    to ? "pointer-events-auto" : undefined
                                }
                                display={
                                    typeof displayValue === "string" &&
                                    odometer ? (
                                        <RollingNumber value={displayValue} />
                                    ) : (
                                        displayValue
                                    )
                                }
                            />
                        )}
                    </div>
                    {change && (
                        <div className={size === "compact" ? "mt-1" : "mt-2"}>
                            <DeltaPill
                                value={
                                    changeType === "positive"
                                        ? 1
                                        : changeType === "negative"
                                          ? -1
                                          : 0
                                }
                                label={change}
                            />
                        </div>
                    )}
                    {subtitle && (
                        <p
                            className={cn(
                                "text-xs text-muted-foreground",
                                size === "compact" ? "mt-0.5" : "mt-2",
                            )}
                        >
                            {subtitle}
                        </p>
                    )}
                    {children}
                </CardContent>
            </div>
        </Card>
    );
}
