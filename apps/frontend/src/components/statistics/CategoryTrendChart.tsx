import { LineChart, type LineSeries } from "@/components/charts";
import { useChartCurrencyFormatter } from "@/hooks/useChartCurrencyFormatter";
import { formatPeriodShort } from "./statisticsUtils";
import { format, parseISO } from "date-fns";
import type { StatisticsData } from "@/hooks/useStatistics";

interface CategoryTrendDatum {
  period: string;
  date: Date;
  values: Record<string, number>;
}

interface CategoryTrendChartProps {
  data: StatisticsData;
}

export function CategoryTrendChart({ data }: CategoryTrendChartProps) {
  const { formatCurrency, currencySymbol } = useChartCurrencyFormatter();

  const topCategories = data.categoryPivot.slice(0, 5);

  const chartData: CategoryTrendDatum[] = data.allPeriods.map((period) => {
    const values: Record<string, number> = {};
    for (const cat of topCategories) {
      values[cat.categoryId] = Math.round(cat.months[period] || 0);
    }
    return { period, date: parseISO(`${period}-01`), values };
  });

  const series: LineSeries<CategoryTrendDatum>[] = topCategories.map((cat, i) => ({
    key: cat.categoryId,
    label: cat.categoryName,
    accessor: (d) => d.values[cat.categoryId] ?? 0,
    color: `hsl(var(--chart-${(i % 8) + 1}))`,
    strokeWidth: 2,
  }));

  return (
    <LineChart<CategoryTrendDatum>
      data={chartData}
      xAccessor={(d) => d.date}
      series={series}
      height={350}
      xTickFormat={(v) => format(v as Date, "MMM yy")}
      yTickFormat={(v) => `${currencySymbol}${(v / 1000).toFixed(0)}k`}
      tooltipTitle={(d) => formatPeriodShort(d.period)}
      tooltipValueFormat={(v) => formatCurrency(v)}
    />
  );
}
