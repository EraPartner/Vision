import { memo } from "react";
import { BarChart, type BarSeries } from "@/components/charts";
import { useLanguage } from "@/stores/hydration/LanguageHydration";
import { useChartCurrencyFormatter } from "@/hooks/useChartCurrencyFormatter";
import type { StatisticsData } from "@/hooks/useStatistics";

interface YearlyDatum {
  year: string;
  income: number;
  spending: number;
}

interface YearlyComparisonChartProps {
  data: StatisticsData;
}

export const YearlyComparisonChart = memo(function YearlyComparisonChart({ data }: YearlyComparisonChartProps) {
  const { t } = useLanguage();
  const { formatCurrency, formatAxisCompact } = useChartCurrencyFormatter();

  const chartData: YearlyDatum[] = data.yearlyComparison.map((y) => ({
    year: y.year.toString(),
    income: Math.round(y.totalIncome),
    spending: Math.round(y.totalSpending),
  }));

  const series: BarSeries<YearlyDatum>[] = [
    { key: "income", label: t("statsPage.income"), accessor: (d) => d.income, color: "hsl(var(--gain))" },
    { key: "spending", label: t("statsPage.spending"), accessor: (d) => d.spending, color: "hsl(var(--loss))" },
  ];

  return (
    <BarChart<YearlyDatum>
      data={chartData}
      categoryAccessor={(d) => d.year}
      series={series}
      height={300}
      valueTickFormat={formatAxisCompact}
      tooltipValueFormat={(v) => formatCurrency(v)}
    />
  );
});
