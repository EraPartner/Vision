import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { RollingNumber } from "@/components/shared/RollingNumber";
import { DeltaPill } from "@/components/shared/DeltaPill";
import { LucideIcon } from "lucide-react";

interface StatCardProps {
    title: string;
    value: string;
    /** Raw numeric value for the count-up animation. If omitted, value is shown statically. */
    numericValue?: number;
    change?: string;
    changeType?: "positive" | "negative" | "neutral";
    subtitle?: string;
    icon: LucideIcon;
    trend?: "income" | "expense" | "up" | "down" | "neutral";
    /** Format function that turns numeric → display string (e.g. currency formatter) */
    formatValue?: (n: number) => string;
    /** Full unabbreviated value shown as tooltip when the displayed value is compact */
    titleValue?: string;
}

export function StatCard({ title, value, numericValue, change, changeType = "neutral", subtitle, icon: Icon, trend = "neutral", formatValue, titleValue }: StatCardProps) {
    const normalisedTrend = trend === "up" ? "income" : trend === "down" ? "expense" : trend;

    const trendGradient = {
        income: "from-accent/10 to-accent/5",
        expense: "from-destructive/10 to-destructive/5",
        neutral: "from-primary/10 to-primary/5",
    }[normalisedTrend] ?? "from-primary/10 to-primary/5";

    const iconBg = {
        income: "bg-gradient-to-br from-accent/20 to-accent/10 text-accent",
        expense: "bg-gradient-to-br from-destructive/20 to-destructive/10 text-destructive",
        neutral: "bg-gradient-to-br from-primary/20 to-primary/10 text-primary",
    }[normalisedTrend] ?? "bg-gradient-to-br from-primary/20 to-primary/10 text-primary";

    const displayValue = numericValue !== undefined && formatValue
        ? formatValue(numericValue)
        : value;

    return (
        <Card
            className="glass-elevated premium-frame micro-lift group relative overflow-hidden h-full">
            <div className={`absolute inset-0 pointer-events-none rounded-[inherit] bg-gradient-to-br ${trendGradient}`} />
            <div
                className="absolute top-0 right-0 w-32 h-32 bg-gradient-to-br from-background/40 to-transparent rounded-full -mr-16 -mt-16 transition-transform duration-500 group-hover:scale-110" />
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3">
                <CardTitle className="text-sm font-semibold text-muted-foreground">{title}</CardTitle>
                <div className={`h-10 w-10 rounded-xl flex items-center justify-center ${iconBg} shadow-sm`}>
                    <Icon className="h-5 w-5" />
                </div>
            </CardHeader>
            <CardContent>
                <div className="text-3xl font-bold text-foreground tabular-nums">
                    <span title={titleValue}>
                        <RollingNumber value={displayValue} />
                    </span>
                </div>
                {change && (
                    <div className="mt-2">
                        <DeltaPill
                            value={changeType === "positive" ? 1 : changeType === "negative" ? -1 : 0}
                            label={change}
                        />
                    </div>
                )}
                {!change && subtitle && (
                    <p className="text-xs text-muted-foreground mt-2">{subtitle}</p>
                )}
            </CardContent>
        </Card>
    );
}
