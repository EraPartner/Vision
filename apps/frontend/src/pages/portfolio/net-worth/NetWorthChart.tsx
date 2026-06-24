import { useMemo } from "react";
import { Wallet } from "lucide-react";
import {
  AreaChart as VisxAreaChart,
  ChartCard,
  ChartPeriodSelector,
  type AreaSeries,
  type ChartLegendItem,
  type ChartPeriod,
} from "@/components/charts";
import { parseLocalDateFromYmd } from "@/components/shared/dateUtils";
import { NetWorthSnapshot, normalizeYmd } from "./netWorthChartUtils";

interface NetWorthChartProps {
  snapshots: NetWorthSnapshot[];
  period: ChartPeriod;
  periods: ReadonlyArray<ChartPeriod>;
  periodLabels: Record<ChartPeriod, string>;
  onPeriodChange: (period: ChartPeriod) => void;
  fmt: (val: number) => string;
  xTickFormat: (value: Date) => string;
  tooltipLabelFormatter: (v: string) => string;
  t: (key: string) => string;
}

const TOTAL_COLOR = 'hsl(var(--primary))';
const LIQUID_COLOR = 'hsl(var(--chart-2))';
const INVESTMENTS_COLOR = 'hsl(var(--chart-4))';
const LIABILITIES_COLOR = 'hsl(var(--loss))';

export function NetWorthChart({
  snapshots,
  period,
  periods,
  periodLabels,
  onPeriodChange,
  fmt,
  xTickFormat,
  tooltipLabelFormatter,
  t,
}: NetWorthChartProps) {
  // Only plot the liabilities line when there is debt to show, so debt-free
  // portfolios keep the original three-line chart.
  const hasLiabilities = useMemo(
    () => snapshots.some((s) => Math.abs(s.liabilities ?? 0) > 0.005),
    [snapshots],
  );

  const series = useMemo((): AreaSeries<NetWorthSnapshot>[] => [
    { key: 'liquid', label: t('networth.liquid'), accessor: (d) => d.liquid, color: LIQUID_COLOR, fillOpacity: 0, strokeWidth: 2 },
    { key: 'investments', label: t('networth.investments'), accessor: (d) => d.investments, color: INVESTMENTS_COLOR, fillOpacity: 0, strokeWidth: 2 },
    ...(hasLiabilities
      ? [{ key: 'liabilities', label: t('networth.liabilities'), accessor: (d: NetWorthSnapshot) => d.liabilities, color: LIABILITIES_COLOR, fillOpacity: 0, strokeWidth: 2 }]
      : []),
    { key: 'netWorth', label: t('networth.seriesTotal'), accessor: (d) => d.netWorth, color: TOTAL_COLOR, strokeWidth: 2.5 },
  ], [t, hasLiabilities]);

  const legend = useMemo((): ChartLegendItem[] => [
    { label: t('networth.seriesTotal'), color: TOTAL_COLOR },
    { label: t('networth.liquid'), color: LIQUID_COLOR },
    { label: t('networth.investments'), color: INVESTMENTS_COLOR },
    ...(hasLiabilities ? [{ label: t('networth.liabilities'), color: LIABILITIES_COLOR }] : []),
  ], [t, hasLiabilities]);

  return (
    <ChartCard
      title={t('networth.overTime')}
      description={t('networth.chartDesc')}
      icon={Wallet}
      legend={legend}
      actions={(
        <ChartPeriodSelector
          periods={periods}
          value={period}
          onChange={onPeriodChange}
          labels={periodLabels}
          size="sm"
        />
      )}
    >
      <VisxAreaChart
        scrubbable
        data={snapshots}
        xAccessor={(d) => parseLocalDateFromYmd(normalizeYmd(d.date))}
        series={series}
        xIsDate
        xTickFormat={(v) => xTickFormat(v as Date)}
        yTickFormat={(v) => fmt(v as number)}
        tooltipTitle={(d) => tooltipLabelFormatter(d.date)}
        tooltipValueFormat={(v) => fmt(v)}
        height={380}
        margin={{ top: 16, right: 24, bottom: 28, left: 110 }}
      />
    </ChartCard>
  );
}
