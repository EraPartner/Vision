import { BarChart, type BarSeries } from "@/components/charts";
import { useLanguage } from "@/contexts/LanguageContext";
import { useChartCurrencyFormatter } from "@/hooks/useChartCurrencyFormatter";
import { formatPeriodShort } from "./statisticsUtils";
import type { StatisticsData } from "@/hooks/useStatistics";

interface IncomeSpendingDatum {
  period: string;
  income: number;
  spending: number;
}

interface MonthlyChartProps {
  data: StatisticsData;
}

export function MonthlyChart({ data }: MonthlyChartProps) {
  const { t } = useLanguage();
  const { formatCurrency, currencySymbol } = useChartCurrencyFormatter();

  const chartData: IncomeSpendingDatum[] = data.monthlyData.map((m) => ({
    period: formatPeriodShort(m.period),
    income: Math.round(m.income),
    spending: Math.round(m.spending),
  }));

  const series: BarSeries<IncomeSpendingDatum>[] = [
    { key: "income", label: t("statsPage.income"), accessor: (d) => d.income, color: "hsl(var(--primary))" },
    { key: "spending", label: t("statsPage.spending"), accessor: (d) => d.spending, color: "hsl(var(--destructive))" },
  ];

  return (
    <BarChart<IncomeSpendingDatum>
      data={chartData}
      categoryAccessor={(d) => d.period}
      series={series}
      height={350}
      valueTickFormat={(v) => `${currencySymbol}${(v / 1000).toFixed(0)}k`}
      tooltipValueFormat={(v) => formatCurrency(v)}
    />
  );
}
