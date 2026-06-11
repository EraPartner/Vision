import { memo, useMemo } from "react";
import { LineChart, type LineSeries } from "@/components/charts";
import { useChartCurrencyFormatter } from "@/hooks/useChartCurrencyFormatter";
import { formatPeriodShort } from "./statisticsUtils";
import { formatDate, parseISO } from "@/components/shared/dateUtils";
import type { StatisticsData } from "@/hooks/useStatistics";

interface CategoryTrendDatum {
  period: string;
  date: Date;
  values: Record<string, number>;
}

interface CategoryTrendChartProps {
  data: StatisticsData;
}

export const CategoryTrendChart = memo(function CategoryTrendChart({ data }: CategoryTrendChartProps) {
  const { formatCurrency, currencySymbol } = useChartCurrencyFormatter();

  // "Monthly spending for top 5 categories" — rank by EXPENSE total and plot
  // expense (not Σ|net|, which let income categories like salary into the top 5).
  const topCategories = useMemo(
    () =>
      [...data.categoryPivot]
        .filter((c) => c.expenseTotal > 0)
        .sort((a, b) => b.expenseTotal - a.expenseTotal)
        .slice(0, 5),
    [data.categoryPivot],
  );

  const chartData: CategoryTrendDatum[] = useMemo(
    () =>
      data.allPeriods.map((period) => {
        const values: Record<string, number> = {};
        for (const cat of topCategories) {
          values[cat.categoryId ?? -1] = Math.round(cat.expenseMonths[period] || 0);
        }
        return { period, date: parseISO(`${period}-01`), values };
      }),
    [data.allPeriods, topCategories],
  );

  const series: LineSeries<CategoryTrendDatum>[] = useMemo(
    () =>
      topCategories.map((cat, i) => ({
        key: String(cat.categoryId ?? -1),
        label: cat.categoryName,
        accessor: (d) => d.values[cat.categoryId ?? -1] ?? 0,
        color: `hsl(var(--chart-${(i % 8) + 1}))`,
        strokeWidth: 2,
      })),
    [topCategories],
  );

  return (
    <LineChart<CategoryTrendDatum>
      data={chartData}
      xAccessor={(d) => d.date}
      series={series}
      height={350}
      xTickFormat={(v) => formatDate(v as Date, "MMM yy")}
      yTickFormat={(v) => `${currencySymbol}${(v / 1000).toFixed(0)}k`}
      tooltipTitle={(d) => formatPeriodShort(d.period)}
      tooltipValueFormat={(v) => formatCurrency(v)}
    />
  );
});
