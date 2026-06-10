import React, { useMemo } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { AreaChart as VisxAreaChart, type AreaSeries } from "@/components/charts";
import { parseLocalDateFromYmd } from "@/components/shared/dateUtils";
import { DAY_WIDTH_OPTIONS, NetWorthSeries, NetWorthSnapshot, normalizeYmd } from "./netWorthChartUtils";

interface NetWorthChartProps {
  chartScrollRef: React.RefObject<HTMLDivElement | null>;
  displaySnapshots: NetWorthSnapshot[];
  chartWidth: number;
  yDomain: [number, number] | undefined;
  fallbackYDomain: [number, number];
  selectedSeries: NetWorthSeries;
  onSeriesChange: (series: NetWorthSeries) => void;
  zoomStep: number;
  onZoomIn: () => void;
  onZoomOut: () => void;
  isAtLatest: boolean;
  onScrollToLatest: () => void;
  current: { netWorth: number; liquid: number; investments: number };
  monthlyTicks: string[];
  monthTickFormatter: Intl.DateTimeFormat;
  fmt: (val: number) => string;
  tooltipLabelFormatter: (v: string) => string;
  tooltipValueFormatter: (value: number, name: string) => [string, string];
  t: (key: string) => string;
}

const SERIES_COLORS: Record<NetWorthSeries, string> = {
  netWorth: 'hsl(var(--chart-1))',
  liquid: 'hsl(var(--chart-2))',
  investments: 'hsl(var(--chart-4))',
};

const SERIES_STROKE_WIDTHS: Record<NetWorthSeries, number> = {
  netWorth: 2.25,
  liquid: 2,
  investments: 2,
};

export function NetWorthChart({
  chartScrollRef,
  displaySnapshots,
  chartWidth,
  yDomain,
  fallbackYDomain,
  selectedSeries,
  onSeriesChange,
  zoomStep,
  onZoomIn,
  onZoomOut,
  isAtLatest,
  onScrollToLatest,
  current,
  monthlyTicks,
  monthTickFormatter,
  fmt,
  tooltipLabelFormatter,
  tooltipValueFormatter,
  t,
}: NetWorthChartProps) {
  const series = useMemo((): AreaSeries<NetWorthSnapshot>[] => [{
    key: selectedSeries,
    accessor: (d) => d[selectedSeries],
    color: SERIES_COLORS[selectedSeries],
    strokeWidth: SERIES_STROKE_WIDTHS[selectedSeries],
  }], [selectedSeries]);

  const tickDates = useMemo(
    () => monthlyTicks.map((tick) => parseLocalDateFromYmd(normalizeYmd(tick))),
    [monthlyTicks],
  );

  const seriesLabel = useMemo(() => {
    if (selectedSeries === 'netWorth') return t('networth.title');
    if (selectedSeries === 'liquid') return t('networth.liquid');
    return t('networth.investments');
  }, [selectedSeries, t]);

  return (
    <Card>
      <CardHeader className="sm:flex-row sm:items-start sm:justify-between gap-3">
        <div>
          <CardTitle>{t('networth.overTime')}</CardTitle>
          <CardDescription>{t('networth.chartDesc')}</CardDescription>
        </div>
        <div className="flex items-center gap-1 self-start">
          <Button
            variant={selectedSeries === 'netWorth' ? 'secondary' : 'ghost'}
            size="sm"
            className="h-7 px-2 text-xs"
            onClick={() => onSeriesChange('netWorth')}
          >
            {t('networth.seriesTotal')}
          </Button>
          <Button
            variant={selectedSeries === 'investments' ? 'secondary' : 'ghost'}
            size="sm"
            className="h-7 px-2 text-xs"
            onClick={() => onSeriesChange('investments')}
          >
            {t('networth.seriesInvestments')}
          </Button>
          <Button
            variant={selectedSeries === 'liquid' ? 'secondary' : 'ghost'}
            size="sm"
            className="h-7 px-2 text-xs"
            onClick={() => onSeriesChange('liquid')}
          >
            {t('networth.seriesLiquid')}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-xs text-muted-foreground"
            onClick={onZoomIn}
            disabled={zoomStep <= 0}
          >
            {t('networth.zoomin')}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-xs text-muted-foreground"
            onClick={onZoomOut}
            disabled={zoomStep >= DAY_WIDTH_OPTIONS.length - 1}
          >
            {t('networth.zoomout')}
          </Button>
          {!isAtLatest && (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-xs text-muted-foreground"
              onClick={onScrollToLatest}
            >
              {t('networth.latest')}
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent>
        <div ref={chartScrollRef} className="overflow-x-auto pb-2">
          <div className="min-w-full" style={{ width: chartWidth }}>
            <VisxAreaChart
                scrubbable
              data={displaySnapshots}
              xAccessor={(d) => parseLocalDateFromYmd(normalizeYmd(d.date))}
              series={series}
              xIsDate={true}
              xTickValues={tickDates}
              xTickFormat={(v) => monthTickFormatter.format(v as Date)}
              yTickFormat={(v) => fmt(v as number)}
              yDomain={yDomain ?? fallbackYDomain}
              numYTicks={7}
              yAxisSide="right"
              referenceLines={[{
                y: current[selectedSeries],
                color: 'hsl(var(--muted-foreground))',
                dashed: true,
              }]}
              tooltipTitle={(d) => tooltipLabelFormatter(d.date)}
              tooltipValueFormat={(v) => tooltipValueFormatter(v, seriesLabel)[0]}
              height={420}
              width={chartWidth}
              margin={{ top: 10, right: 90, bottom: 28, left: 10 }}
            />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
