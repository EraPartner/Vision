import { useQuery } from "@tanstack/react-query";
import { useCallback, useMemo, useState } from "react";
import { apiClient } from "@/lib/api";
import { netWorthKeys } from "@/lib/queryKeys";
import { useLanguage } from "@/contexts/LanguageContext";
import { useAppSettings } from "@/contexts/AppSettingsContext";
import { useCurrencyFormatter, useCurrencyPartsFormatter } from "@/hooks/useCurrencyFormatter";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { TrendingUp, TrendingDown, Wallet, Landmark, PiggyBank, CreditCard } from "lucide-react";
import { cn } from "@/lib/utils";
import { PageHeader } from "@/components/shared/PageHeader";
import { EmptyState } from "@/components/shared/EmptyState";
import { StatCard } from "@/components/dashboard/StatCard";
import { RollingNumber } from "@/components/shared/RollingNumber";
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
import { isPerAccountHoldingsEnabled } from "@/lib/env";

export default function NetWorthPage() {
  const { t, language } = useLanguage();
  const { appSettings } = useAppSettings();
  const targetCurrency = appSettings.defaultCurrency || "EUR";

  const { data, isLoading, error } = useQuery({
    queryKey: netWorthKeys.byCurrency(targetCurrency),
    queryFn: () => apiClient.getNetWorth({ currency: targetCurrency }),
    staleTime: 120_000,
  });

  // Per-account holdings history (ADR-100) — the rebuilt daily series, served Σ accounts.
  const {
    data: byAccountData,
    isLoading: byAccountLoading,
    error: byAccountError,
  } = useQuery({
    queryKey: netWorthKeys.byAccount(targetCurrency),
    queryFn: () => apiClient.getNetWorthByAccount({ currency: targetCurrency }),
    staleTime: 120_000,
    enabled: isPerAccountHoldingsEnabled,
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
        const liabilities = Number.isFinite(s.liabilities) ? s.liabilities : 0;
        result.push(date !== s.date ? { date, netWorth: s.netWorth, liquid: s.liquid, liabilities, investments: s.investments } : s);
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

  const fmt = useCurrencyFormatter();
  const fmtParts = useCurrencyPartsFormatter();

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

  const current = data?.current ?? { liquid: 0, liabilities: 0, investments: 0, netWorth: 0 };

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
                <RefreshCw className={cn("h-3.5 w-3.5 mr-2", isRefreshingPrices && "animate-spin")} />
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

  // Peak/trough/days-tracked reflect the selected period (the visible window),
  // matching the chart below; the "all time" change badge stays on the full series.
  let peak = current.netWorth;
  let trough = current.netWorth;
  for (const s of displaySnapshots) {
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
  const liabilitiesPct = current.netWorth > 0 ? ((current.liabilities / current.netWorth) * 100).toFixed(0) : '0';
  const hasLiabilities = Math.abs(current.liabilities) > 0.005;
  const accountsHaveLiabilities = accountRows.some((r) => Math.abs(r.liabilities) > 0.005);
  const byAccountGrid = accountsHaveLiabilities
    ? "grid-cols-[1fr_auto_auto_auto_auto]"
    : "grid-cols-[1fr_auto_auto_auto]";

  return (
    <div className="space-y-6">
      <PageHeader
        title={t('networth.title')}
        icon={Wallet}
        actions={(
          <Badge variant="outline" className={cn(
            "text-sm px-3 py-1",
            allTimeChange >= 0 ? "border-gain/30 text-gain" : "border-loss/30 text-loss"
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

      {/* Summary — bento: featured Net Worth + liquid/investments/liabilities split */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-6 animate-stagger">
        <div className={cn("lg:col-span-3 [&>*]:h-full", hasLiabilities ? "lg:row-span-3" : "lg:row-span-2")}>
          <StatCard
            title={t('networth.title')}
            value={<RollingNumber parts={fmtParts(current.netWorth)} />}
            icon={Wallet}
            valueClassName="text-primary"
            trend={monthlyChange >= 0 ? "income" : "expense"}
            subtitle={`${monthlyChange >= 0 ? "+" : ""}${fmt(monthlyChange)} (${monthlyChangePercent >= 0 ? "+" : ""}${monthlyChangePercent.toFixed(1)}%) ${t('networth.thisMonth')}`}
          />
        </div>
        <div className="lg:col-span-3">
          <StatCard
            title={t('networth.liquid')}
            value={<RollingNumber parts={fmtParts(current.liquid)} />}
            icon={Landmark}
            trend="neutral"
            subtitle={`${liquidPct} ${t('networth.ofNetWorth')}`}
          />
        </div>
        <div className="lg:col-span-3">
          <StatCard
            title={t('networth.investments')}
            value={<RollingNumber parts={fmtParts(current.investments)} />}
            icon={PiggyBank}
            trend="neutral"
            subtitle={`${investmentsPct} ${t('networth.ofNetWorth')}`}
          />
        </div>
        {hasLiabilities && (
          <div className="lg:col-span-3">
            <StatCard
              title={t('networth.liabilities')}
              value={<RollingNumber parts={fmtParts(current.liabilities)} />}
              icon={CreditCard}
              trend="expense"
              subtitle={`${liabilitiesPct} ${t('networth.ofNetWorth')}`}
            />
          </div>
        )}
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

      {/* Per-account breakdown (ADR-093/100) — gated off with per-account holdings (ADR-103) */}
      {isPerAccountHoldingsEnabled && accountRows.length > 0 && (
        <Card className="glass-regular">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">{t('networth.byAccount')}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1">
            <div className={cn("grid gap-x-4 sm:gap-x-8 text-xs uppercase tracking-wider text-muted-foreground pb-2 border-b border-border/50", byAccountGrid)}>
              <span>{t('networth.account')}</span>
              <span className="text-right">{t('networth.liquid')}</span>
              {accountsHaveLiabilities && <span className="text-right">{t('networth.liabilities')}</span>}
              <span className="text-right">{t('networth.investments')}</span>
              <span className="text-right">{t('networth.title')}</span>
            </div>
            {accountRows.map((row) => (
              <div
                key={row.accountId ?? 'unassigned'}
                className={cn("grid gap-x-4 sm:gap-x-8 py-1.5 text-sm border-b border-border/30 last:border-0", byAccountGrid)}
              >
                <span className="truncate text-foreground">{row.name ?? t('accounts.unassigned')}</span>
                <span className="text-right tabular-nums text-muted-foreground">{fmt(row.cash)}</span>
                {accountsHaveLiabilities && <span className="text-right tabular-nums text-muted-foreground">{fmt(row.liabilities)}</span>}
                <span className="text-right tabular-nums text-muted-foreground">{fmt(row.holdings)}</span>
                <span className="text-right tabular-nums font-medium">{fmt(row.total)}</span>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {/* Per-account holdings history (ADR-100): stacked daily series, Σ accounts.
          Gated off with per-account holdings (ADR-103). Surface load/error
          explicitly so a failed fetch doesn't silently render a blank chart. */}
      {!isPerAccountHoldingsEnabled ? null : byAccountError ? (
        <Card className="glass-regular">
          <CardContent className="py-10 text-center">
            <p className="text-sm font-medium text-foreground">{t('networth.unableToLoad')}</p>
            <p className="text-xs text-muted-foreground mt-1">
              {byAccountError instanceof Error ? byAccountError.message : t('networth.tryAgain')}
            </p>
          </CardContent>
        </Card>
      ) : byAccountLoading ? (
        <Card className="glass-regular"><CardContent className="pt-6"><Skeleton className="h-[300px] w-full" /></CardContent></Card>
      ) : (
        <NetWorthByAccountChart
          accounts={byAccountData?.accounts ?? []}
          fmt={fmt}
          title={t('networth.byAccountHistory')}
          description={t('networth.byAccountHistoryDesc')}
          unassignedLabel={t('accounts.unassigned')}
        />
      )}

      {/* Historical extremes */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <StatCard title={t('networth.peak')} value={<RollingNumber parts={fmtParts(peak)} />} icon={TrendingUp} trend="income" />
        <StatCard title={t('networth.lowest')} value={<RollingNumber parts={fmtParts(trough)} />} icon={TrendingDown} trend="expense" />
        <StatCard title={t('networth.daysTracked')} value={String(displaySnapshots.length)} icon={Wallet} />
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
