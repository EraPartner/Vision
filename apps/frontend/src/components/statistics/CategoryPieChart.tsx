import { memo, useState, useMemo } from "react";
import { DonutChart, type PieDatum } from "@/components/charts";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useLanguage } from "@/contexts/LanguageContext";
import { useChartCurrencyFormatter } from "@/hooks/useChartCurrencyFormatter";
import type { StatisticsData } from "@/hooks/useStatistics";

interface CategoryPieChartProps {
  data: StatisticsData;
}

export const CategoryPieChart = memo(function CategoryPieChart({ data }: CategoryPieChartProps) {
  const [yearFilter, setYearFilter] = useState<string>("all");
  const { t } = useLanguage();
  const { formatCurrency } = useChartCurrencyFormatter();

  const filteredPeriods = useMemo(() => {
    if (yearFilter === "all") return data.allPeriods;
    return data.allPeriods.filter((period) => period.startsWith(yearFilter));
  }, [yearFilter, data.allPeriods]);

  const pieData: PieDatum[] = useMemo(() => {
    const totals = data.categoryPivot
      .map((category) => {
        // "Spending by Category" — sum EXPENSE only. Using months (Σ|net|) let
        // income categories (salary) dominate the donut and netted mixed-sign
        // months. expenseMonths holds Σ|amount<0| per period.
        const totalForPeriods = filteredPeriods.reduce(
          (sum, period) => sum + (category.expenseMonths[period] || 0),
          0
        );
        return { name: category.categoryName, value: Math.round(totalForPeriods) };
      })
      .filter((item) => item.value > 0)
      .sort((a, b) => b.value - a.value)
      .slice(0, 10);

    return totals.map((item, index) => ({
      ...item,
      color: `hsl(var(--chart-${(index % 8) + 1}))`,
    }));
  }, [data.categoryPivot, filteredPeriods]);

  return (
    <div className="space-y-3">
      <div className="flex justify-end">
        <Select value={yearFilter} onValueChange={setYearFilter}>
          <SelectTrigger className="w-[140px]">
            <SelectValue placeholder={t("statistics.selectYear")} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t("statsPage.allYears")}</SelectItem>
            {data.allYears.map((year) => (
              <SelectItem key={year} value={year.toString()}>{year}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <DonutChart
        data={pieData}
        height={350}
        innerRadiusRatio={0.55}
        tooltipValueFormat={(v) => formatCurrency(v)}
      />
    </div>
  );
});
