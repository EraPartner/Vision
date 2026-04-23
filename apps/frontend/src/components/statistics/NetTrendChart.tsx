import { AreaChart, type AreaSeries } from "@/components/charts";
import { useLanguage } from "@/contexts/LanguageContext";
import { useChartCurrencyFormatter } from "@/hooks/useChartCurrencyFormatter";
import { formatPeriodShort } from "./statisticsUtils";
import { format, parseISO } from "date-fns";
import type { StatisticsData } from "@/hooks/useStatistics";

interface NetDatum {
  period: string;
  date: Date;
  net: number;
}

interface NetTrendChartProps {
  data: StatisticsData;
}

export function NetTrendChart({ data }: NetTrendChartProps) {
  const { t } = useLanguage();
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
      xTickFormat={(v) => format(v as Date, "MMM yy")}
      yTickFormat={(v) => `${currencySymbol}${(v / 1000).toFixed(0)}k`}
      tooltipTitle={(d) => formatPeriodShort(d.period)}
      tooltipValueFormat={(v) => formatCurrency(v)}
    />
  );
}
