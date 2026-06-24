import { useCallback, useMemo } from "react";
import {
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
} from "@/components/ui/card";
import { TrendingUp } from "lucide-react";
import { BarChart, ChartLegend } from "@/components/charts";
import { useLanguage } from "@/contexts/LanguageContext";
import { useAppSettings } from "@/contexts/AppSettingsContext";
import { formatCurrency, numberFormatToLocale } from "@/utils/currency";
import { formatMonthYearWithAppSettings } from "@/components/shared/dateUtils";

interface MonthlyTrendsRow {
    readonly month: number;
    readonly year: number;
    readonly period_start: string;
    readonly period_end: string;
    readonly total_spending: number;
    readonly total_income: number;
    readonly net_amount: number;
    readonly transaction_count: number;
}

interface MonthlyTrendsChartProps {
    readonly data: ReadonlyArray<MonthlyTrendsRow>;
    readonly embedded?: boolean;
}

interface ChartRow {
    readonly month: string;
    readonly income: number;
    readonly spending: number;
}

export function MonthlyTrendsChart({ data, embedded = false }: MonthlyTrendsChartProps) {
    const { t } = useLanguage();
    const { appSettings } = useAppSettings();
    const locale = numberFormatToLocale(appSettings.numberFormat);
    const defaultCurrency = appSettings.defaultCurrency || "EUR";

    const compactFormat = useMemo(
        () =>
            new Intl.NumberFormat(locale, {
                style: "currency",
                currency: defaultCurrency,
                notation: "compact",
                maximumFractionDigits: 1,
            }),
        [locale, defaultCurrency],
    );
    const formatCompactCurrency = useCallback(
        (value: number) => compactFormat.format(value),
        [compactFormat],
    );

    const chartData: ReadonlyArray<ChartRow> = useMemo(
        () =>
            data.map((monthData) => {
                const date = new Date(monthData.year, monthData.month - 1, 1);
                return {
                    month: formatMonthYearWithAppSettings(date, appSettings.dateFormat, locale),
                    income: monthData.total_income,
                    spending: Math.abs(monthData.total_spending),
                };
            }),
        [data, appSettings.dateFormat, locale],
    );

    const { totalIncome, totalSpending } = useMemo(() => {
        let income = 0;
        let spending = 0;
        for (const m of data) {
            income += m.total_income;
            spending += m.total_spending;
        }
        return { totalIncome: income, totalSpending: Math.abs(spending) };
    }, [data]);

    const incomeColor = "hsl(var(--accent))";
    const spendingColor = "hsl(var(--destructive))";

    const chartContent = (
        <>
            <div className="flex flex-col gap-2">
                <ChartLegend
                    items={[
                        { label: t("monthlyTrends.income"), color: incomeColor },
                        { label: t("monthlyTrends.spending"), color: spendingColor },
                    ]}
                    align="start"
                />
                <BarChart<ChartRow>
                    data={chartData}
                    categoryAccessor={(d) => d.month}
                    series={[
                        {
                            key: "income",
                            label: t("monthlyTrends.income"),
                            accessor: (d) => d.income,
                            color: incomeColor,
                        },
                        {
                            key: "spending",
                            label: t("monthlyTrends.spending"),
                            accessor: (d) => d.spending,
                            color: spendingColor,
                        },
                    ]}
                    height={320}
                    barRadius={8}
                    maxBarSize={40}
                    valueTickFormat={formatCompactCurrency}
                    tooltipValueFormat={(v) => formatCurrency(v, defaultCurrency, locale)}
                />
            </div>

            <div className="mt-6 grid grid-cols-2 gap-3">
                <div className="flex items-center gap-2 p-3 rounded-lg bg-accent/10 border border-accent/30">
                    <div className="w-3 h-3 rounded-full flex-shrink-0 bg-accent"></div>
                    <div className="flex-1 min-w-0">
                        <p className="text-xs font-medium text-accent">
                            {t("monthlyTrends.totalIncome")}
                        </p>
                        <p className="text-sm font-bold text-accent">
                            {formatCurrency(totalIncome, defaultCurrency, locale)}
                        </p>
                    </div>
                </div>
                <div className="flex items-center gap-2 p-3 rounded-lg bg-destructive/10 border border-destructive/30">
                    <div className="w-3 h-3 rounded-full flex-shrink-0 bg-destructive"></div>
                    <div className="flex-1 min-w-0">
                        <p className="text-xs font-medium text-destructive">
                            {t("monthlyTrends.totalSpending")}
                        </p>
                        <p className="text-sm font-bold text-destructive">
                            {formatCurrency(totalSpending, defaultCurrency, locale)}
                        </p>
                    </div>
                </div>
            </div>
        </>
    );

    if (embedded) {
        return chartContent;
    }

    return (
        <Card className="relative overflow-hidden glass-regular premium-frame micro-lift">
            <div className="absolute top-0 right-0 w-32 h-32 bg-gradient-to-br from-white/50 to-transparent dark:from-white/10 rounded-full -mr-16 -mt-16"></div>
            <CardHeader className="space-y-3">
                <div className="flex items-center gap-3">
                    <div className="h-12 w-12 rounded-xl bg-gradient-to-br from-primary/20 to-primary/5 flex items-center justify-center shadow-[0_2px_8px_-2px_hsl(var(--primary)/0.25)] text-primary">
                        <TrendingUp className="h-6 w-6" />
                    </div>
                    <div className="flex-1">
                        <CardTitle className="text-xl">{t("monthlyTrends.title")}</CardTitle>
                        <CardDescription className="text-base">
                            {t("monthlyTrends.desc")}
                        </CardDescription>
                    </div>
                </div>
            </CardHeader>
            <CardContent>{chartContent}</CardContent>
        </Card>
    );
}
