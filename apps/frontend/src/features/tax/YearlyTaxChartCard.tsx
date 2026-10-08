import { Info, ListChecks } from "lucide-react";
import { useLanguage } from "@/stores/hydration/LanguageHydration";
import { useCurrencyFormatter } from "@/hooks/useCurrencyFormatter";
import type { YearlyIncomeDatum } from "@/hooks/useTaxOverviewData";
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

interface YearlyTaxChartCardProps {
    data: YearlyIncomeDatum[];
    isLoading: boolean;
    hasIncomeSources: boolean;
    viewedYear: number;
}

/** Yearly net-vs-income-tax chart of the overview page ("yearlyOverview" widget). */
export function YearlyTaxChartCard({
    data,
    isLoading,
    hasIncomeSources,
    viewedYear,
}: YearlyTaxChartCardProps) {
    const { t } = useLanguage();
    const fmt = useCurrencyFormatter();

    return (
        <Card>
            <CardHeader>
                <CardTitle>{t("tax.yearly.title")}</CardTitle>
                <CardDescription>{t("tax.yearly.description")}</CardDescription>
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
                    <>
                        <BarChart
                            data={data}
                            categoryAccessor={(d) => d.year}
                            height={300}
                            valueTickFormat={(v) => fmt(v)}
                            tooltipValueFormat={(v) => fmt(v)}
                            series={
                                [
                                    {
                                        key: "netAfterTax",
                                        label: t("tax.chart.netAfterTax"),
                                        accessor: (d) => d.netAfterTax,
                                        color: "hsl(var(--primary))",
                                    },
                                    {
                                        key: "estimatedTax",
                                        label: t("tax.chart.pit"),
                                        accessor: (d) => d.estimatedTax,
                                        color: "hsl(var(--chart-5))",
                                    },
                                ] as BarSeries<YearlyIncomeDatum>[]
                            }
                        />
                        {data.some((y) => y.isApproximated) && (
                            <p className="mt-3 flex items-start gap-1.5 type-footnote text-label-secondary">
                                <Info
                                    className="mt-0.5 h-3.5 w-3.5 shrink-0"
                                    aria-hidden="true"
                                />
                                {t("tax.yearly.approximatedNote")}
                            </p>
                        )}
                    </>
                )}
            </CardContent>
        </Card>
    );
}
