import { useCallback, useMemo } from "react";
import { useLanguage } from "@/contexts/LanguageContext";
import { useAppSettings } from "@/contexts/AppSettingsContext";
import { useCurrencyFormatter } from "@/hooks/useCurrencyFormatter";
import { numberFormatToLocale } from "@/utils/currency";
import type { MonthlyIncomeTaxDatum } from "@/hooks/useTaxOverviewData";
import { BarChart, type BarSeries } from "@/components/charts";
import {
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
} from "@/components/ui/card";
import { SectionLoader } from "@/components/shared/SectionLoader";
import { IncomeSourcesEmptyState } from "@/features/tax/IncomeSourcesEmptyState";
import { EmptyState } from "@/components/shared/EmptyState";
import { ListChecks } from "lucide-react";

interface MonthlyIncomeTaxCardProps {
    data: MonthlyIncomeTaxDatum[];
    isLoading: boolean;
    hasIncomeSources: boolean;
    viewedYear: number;
}

/** Monthly income vs PIT-reserve chart of the overview page ("incomeBreakdown" widget). */
export function MonthlyIncomeTaxCard({
    data,
    isLoading,
    hasIncomeSources,
    viewedYear,
}: MonthlyIncomeTaxCardProps) {
    const { t } = useLanguage();
    const { appSettings } = useAppSettings();
    const fmt = useCurrencyFormatter();
    const locale = numberFormatToLocale(appSettings.numberFormat);

    /**
     * Format a "YYYY-MM" period as a compact month tick. Year is shown only when it changes
     * (every January) and on the first tick so the starting year is unambiguous.
     */
    // One formatter per locale instead of one per tick (called at chart-hover rate).
    const monthTickFormatter = useMemo(
        () => new Intl.DateTimeFormat(locale, { month: "short" }),
        [locale],
    );
    const formatMonthTick = useCallback(
        (period: string, firstPeriod: string): string => {
            const [yearStr, monthStr] = period.split("-");
            const year = Number.parseInt(yearStr, 10);
            const month = Number.parseInt(monthStr, 10);
            if (Number.isNaN(year) || Number.isNaN(month)) return period;
            const monthName = monthTickFormatter.format(
                new Date(year, month - 1, 1),
            );
            const showYear = month === 1 || period === firstPeriod;
            return showYear
                ? `${monthName} ’${String(year).slice(-2)}`
                : monthName;
        },
        [monthTickFormatter],
    );

    return (
        <Card>
            <CardHeader>
                <CardTitle>{t("tax.incomeBreakdown.title")}</CardTitle>
                <CardDescription>
                    {t("tax.incomeBreakdown.description")}
                </CardDescription>
            </CardHeader>
            <CardContent>
                {isLoading ? (
                    <SectionLoader />
                ) : !hasIncomeSources ? (
                    <IncomeSourcesEmptyState viewedYear={viewedYear} />
                ) : data.length === 0 ? (
                    <EmptyState
                        headingLevel={3}
                        size="compact"
                        icon={ListChecks}
                        title={t("tax.incomeBreakdown.noData")}
                    />
                ) : (
                    <BarChart
                        data={data}
                        categoryAccessor={(d) => d.period}
                        categoryTickFormat={(label) =>
                            formatMonthTick(label, data[0]?.period ?? label)
                        }
                        height={280}
                        valueTickFormat={(v) => fmt(v)}
                        tooltipValueFormat={(v) => fmt(v)}
                        series={
                            [
                                {
                                    key: "income",
                                    label: t("tax.chart.income"),
                                    accessor: (d) => d.income,
                                    color: "hsl(var(--primary))",
                                },
                                {
                                    key: "estimatedTax",
                                    label: t("tax.chart.pitReserve"),
                                    accessor: (d) => d.estimatedTax,
                                    color: "hsl(var(--chart-5))",
                                },
                            ] as BarSeries<MonthlyIncomeTaxDatum>[]
                        }
                    />
                )}
            </CardContent>
        </Card>
    );
}
