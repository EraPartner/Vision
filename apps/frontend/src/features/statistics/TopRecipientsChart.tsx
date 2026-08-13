import { memo, useState } from "react";
import { BarChart, type BarSeries } from "@/components/charts";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useLanguage } from "@/contexts/LanguageContext";
import { useChartCurrencyFormatter } from "@/hooks/useChartCurrencyFormatter";
import type { StatisticsData } from "@/hooks/useStatistics";

interface RecipientDatum {
  name: string;
  fullName: string;
  amount: number;
  count: number;
}

interface TopRecipientsChartProps {
  data: StatisticsData;
}

export const TopRecipientsChart = memo(function TopRecipientsChart({ data }: TopRecipientsChartProps) {
  const { t } = useLanguage();
  const { formatCurrency, currencySymbol } = useChartCurrencyFormatter();
  const [yearFilter, setYearFilter] = useState<string>("all");

  const filteredRecipients =
    yearFilter === "all" ? data.topRecipients : (data.topRecipientsByYear[yearFilter] || []);

  const chartData: RecipientDatum[] = filteredRecipients.slice(0, 10).map((r) => ({
    name: r.name.length > 20 ? r.name.substring(0, 20) + "…" : r.name,
    fullName: r.name,
    amount: Math.round(r.total),
    count: r.count,
  }));

  const series: BarSeries<RecipientDatum>[] = [
    { key: "amount", label: t("statsPage.spending"), accessor: (d) => d.amount },
  ];

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
      <BarChart<RecipientDatum>
        data={chartData}
        categoryAccessor={(d) => d.name}
        series={series}
        layout="horizontal"
        height={350}
        margin={{ top: 16, right: 32, bottom: 28, left: 160 }}
        valueTickFormat={(v) => `${currencySymbol}${(v / 1000).toFixed(0)}k`}
        tooltipTitle={(d) => d.fullName}
        tooltipValueFormat={(v) => formatCurrency(v)}
        colorForIndex={(i) => `hsl(var(--chart-${(i % 8) + 1}))`}
      />
    </div>
  );
});
