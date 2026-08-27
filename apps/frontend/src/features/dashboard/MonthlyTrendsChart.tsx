import { useMemo } from "react";
import { CardSheen } from "@/components/shared/CardSheen";
import {
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
} from "@/components/ui/card";
import { BarChart, ChartLegend } from "@/components/charts";
import { useLanguage } from "@/contexts/LanguageContext";
import { useAppSettings } from "@/contexts/AppSettingsContext";
import { formatCurrency } from "@/utils/currency";
import { Money } from "@/components/shared/Money";
import { useChartCurrencyFormatter } from "@/hooks/useChartCurrencyFormatter";
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

export function MonthlyTrendsChart({
    data,
    embedded = false,
}: MonthlyTrendsChartProps) {
    const { t } = useLanguage();
    const { appSettings } = useAppSettings();
    // Shared chart formatter (SIMP-67): locale/currency resolution and the
    // length-aware compact tick format come from useChartCurrencyFormatter.
    const {
        formatCompact,
        locale,
        currency: defaultCurrency,
    } = useChartCurrencyFormatter();

    const chartData: ReadonlyArray<ChartRow> = useMemo(
        () =>
            data.map((monthData) => {
                const date = new Date(monthData.year, monthData.month - 1, 1);
                return {
                    month: formatMonthYearWithAppSettings(
                        date,
                        appSettings.dateFormat,
                        locale,
                    ),
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

    const incomeColor = "hsl(var(--gain))";
    const spendingColor = "hsl(var(--loss))";

    const chartContent = (
        <>
            <div className="flex flex-col gap-2">
                <ChartLegend
                    items={[
                        {
                            label: t("monthlyTrends.income"),
                            color: incomeColor,
                        },
                        {
                            label: t("monthlyTrends.spending"),
                            color: spendingColor,
                        },
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
                    valueTickFormat={(v) => formatCompact(v).display}
                    tooltipValueFormat={(v) =>
                        formatCurrency(v, defaultCurrency, locale)
                    }
                />
            </div>

            <div className="mt-6 grid grid-cols-2 gap-3">
                <div className="flex items-center gap-2 p-3 rounded-lg bg-gain/10 border border-gain/30">
                    <div className="w-3 h-3 rounded-full flex-shrink-0 bg-gain"></div>
                    <div className="flex-1 min-w-0">
                        <p className="text-xs font-medium text-gain">
                            {t("monthlyTrends.totalIncome")}
                        </p>
                        <p className="text-sm font-bold text-gain">
                            <Money
                                amount={totalIncome}
                                currency={defaultCurrency}
                            />
                        </p>
                    </div>
                </div>
                <div className="flex items-center gap-2 p-3 rounded-lg bg-loss/10 border border-loss/30">
                    <div className="w-3 h-3 rounded-full flex-shrink-0 bg-loss"></div>
                    <div className="flex-1 min-w-0">
                        <p className="text-xs font-medium text-loss">
                            {t("monthlyTrends.totalSpending")}
                        </p>
                        <p className="text-sm font-bold text-loss">
                            <Money
                                amount={totalSpending}
                                currency={defaultCurrency}
                            />
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
        <Card className="relative overflow-hidden">
            <CardSheen />
            <CardHeader className="space-y-3">
                <div>
                    <CardTitle variant="sm">
                        {t("monthlyTrends.title")}
                    </CardTitle>
                    <CardDescription className="text-base">
                        {t("monthlyTrends.desc")}
                    </CardDescription>
                </div>
            </CardHeader>
            <CardContent>{chartContent}</CardContent>
        </Card>
    );
}
