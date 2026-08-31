import { memo, useMemo } from "react";
import { LineChart, type LineSeries } from "@/components/charts";
import { useChartCurrencyFormatter } from "@/hooks/useChartCurrencyFormatter";
import { formatPeriodShort } from "./statisticsUtils";
import { appLanguageToLocale, CHART_DATE_PATTERNS, formatDate, parseISO } from "@/lib/dateUtils";
import { useLanguage } from "@/contexts/LanguageContext";
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
  const { language } = useLanguage();
  const monthLabelLocale = appLanguageToLocale(language);
  const { formatCurrency, formatAxisCompact } = useChartCurrencyFormatter();

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
      xTickFormat={(v) => formatDate(v as Date, CHART_DATE_PATTERNS.monthTick, monthLabelLocale)}
      yTickFormat={formatAxisCompact}
      tooltipTitle={(d) => formatPeriodShort(d.period, monthLabelLocale)}
      tooltipValueFormat={(v) => formatCurrency(v)}
    />
  );
});
