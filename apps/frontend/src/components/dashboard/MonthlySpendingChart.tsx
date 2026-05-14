import { useCallback, useMemo } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { BarChart, ChartLegend } from "@/components/charts";
import { useLanguage } from "@/contexts/LanguageContext";
import { useAppSettings } from "@/contexts/AppSettingsContext";
import { formatCurrency, numberFormatToLocale } from "@/utils/currency";

interface MonthlySpendingRow {
    readonly month: string;
    readonly spending: number;
    readonly income: number;
}

interface MonthlySpendingChartProps {
    readonly data: Array<MonthlySpendingRow>;
}

export function MonthlySpendingChart({ data }: MonthlySpendingChartProps) {
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

    if (!data || data.length === 0) {
        return (
            <Card>
                <CardHeader>
                    <CardTitle className="text-lg font-semibold">
                        {t("monthlySpending.title")}
                    </CardTitle>
                    <p className="text-sm text-muted-foreground">
                        {t("monthlySpending.desc")}
                    </p>
                </CardHeader>
                <CardContent>
                    <div className="flex h-72 items-center justify-center text-muted-foreground">
                        {t("monthlySpending.noData")}
                    </div>
                </CardContent>
            </Card>
        );
    }

    const spendingColor = "hsl(var(--destructive))";
    const incomeColor = "hsl(var(--accent))";

    return (
        <Card>
            <CardHeader>
                <CardTitle className="text-lg font-semibold">
                    {t("monthlySpending.title")}
                </CardTitle>
                <p className="text-sm text-muted-foreground">
                    {t("monthlySpending.desc")}
                </p>
            </CardHeader>
            <CardContent>
                <div className="flex h-72 flex-col gap-2">
                    <BarChart<MonthlySpendingRow>
                        data={data}
                        categoryAccessor={(d) => d.month}
                        series={[
                            {
                                key: "spending",
                                label: t("monthlySpending.spending"),
                                accessor: (d) => d.spending,
                                color: spendingColor,
                            },
                            {
                                key: "income",
                                label: t("monthlySpending.income"),
                                accessor: (d) => d.income,
                                color: incomeColor,
                            },
                        ]}
                        height={232}
                        maxBarSize={40}
                        valueTickFormat={formatCompactCurrency}
                        tooltipValueFormat={(v) =>
                            formatCurrency(v, defaultCurrency, locale)
                        }
                    />
                    <ChartLegend
                        items={[
                            {
                                label: t("monthlySpending.spending"),
                                color: spendingColor,
                            },
                            { label: t("monthlySpending.income"), color: incomeColor },
                        ]}
                        align="center"
                    />
                </div>
            </CardContent>
        </Card>
    );
}
