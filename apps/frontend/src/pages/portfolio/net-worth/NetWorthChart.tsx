import React, { useMemo } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, ReferenceLine,
} from "recharts";
import { DAY_WIDTH_OPTIONS, NetWorthSeries, NetWorthSnapshot, formatMonthTickLabel } from "./netWorthChartUtils";

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

const TOOLTIP_CONTENT_STYLE = {
  backgroundColor: "hsl(var(--card))",
  border: "1px solid hsl(var(--border))",
  borderRadius: "var(--radius)",
  color: "hsl(var(--card-foreground))",
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
  const seriesConfig = useMemo(() => ({
    netWorth: {
      label: t('networth.title'),
      stroke: 'hsl(var(--primary))',
      strokeWidth: 2.5,
      fill: 'url(#gradNetWorth)',
      dash: undefined as string | undefined,
    },
    liquid: {
      label: t('networth.liquid'),
      stroke: 'hsl(var(--accent))',
      strokeWidth: 2,
      fill: 'url(#gradLiquid)',
      dash: '4 2' as string | undefined,
    },
    investments: {
      label: t('networth.investments'),
      stroke: 'hsl(217, 91%, 60%)',
      strokeWidth: 2,
      fill: 'url(#gradInvest)',
      dash: '4 2' as string | undefined,
    },
  }), [t]);

  const config = seriesConfig[selectedSeries];

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
            <ResponsiveContainer width="100%" height={420}>
              <AreaChart data={displaySnapshots} margin={{ top: 10, right: 10, left: 10, bottom: 0 }}>
                <defs>
                  <linearGradient id="gradNetWorth" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="hsl(var(--primary))" stopOpacity={0.3} />
                    <stop offset="95%" stopColor="hsl(var(--primary))" stopOpacity={0} />
                  </linearGradient>
                  <linearGradient id="gradLiquid" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="hsl(var(--accent))" stopOpacity={0.2} />
                    <stop offset="95%" stopColor="hsl(var(--accent))" stopOpacity={0} />
                  </linearGradient>
                  <linearGradient id="gradInvest" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="hsl(217, 91%, 60%)" stopOpacity={0.2} />
                    <stop offset="95%" stopColor="hsl(217, 91%, 60%)" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                <XAxis
                  dataKey="date"
                  ticks={monthlyTicks}
                  tickFormatter={(v: string) => formatMonthTickLabel(v, monthTickFormatter)}
                  tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 12 }}
                  axisLine={{ stroke: "hsl(var(--border))" }}
                  height={36}
                  minTickGap={24}
                />
                <YAxis
                  domain={yDomain ?? fallbackYDomain}
                  allowDataOverflow
                  tickFormatter={(v) => fmt(v)}
                  tickCount={7}
                  tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 12 }}
                  axisLine={{ stroke: "hsl(var(--border))" }}
                  width={90}
                  orientation="right"
                />
                <ReferenceLine
                  y={current[selectedSeries]}
                  stroke="hsl(var(--muted-foreground))"
                  strokeDasharray="2 4"
                  strokeOpacity={0.5}
                />
                <Tooltip
                  contentStyle={TOOLTIP_CONTENT_STYLE}
                  labelFormatter={tooltipLabelFormatter}
                  formatter={tooltipValueFormatter}
                />
                <Area
                  type="monotone"
                  dataKey={selectedSeries}
                  name={config.label}
                  stroke={config.stroke}
                  strokeWidth={config.strokeWidth}
                  fill={config.fill}
                  strokeDasharray={config.dash}
                  isAnimationActive={false}
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
