import {Card, CardContent, CardHeader, CardTitle} from "@/components/ui/card";
import {LucideIcon} from "lucide-react";

interface StatCardProps {
    title: string;
    value: string;
    change?: string;
    changeType?: "positive" | "negative" | "neutral";
    icon: LucideIcon;
    trend?: "income" | "expense" | "neutral";
}

export function StatCard({title, value, change, changeType = "neutral", icon: Icon, trend = "neutral"}: StatCardProps) {
    const changeColor = {
        positive: "text-emerald-600 dark:text-emerald-400",
        // Use brighter rose in dark mode for better contrast
        negative: "text-rose-600 dark:text-rose-300",
        neutral: "text-muted-foreground",
    }[changeType];

    const trendGradient = {
        income: "from-emerald-500/10 to-green-500/5",
        expense: "from-rose-500/10 to-red-500/5",
        neutral: "from-blue-500/10 to-indigo-500/5",
    }[trend];

    const iconBg = {
        income: "bg-gradient-to-br from-emerald-500/20 to-green-500/20 text-emerald-600 dark:text-emerald-400",
        // brighten the text/icon in dark mode
        expense: "bg-gradient-to-br from-rose-500/20 to-red-500/20 text-rose-600 dark:text-rose-300",
        neutral: "bg-gradient-to-br from-blue-500/20 to-indigo-500/20 text-blue-600 dark:text-blue-400",
    }[trend];

    return (
        <Card
            className={`relative overflow-hidden border-none shadow-lg hover:shadow-xl transition-all duration-300 hover:-translate-y-1 bg-gradient-to-br ${trendGradient} backdrop-blur-sm`}>
            <div
                className="absolute top-0 right-0 w-32 h-32 bg-gradient-to-br from-white/50 to-transparent dark:from-white/10 rounded-full -mr-16 -mt-16"></div>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3">
                <CardTitle className="text-sm font-semibold text-slate-700 dark:text-slate-300">{title}</CardTitle>
                <div className={`h-10 w-10 rounded-xl flex items-center justify-center ${iconBg} shadow-sm`}>
                    <Icon className="h-5 w-5"/>
                </div>
            </CardHeader>
            <CardContent>
                <div
                    className="text-3xl font-bold bg-gradient-to-br from-slate-900 to-slate-700 dark:from-white dark:to-slate-300 bg-clip-text text-transparent">
                    {value}
                </div>
                {change && (
                    <p className={`text-xs font-medium ${changeColor} mt-2 flex items-center gap-1`}>
                        {changeType === "positive" && "↗"}
                        {changeType === "negative" && "↘"}
                        {change}
                    </p>
                )}
            </CardContent>
        </Card>
    );
}