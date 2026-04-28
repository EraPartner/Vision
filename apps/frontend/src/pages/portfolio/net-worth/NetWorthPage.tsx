import { useQuery } from "@tanstack/react-query";
import { useCallback, useMemo, useState } from "react";
import { apiClient } from "@/lib/api";
import { useLanguage } from "@/contexts/LanguageContext";
import { useAppSettings } from "@/contexts/AppSettingsContext";
import { numberFormatToLocale } from "@/utils/currency";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { TrendingUp, TrendingDown, Wallet, Landmark, PiggyBank } from "lucide-react";
import { cn } from "@/lib/utils";
import { downsampleLTTB } from "@/utils/downsample";
import { PageHeader } from "@/components/shared/PageHeader";
import { StatCard } from "@/components/dashboard/StatCard";
import {
  EMPTY_SNAPSHOTS,
  DAY_WIDTH_OPTIONS,
  MIN_CHART_WIDTH,
  NetWorthSeries,
  normalizeYmd,
  fmtDay,
  computeNiceYDomain,
  computeYDomain,
  decimateTicks,
} from "./netWorthChartUtils";
import { useNetWorthChartScroll } from "./useNetWorthChartScroll";
import { NetWorthChart } from "./NetWorthChart";
import { SnapshotDataTable } from "./SnapshotDataTable";
import { useNetWorthTableData } from "./useNetWorthTableData";
import { StalePricesBanner } from "@/components/portfolio/StalePricesBanner";
import { Button } from "@/components/ui/button";
import { RefreshCw } from "lucide-react";
import { usePortfolio } from "@/hooks/usePortfolio";

const MONTH_LABEL_MIN_PX = 60;

export default function NetWorthPage() {
  const { t, language } = useLanguage();
  const { appSettings } = useAppSettings();
  const locale = numberFormatToLocale(appSettings.numberFormat);
  const targetCurrency = appSettings.defaultCurrency || "EUR";

  const { data, isLoading, error } = useQuery({
    queryKey: ["net-worth", targetCurrency],
    queryFn: () => apiClient.getNetWorth({ currency: targetCurrency }),
    staleTime: 120_000,
  });

  const { investments, refreshPrices, isRefreshingPrices } = usePortfolio();

  const {
    allItems: tableSnapshots,
    totalItems: tableTotal,
    isFetchingMore: tableIsFetchingMore,
    hasMore: tableHasMore,
    loadMore: tableLoadMore,
  } = useNetWorthTableData({
    currency: targetCurrency,
    pageSize: appSettings.defaultPageSize,
  });

  const [zoomStep, setZoomStep] = useState(0);
  const [selectedSeries, setSelectedSeries] = useState<NetWorthSeries>('netWorth');
  const dayWidth = DAY_WIDTH_OPTIONS[zoomStep] ?? DAY_WIDTH_OPTIONS[0];

  const snapshots = useMemo(() => {
    const raw = data?.snapshots ?? EMPTY_SNAPSHOTS;
    const result: typeof EMPTY_SNAPSHOTS = [];
    for (let i = 0; i < raw.length; i++) {
      const s = raw[i];
      const date = normalizeYmd(s.date);
      if (date && Number.isFinite(s.netWorth) && Number.isFinite(s.liquid) && Number.isFinite(s.investments)) {
        result.push(date !== s.date ? { date, netWorth: s.netWorth, liquid: s.liquid, investments: s.investments } : s);
      }
    }
    return result;
  }, [data?.snapshots]);

  const chartSnapshots = useMemo(() => {
    const maxPointsForZoom = Math.max(150, Math.min(500, Math.round(800 / dayWidth)));
    const threshold = Math.min(maxPointsForZoom, 400);
    if (snapshots.length <= threshold) return snapshots;
    return downsampleLTTB(snapshots, threshold, (_item, i) => i, (item) => item[selectedSeries]);
  }, [snapshots, selectedSeries, dayWidth]);

  const currencyFormatter = useMemo(() => new Intl.NumberFormat(locale, {
    style: "currency",
    currency: appSettings.defaultCurrency || "EUR",
    minimumFractionDigits: appSettings.showDecimalPlaces,
    maximumFractionDigits: appSettings.showDecimalPlaces,
  }), [appSettings.defaultCurrency, appSettings.showDecimalPlaces, locale]);

  const fmt = useCallback((val: number) => currencyFormatter.format(val), [currencyFormatter]);

  const monthLabelLocale = useMemo(() => (language === 'nl' ? 'nl-NL' : 'en-US'), [language]);
  const monthTickFormatter = useMemo(
    () => new Intl.DateTimeFormat(monthLabelLocale, { month: 'short', year: '2-digit' }),
    [monthLabelLocale],
  );

  const current = data?.current ?? { liquid: 0, investments: 0, netWorth: 0 };
  const displaySnapshots = chartSnapshots;

  const chartWidth = useMemo(() => {
    return Math.max(MIN_CHART_WIDTH, Math.max(displaySnapshots.length, 1) * dayWidth);
  }, [displaySnapshots.length, dayWidth]);

  const fallbackYDomain = useMemo(
    () => computeNiceYDomain(computeYDomain(displaySnapshots, [selectedSeries])),
    [displaySnapshots, selectedSeries],
  );

  const monthlyTicks = useMemo(() => {
    const allMonthFirsts = displaySnapshots
      .filter((s, idx) => idx === 0 || s.date.slice(0, 7) !== displaySnapshots[idx - 1].date.slice(0, 7))
      .map((s) => s.date);
    return decimateTicks(allMonthFirsts, chartWidth, MONTH_LABEL_MIN_PX);
  }, [displaySnapshots, chartWidth]);

  const { chartScrollRef, yDomain, isAtLatest, scrollToLatest, captureZoomAnchor } = useNetWorthChartScroll({
    chartWidth,
    displaySnapshots,
    selectedSeries,
    zoomStep,
  });

  const tooltipLabelFormatter = useCallback(
    (v: string) => fmtDay(v, appSettings.dateFormat),
    [appSettings.dateFormat],
  );
  const tooltipValueFormatter = useCallback(
    (value: number, name: string): [string, string] => [fmt(value), name],
    [fmt],
  );

  if (isLoading) {
    return (
      <div className="space-y-6">
        <PageHeader title={t('networth.title')} icon={Wallet} />
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          {[1, 2, 3].map(i => (
            <Card key={i}><CardContent className="pt-6"><Skeleton className="h-16 w-full" /></CardContent></Card>
          ))}
        </div>
        <Card><CardContent className="pt-6"><Skeleton className="h-[400px] w-full" /></CardContent></Card>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="space-y-6">
        <PageHeader title={t('networth.title')} icon={Wallet} />
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-16 text-center">
            <Wallet className="h-12 w-12 text-muted-foreground/40 mb-4" />
            <h3 className="text-lg font-semibold text-foreground mb-1">{t('networth.unableToLoad')}</h3>
            <p className="text-muted-foreground text-sm">
              {error instanceof Error ? error.message : t('networth.tryAgain')}
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (snapshots.length === 0) {
    return (
      <div className="space-y-6">
        <PageHeader title={t('networth.title')} icon={Wallet} />
        <Card>
          <CardContent className="flex flex-col items-center justify-center gap-3 py-12 text-center">
            <Wallet className="h-10 w-10 text-muted-foreground" />
            <div>
              <p className="font-medium">{t('networth.emptyTitle')}</p>
              <p className="text-sm text-muted-foreground max-w-md mt-1">
                {t('networth.emptyDescription')}
              </p>
            </div>
            <Button onClick={refreshPrices} disabled={isRefreshingPrices} size="sm">
              <RefreshCw className={`h-3.5 w-3.5 mr-2 ${isRefreshingPrices ? "animate-spin" : ""}`} />
              {t('portfolio.refreshPrices')}
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  let peak = current.netWorth;
  let trough = current.netWorth;
  for (const s of snapshots) {
    if (s.netWorth > peak) peak = s.netWorth;
    if (s.netWorth < trough) trough = s.netWorth;
  }
  const firstNetWorth = snapshots[0]?.netWorth ?? 0;
  const allTimeChange = current.netWorth - firstNetWorth;
  const allTimePercent = firstNetWorth !== 0 ? (allTimeChange / Math.abs(firstNetWorth)) * 100 : 0;
  const monthlyChange = data.monthlyChange ?? 0;
  const monthlyChangePercent = data.monthlyChangePercent ?? 0;

  const liquidPct = current.netWorth > 0 ? ((current.liquid / current.netWorth) * 100).toFixed(0) : '0';
  const investmentsPct = current.netWorth > 0 ? ((current.investments / current.netWorth) * 100).toFixed(0) : '0';

  return (
    <div className="space-y-6">
      <PageHeader
        title={t('networth.title')}
        icon={Wallet}
        actions={(
          <Badge variant="outline" className={cn(
            "text-sm px-3 py-1",
            allTimeChange >= 0 ? "border-accent/30 text-accent" : "border-destructive/30 text-destructive"
          )}>
            {allTimeChange >= 0 ? <TrendingUp className="h-3.5 w-3.5 mr-1" /> : <TrendingDown className="h-3.5 w-3.5 mr-1" />}
            {allTimeChange >= 0 ? "+" : ""}{fmt(allTimeChange)} {t('networth.allTime')} ({allTimePercent >= 0 ? "+" : ""}{allTimePercent.toFixed(1)}%)
          </Badge>
        )}
      />

      <StalePricesBanner
        investments={investments}
        onRefresh={refreshPrices}
        isRefreshing={isRefreshingPrices}
      />

      {/* Summary — bento: featured Net Worth + liquid/investments split */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-6 animate-stagger">
        <div className="lg:col-span-3 lg:row-span-2 [&>*]:h-full">
          <StatCard
            title={t('networth.title')}
            value={fmt(current.netWorth)}
            numericValue={current.netWorth}
            formatValue={fmt}
            icon={Wallet}
            trend={monthlyChange >= 0 ? "income" : "expense"}
            subtitle={`${monthlyChange >= 0 ? "+" : ""}${fmt(monthlyChange)} (${monthlyChangePercent >= 0 ? "+" : ""}${monthlyChangePercent.toFixed(1)}%) ${t('networth.thisMonth')}`}
          />
        </div>
        <div className="lg:col-span-3">
          <StatCard
            title={t('networth.liquid')}
            value={fmt(current.liquid)}
            numericValue={current.liquid}
            formatValue={fmt}
            icon={Landmark}
            trend="neutral"
            subtitle={`${liquidPct} ${t('networth.ofNetWorth')}`}
          />
        </div>
        <div className="lg:col-span-3">
          <StatCard
            title={t('networth.investments')}
            value={fmt(current.investments)}
            numericValue={current.investments}
            formatValue={fmt}
            icon={PiggyBank}
            trend="neutral"
            subtitle={`${investmentsPct} ${t('networth.ofNetWorth')}`}
          />
        </div>
      </div>

      <NetWorthChart
        chartScrollRef={chartScrollRef}
        displaySnapshots={displaySnapshots}
        chartWidth={chartWidth}
        yDomain={yDomain}
        fallbackYDomain={fallbackYDomain}
        selectedSeries={selectedSeries}
        onSeriesChange={setSelectedSeries}
        zoomStep={zoomStep}
        onZoomIn={() => { captureZoomAnchor(); setZoomStep((prev) => Math.max(0, prev - 1)); }}
        onZoomOut={() => { captureZoomAnchor(); setZoomStep((prev) => Math.min(DAY_WIDTH_OPTIONS.length - 1, prev + 1)); }}
        isAtLatest={isAtLatest}
        onScrollToLatest={scrollToLatest}
        current={current}
        monthlyTicks={monthlyTicks}
        monthTickFormatter={monthTickFormatter}
        fmt={fmt}
        tooltipLabelFormatter={tooltipLabelFormatter}
        tooltipValueFormatter={tooltipValueFormatter}
        t={t}
      />

      {/* Historical extremes */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <Card className="group relative overflow-hidden surface-elevated premium-frame micro-lift bg-card backdrop-blur-sm">
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{t('networth.peak')}</CardTitle>
            <TrendingUp className="h-4 w-4 text-accent" />
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-bold text-foreground tabular-nums">{fmt(peak)}</p>
          </CardContent>
        </Card>
        <Card className="group relative overflow-hidden surface-elevated premium-frame micro-lift bg-card backdrop-blur-sm">
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{t('networth.lowest')}</CardTitle>
            <TrendingDown className="h-4 w-4 text-destructive" />
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-bold text-foreground tabular-nums">{fmt(trough)}</p>
          </CardContent>
        </Card>
        <Card className="group relative overflow-hidden surface-elevated premium-frame micro-lift bg-card backdrop-blur-sm">
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{t('networth.daysTracked')}</CardTitle>
            <Wallet className="h-4 w-4 text-primary" />
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-bold text-foreground tabular-nums">{snapshots.length}</p>
          </CardContent>
        </Card>
      </div>

      <SnapshotDataTable
        snapshots={tableSnapshots}
        fmt={fmt}
        dateFormat={appSettings.dateFormat}
        t={t}
        totalItems={tableTotal}
        isFetchingMore={tableIsFetchingMore}
        hasMore={tableHasMore}
        onLoadMore={tableLoadMore}
      />
    </div>
  );
}
