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
import { PageHeader } from "@/components/shared/PageHeader";
import { EmptyState } from "@/components/shared/EmptyState";
import { StatCard } from "@/components/dashboard/StatCard";
import { CHART_PERIODS, filterByPeriod, type ChartPeriod } from "@/components/charts";
import {
  EMPTY_SNAPSHOTS,
  normalizeYmd,
  fmtDay,
} from "./netWorthChartUtils";
import { NetWorthChart } from "./NetWorthChart";
import { SnapshotDataTable } from "./SnapshotDataTable";
import { useNetWorthTableData } from "./useNetWorthTableData";
import { StalePricesBanner } from "@/components/portfolio/StalePricesBanner";
import { Button } from "@/components/ui/button";
import { RefreshCw } from "lucide-react";
import { usePortfolio } from "@/hooks/usePortfolio";
import { useOnlineStatus } from "@/hooks/useOnlineStatus";
import { useAccountNetWorth } from "@/hooks/portfolio/useAccountNetWorth";
import { NetWorthByAccountChart } from "./NetWorthByAccountChart";

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

  // Per-account holdings history (ADR-100) — the rebuilt daily series, served Σ accounts.
  const { data: byAccountData } = useQuery({
    queryKey: ["net-worth-by-account", targetCurrency],
    queryFn: () => apiClient.getNetWorthByAccount({ currency: targetCurrency }),
    staleTime: 120_000,
  });

  const { investments, summaries, refreshPrices, isRefreshingPrices } = usePortfolio();
  const isOnline = useOnlineStatus();
  const accountRows = useAccountNetWorth(summaries);

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

  const [period, setPeriod] = useState<ChartPeriod>('all');

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

  // Full daily resolution — no downsampling — so the chart and drag-to-compare
  // scrubbing stay day-granular. Period only scopes the visible window.
  const displaySnapshots = useMemo(
    () => filterByPeriod(snapshots, (s) => s.date, period),
    [snapshots, period],
  );

  const currencyFormatter = useMemo(() => new Intl.NumberFormat(locale, {
    style: "currency",
    currency: appSettings.defaultCurrency || "EUR",
    minimumFractionDigits: appSettings.showDecimalPlaces,
    maximumFractionDigits: appSettings.showDecimalPlaces,
  }), [appSettings.defaultCurrency, appSettings.showDecimalPlaces, locale]);

  const fmt = useCallback((val: number) => currencyFormatter.format(val), [currencyFormatter]);

  const monthLabelLocale = useMemo(() => (language === 'nl' ? 'nl-NL' : 'en-US'), [language]);
  const xTickFormatter = useMemo(() => {
    if (period === '1m' || period === '3m' || period === '6m') {
      return new Intl.DateTimeFormat(monthLabelLocale, { day: 'numeric', month: 'short' });
    }
    return new Intl.DateTimeFormat(monthLabelLocale, { month: 'short', year: '2-digit' });
  }, [monthLabelLocale, period]);
  const xTickFormat = useCallback((d: Date) => xTickFormatter.format(d), [xTickFormatter]);

  const periodLabels = useMemo((): Record<ChartPeriod, string> => ({
    '1m': t('performance.period.1m'),
    '3m': t('performance.period.3m'),
    '6m': t('performance.period.6m'),
    '1y': t('performance.period.1y'),
    '3y': t('performance.period.3y'),
    'all': t('performance.period.all'),
  }), [t]);

  const current = data?.current ?? { liquid: 0, investments: 0, netWorth: 0 };

  const tooltipLabelFormatter = useCallback(
    (v: string) => fmtDay(v, appSettings.dateFormat),
    [appSettings.dateFormat],
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
        <Card className="glass-regular"><CardContent className="pt-6"><Skeleton className="h-[400px] w-full" /></CardContent></Card>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="space-y-6">
        <PageHeader title={t('networth.title')} icon={Wallet} />
        <Card className="glass-regular">
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
        <EmptyState
          icon={Wallet}
          title={t('networth.emptyTitle')}
          description={t('networth.emptyDescription')}
          action={(
            <div className="flex flex-col items-center gap-2">
              <Button
                onClick={refreshPrices}
                disabled={isRefreshingPrices || !isOnline}
                size="sm"
                title={!isOnline ? t('portfolio.refreshPricesOffline') : undefined}
              >
                <RefreshCw className={`h-3.5 w-3.5 mr-2 ${isRefreshingPrices ? "animate-spin" : ""}`} />
                {t('portfolio.refreshPrices')}
              </Button>
              {!isOnline && (
                <p className="text-xs text-muted-foreground max-w-md">
                  {t('portfolio.refreshPricesOffline')}
                </p>
              )}
            </div>
          )}
        />
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
        snapshots={displaySnapshots}
        period={period}
        periods={CHART_PERIODS}
        periodLabels={periodLabels}
        onPeriodChange={setPeriod}
        fmt={fmt}
        xTickFormat={xTickFormat}
        tooltipLabelFormatter={tooltipLabelFormatter}
        t={t}
      />

      {/* Per-account breakdown (ADR-093): cash + holdings at market per account */}
      {accountRows.length > 0 && (
        <Card className="glass-regular">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">{t('networth.byAccount')}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1">
            <div className="grid grid-cols-[1fr_auto_auto_auto] gap-x-4 sm:gap-x-8 text-xs uppercase tracking-wider text-muted-foreground pb-2 border-b border-border/50">
              <span>{t('networth.account')}</span>
              <span className="text-right">{t('networth.liquid')}</span>
              <span className="text-right">{t('networth.investments')}</span>
              <span className="text-right">{t('networth.title')}</span>
            </div>
            {accountRows.map((row) => (
              <div
                key={row.accountId ?? 'unassigned'}
                className="grid grid-cols-[1fr_auto_auto_auto] gap-x-4 sm:gap-x-8 py-1.5 text-sm border-b border-border/30 last:border-0"
              >
                <span className="truncate text-foreground">{row.name ?? t('accounts.unassigned')}</span>
                <span className="text-right tabular-nums text-muted-foreground">{fmt(row.cash)}</span>
                <span className="text-right tabular-nums text-muted-foreground">{fmt(row.holdings)}</span>
                <span className="text-right tabular-nums font-medium">{fmt(row.total)}</span>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {/* Per-account holdings history (ADR-100): stacked daily series, Σ accounts */}
      <NetWorthByAccountChart
        accounts={byAccountData?.accounts ?? []}
        fmt={fmt}
        title={t('networth.byAccountHistory')}
        description={t('networth.byAccountHistoryDesc')}
        unassignedLabel={t('accounts.unassigned')}
      />

      {/* Historical extremes */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <Card className="group relative overflow-hidden glass-regular premium-frame micro-lift">
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{t('networth.peak')}</CardTitle>
            <TrendingUp className="h-4 w-4 text-accent" />
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-bold text-foreground tabular-nums">{fmt(peak)}</p>
          </CardContent>
        </Card>
        <Card className="group relative overflow-hidden glass-regular premium-frame micro-lift">
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{t('networth.lowest')}</CardTitle>
            <TrendingDown className="h-4 w-4 text-destructive" />
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-bold text-foreground tabular-nums">{fmt(trough)}</p>
          </CardContent>
        </Card>
        <Card className="group relative overflow-hidden glass-regular premium-frame micro-lift">
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
