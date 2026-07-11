import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { CardSheen } from "@/components/shared/CardSheen";
import { RollingNumber } from "@/components/shared/RollingNumber";
import { DeltaPill } from "@/components/shared/DeltaPill";
import { TrendHue, type TrendTone } from "@/components/shared/TrendHue";
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
    /** Override the headline value colour (e.g. "text-primary" for a featured total). Defaults to neutral foreground. */
    valueClassName?: string;
}

export function StatCard({ title, value, numericValue, change, changeType = "neutral", subtitle, icon: Icon, trend = "neutral", formatValue, titleValue, valueClassName = "text-foreground" }: StatCardProps) {
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
        <Card
            variant="interactive"
            className="glass-elevated group overflow-hidden h-full">
            <TrendHue tone={tone} />
            <CardSheen animated />
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3">
                <CardTitle className="text-sm font-semibold text-muted-foreground">{title}</CardTitle>
                <div className={`h-10 w-10 rounded-xl flex items-center justify-center ${iconBg} shadow-[0_2px_8px_-2px_hsl(var(--primary)/0.25)]`}>
                    <Icon className="h-5 w-5" />
                </div>
            </CardHeader>
            <CardContent>
                <div className={`text-3xl font-bold tabular-nums ${valueClassName}`}>
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
