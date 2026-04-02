import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { LucideIcon } from "lucide-react";

interface StatCardProps {
    title: string;
    value: string;
    change?: string;
    changeType?: "positive" | "negative" | "neutral";
    subtitle?: string;
    icon: LucideIcon;
    trend?: "income" | "expense" | "up" | "down" | "neutral";
}

export function StatCard({ title, value, change, changeType = "neutral", subtitle, icon: Icon, trend = "neutral" }: StatCardProps) {
    const changeColor = {
        positive: "text-accent dark:text-accent",
        negative: "text-destructive dark:text-destructive",
        neutral: "text-muted-foreground",
    }[changeType];

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

    return (
        <Card
            className={`group relative overflow-hidden border-none shadow-lg hover:shadow-xl transition-all duration-300 hover:-translate-y-0.5 bg-gradient-to-br ${trendGradient} backdrop-blur-sm`}>
            <div
                className="absolute top-0 right-0 w-32 h-32 bg-gradient-to-br from-background/40 to-transparent rounded-full -mr-16 -mt-16 transition-transform duration-500 group-hover:scale-110" />
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3">
                <CardTitle className="text-sm font-semibold text-muted-foreground">{title}</CardTitle>
                <div className={`h-10 w-10 rounded-xl flex items-center justify-center ${iconBg} shadow-sm transition-transform duration-300 group-hover:scale-105`}>
                    <Icon className="h-5 w-5" />
                </div>
            </CardHeader>
            <CardContent>
                <div className="text-3xl font-bold text-foreground">
                    {value}
                </div>
                {change && (
                    <p className={`text-xs font-medium ${changeColor} mt-2 flex items-center gap-1`}>
                        {changeType === "positive" && "↗"}
                        {changeType === "negative" && "↘"}
                        {change}
                    </p>
                )}
                {!change && subtitle && (
                    <p className="text-xs text-muted-foreground mt-2">{subtitle}</p>
                )}
            </CardContent>
        </Card>
    );
}
