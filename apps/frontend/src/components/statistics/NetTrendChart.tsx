import { memo } from "react";
import { AreaChart, type AreaSeries } from "@/components/charts";
import { useLanguage } from "@/contexts/LanguageContext";
import { useChartCurrencyFormatter } from "@/hooks/useChartCurrencyFormatter";
import { formatPeriodShort } from "./statisticsUtils";
import { appLanguageToLocale, formatDate, parseISO } from "@/components/shared/dateUtils";
import type { StatisticsData } from "@/hooks/useStatistics";

interface NetDatum {
  period: string;
  date: Date;
  net: number;
}

interface NetTrendChartProps {
  data: StatisticsData;
}

export const NetTrendChart = memo(function NetTrendChart({ data }: NetTrendChartProps) {
  const { t, language } = useLanguage();
  const monthLabelLocale = appLanguageToLocale(language);
  const { formatCurrency, currencySymbol } = useChartCurrencyFormatter();

  const chartData: NetDatum[] = data.monthlyData.map((m) => ({
    period: m.period,
    date: parseISO(`${m.period}-01`),
    net: Math.round(m.net),
  }));

  const series: AreaSeries<NetDatum>[] = [
    { key: "net", label: t("statsPage.net"), accessor: (d) => d.net, color: "hsl(var(--primary))" },
  ];

  return (
    <AreaChart<NetDatum>
      data={chartData}
      xAccessor={(d) => d.date}
      series={series}
      height={300}
      xTickFormat={(v) => formatDate(v as Date, "MMM yy", monthLabelLocale)}
      yTickFormat={(v) => `${currencySymbol}${(v / 1000).toFixed(0)}k`}
      tooltipTitle={(d) => formatPeriodShort(d.period, monthLabelLocale)}
      tooltipValueFormat={(v) => formatCurrency(v)}
    />
  );
});
