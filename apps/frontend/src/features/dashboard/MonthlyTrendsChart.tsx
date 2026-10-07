import { useMemo } from "react";
import {
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
} from "@/components/ui/card";
import { BarChart, ChartLegend } from "@/components/charts";
import { useLanguage } from "@/stores/hydration/LanguageHydration";
import { useAppSettings } from "@/stores/hydration/AppSettingsHydration";
import { formatCurrency } from "@/utils/currency";
import { Money } from "@/components/shared/Money";
import { useChartCurrencyFormatter } from "@/hooks/useChartCurrencyFormatter";
import { formatMonthYearWithAppSettings } from "@/lib/dateUtils";

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
                        formatCurrency(
                            v,
                            defaultCurrency,
                            locale,
                            appSettings.showDecimalPlaces ?? 2,
                        )
                    }
                />
            </div>

            <div className="mt-6 grid grid-cols-2 gap-3">
                <div className="flex items-center gap-3 rounded-card corner-continuous bg-gain/10 p-3">
                    <span
                        aria-hidden="true"
                        className="h-2.5 w-2.5 shrink-0 rounded-full bg-gain"
                    />
                    <div className="min-w-0 flex-1">
                        <p className="type-footnote text-label-secondary">
                            {t("monthlyTrends.totalIncome")}
                        </p>
                        <p className="type-headline tabular-nums text-gain">
                            <Money
                                amount={totalIncome}
                                currency={defaultCurrency}
                            />
                        </p>
                    </div>
                </div>
                <div className="flex items-center gap-3 rounded-card corner-continuous bg-loss/10 p-3">
                    <span
                        aria-hidden="true"
                        className="h-2.5 w-2.5 shrink-0 rounded-full bg-loss"
                    />
                    <div className="min-w-0 flex-1">
                        <p className="type-footnote text-label-secondary">
                            {t("monthlyTrends.totalSpending")}
                        </p>
                        <p className="type-headline tabular-nums text-loss">
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
            <CardHeader className="space-y-3">
                <div>
                    <CardTitle variant="sm">
                        {t("monthlyTrends.title")}
                    </CardTitle>
                    <CardDescription>
                        {t("monthlyTrends.desc")}
                    </CardDescription>
                </div>
            </CardHeader>
            <CardContent>{chartContent}</CardContent>
        </Card>
    );
}
