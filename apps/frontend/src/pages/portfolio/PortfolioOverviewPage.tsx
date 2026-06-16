import { useLanguage } from "@/contexts/LanguageContext";
import { useAppSettings } from "@/contexts/AppSettingsContext";
import { useCurrencyFormatter } from "@/hooks/useCurrencyFormatter";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { TrendingUp, TrendingDown, PieChart as PieChartIcon, Trash2, RefreshCw, Loader2, ArrowUpRight, Clock, AlertTriangle } from "lucide-react";
import { DonutChart, ChartLegend, type ChartLegendItem } from "@/components/charts";
import { usePortfolio } from "@/hooks/usePortfolio";
import { usePortfolioSummaryQuery } from "@/hooks/portfolio/usePortfolioSummary";
import { AddInvestmentDialog } from "@/components/portfolio/AddInvestmentDialog";
import { AddPortfolioTxnDialog } from "@/components/portfolio/AddPortfolioTxnDialog";
import { InvestmentDetailDialog } from "@/components/portfolio/InvestmentDetailDialog";
import { PortfolioNewsFeed } from "@/components/portfolio/PortfolioNewsFeed";
import { StalePricesBanner } from "@/components/portfolio/StalePricesBanner";
import { TotalValueCard, type SparklinePoint } from "@/components/portfolio/TotalValueCard";
import { ASSET_CLASS_LABELS, getAssetClassGroups } from "@/types/portfolio";
import { isUnitBased } from "@/utils/assetClass";
import { cn } from "@/lib/utils";
import { useConfirmDialog } from "@/hooks/useConfirmDialog";
import { useMemo } from "react";
import { useCurrencyConverter } from "@/hooks/useCurrencyConverter";
import { useOnlineStatus } from "@/hooks/useOnlineStatus";
import { WidgetVisibilityDialog } from "@/components/shared/WidgetVisibilityDialog";
import { useWidgetVisibility, type WidgetDefinition } from "@/hooks/useWidgetVisibility";
import { PageHeader } from "@/components/shared/PageHeader";
import { EmptyState } from "@/components/shared/EmptyState";
import { parseYmd } from "@/lib/timezone";
import { ExportDialog } from "@/components/reports/ExportDialog";

function getPortfolioWidgets(t: (key: string) => string): WidgetDefinition[] {
  return [
    { id: "summaryCards",    label: t('portfolio.widget.summaryCards'), defaultVisible: true },
    { id: "allocation",      label: t('portfolio.widget.allocation'),   defaultVisible: true },
    { id: "performance",     label: t('portfolio.widget.performance'),  defaultVisible: true },
    { id: "investments",     label: t('portfolio.widget.investments'),  defaultVisible: true },
    { id: "news",            label: t('portfolio.widget.news'),         defaultVisible: true },
  ];
}

const COLORS = [
  "hsl(217, 91%, 60%)", "hsl(142, 76%, 36%)", "hsl(45, 93%, 47%)",
  "hsl(280, 87%, 65%)", "hsl(340, 82%, 52%)", "hsl(200, 80%, 50%)",
];

export default function PortfolioOverviewPage() {
  const { t, tc } = useLanguage();
  const { appSettings } = useAppSettings();
  const targetCurrency = appSettings.defaultCurrency || 'EUR';
  const {
    summaries, transactions,
    deleteInvestment, refreshPrices, isRefreshingPrices
  } = usePortfolio();
  const { data: portfolioSummary } = usePortfolioSummaryQuery(targetCurrency);
  const isOnline = useOnlineStatus();
  const { confirm, ConfirmDialog } = useConfirmDialog();
  const PORTFOLIO_WIDGETS = useMemo(() => getPortfolioWidgets(t), [t]);
  const { isVisible, setWidgetVisible, setAllVisible, resetToDefaults, widgets: widgetDefs } = useWidgetVisibility('portfolio', PORTFOLIO_WIDGETS);

  const { convertToTarget } = useCurrencyConverter(targetCurrency);

  const fmt = useCurrencyFormatter(targetCurrency);

  const assetClassGroups = useMemo(() => getAssetClassGroups(t), [t]);

  // Source of truth for totals: backend /api/info/portfolio-summary.
  // Falls back to a fresh frontend reduce while the query is loading so the
  // dashboard can still render. Once the query resolves, the BE response
  // overrides — guaranteeing parity with the performance page.
  const totals = portfolioSummary?.totals;
  const totalPortfolioValueInTarget = totals?.totalPortfolioValue ?? 0;
  const totalInvested = totals?.totalInvested ?? 0;
  const totalGainLossInTarget = totals?.totalGain ?? 0;
  const totalRealizedGainInTarget = totals?.totalRealizedGain ?? 0;
  const totalUnrealizedGainInTarget = totals?.totalUnrealizedGain ?? 0;
  const totalFeesInTarget = totals?.totalFees ?? 0;
  const totalTaxesInTarget = totals?.totalTaxes ?? 0;
  const totalIncome = totals?.totalIncome ?? 0;
  const totalAssetGainInTarget = totals?.totalAssetGain ?? 0;
  const totalFxGainInTarget = totals?.totalFxGain ?? 0;
  const fxRateFellBack = totals?.usedFallbackRate === true;
  // Only surface FX attribution when some holding is in a foreign currency —
  // an all-EUR portfolio would just show a noisy "FX effect: €0.00" line.
  const hasFxExposure = (portfolioSummary?.summaries ?? []).some(
    (s) => s.originalCurrency && s.originalCurrency !== portfolioSummary?.currency,
  );

  const allocationAndNews = useMemo(() => {
    const classToGroup = new Map<string, string>();
    for (const [group, classes] of Object.entries(assetClassGroups)) {
      for (const cls of classes) {
        classToGroup.set(cls, group);
      }
    }

    const allocationByGroup = new Map<string, number>();
    const newsSymbols: string[] = [];

    for (const summary of summaries) {
      const currentValueInTarget = convertToTarget(summary.currentValue, summary.currency);
      const group = classToGroup.get(summary.assetClass);
      if (group) {
        allocationByGroup.set(group, (allocationByGroup.get(group) || 0) + currentValueInTarget);
      }
      if (summary.symbol && newsSymbols.length < 10) {
        newsSymbols.push(summary.symbol);
      }
    }

    const allocationData = Object.keys(assetClassGroups)
      .map((group) => ({
        name: group,
        value: allocationByGroup.get(group) || 0,
      }))
      .filter((entry) => entry.value > 0);

    return { newsSymbols, allocationData };
  }, [summaries, convertToTarget, assetClassGroups]);

  const { newsSymbols, allocationData } = allocationAndNews;

  const gainPercent = totals?.totalReturnPct ?? 0;

  const performers = useMemo(() => {
    const eligible = summaries
      .filter((s) => s.totalBuyCost > 0)
      .map((s) => ({
        id: s.id,
        name: s.name,
        symbol: s.symbol || undefined,
        gainLossPercent: s.gainLossPercent,
        gainLossInTarget: convertToTarget(s.totalGain, s.currency),
      }));
    if (eligible.length === 0) return { best: undefined, worst: undefined };
    const sorted = [...eligible].sort((a, b) => b.gainLossPercent - a.gainLossPercent);
    const best = sorted[0];
    const worst = sorted[sorted.length - 1];
    return {
      best,
      worst: sorted.length > 1 ? worst : undefined,
    };
  }, [summaries, convertToTarget]);

  const sparkline: SparklinePoint[] = useMemo(() => {
    if (transactions.length === 0) return [];
    const DAYS = 30;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const startMs = today.getTime() - (DAYS - 1) * 86_400_000;

    const investmentCurrency = new Map<number, string>();
    summaries.forEach((s) => investmentCurrency.set(s.id, s.currency));

    // Day-indexed net cost basis delta (buys + gifts - sells).
    const dailyDelta = new Map<number, number>();
    let baseline = 0;
    for (const txn of transactions) {
      if (txn.type !== 'buy' && txn.type !== 'sell' && txn.type !== 'gift') continue;
      const amount = Number(txn.amount) || 0;
      const signed = txn.type === 'sell' ? -amount : amount;
      const ccy = investmentCurrency.get(txn.investment_id) || targetCurrency;
      const inTarget = convertToTarget(signed, ccy);
      const txnDate = parseYmd(txn.date);
      txnDate.setHours(0, 0, 0, 0);
      const ms = txnDate.getTime();
      if (ms < startMs) {
        baseline += inTarget;
      } else if (ms <= today.getTime()) {
        const dayIdx = Math.floor((ms - startMs) / 86_400_000);
        dailyDelta.set(dayIdx, (dailyDelta.get(dayIdx) || 0) + inTarget);
      }
    }

    const points: SparklinePoint[] = [];
    let running = baseline;
    for (let i = 0; i < DAYS; i++) {
      running += dailyDelta.get(i) || 0;
      points.push({ t: startMs + i * 86_400_000, v: running });
    }
    // Hide a flat-zero series (no recent activity).
    const allEqual = points.every((p) => p.v === points[0].v);
    return allEqual ? [] : points;
  }, [transactions, summaries, convertToTarget, targetCurrency]);

  const cards = [
    {
      title: t('portfolio.totalGainLoss'),
      value: `${totalGainLossInTarget >= 0 ? '+' : ''}${fmt(totalGainLossInTarget)}`,
      icon: totalGainLossInTarget >= 0 ? TrendingUp : TrendingDown,
      desc: `${gainPercent >= 0 ? '+' : ''}${gainPercent.toFixed(1)}% ${t('networth.allTime')}`,
      cls: totalGainLossInTarget >= 0 ? "text-accent" : "text-destructive",
      // Attribution: gain = asset performance + currency effect (FX feature).
      subline: hasFxExposure
        ? `${t('portfolio.assetGain')} ${totalAssetGainInTarget >= 0 ? '+' : ''}${fmt(totalAssetGainInTarget)} · ${t('portfolio.fxEffect')} ${totalFxGainInTarget >= 0 ? '+' : ''}${fmt(totalFxGainInTarget)}`
        : undefined,
      sublineWarning: hasFxExposure && fxRateFellBack ? t('portfolio.fxFallbackNote') : undefined,
    },
    {
      title: t('portfolio.realizedGains'),
      value: `${totalRealizedGainInTarget >= 0 ? '+' : ''}${fmt(totalRealizedGainInTarget)}`,
      icon: ArrowUpRight,
      desc: t('portfolio.fromClosedPositions'),
      cls: totalRealizedGainInTarget >= 0 ? "text-accent" : "text-destructive"
    },
    {
      title: t('portfolio.unrealizedGains'),
      value: `${totalUnrealizedGainInTarget >= 0 ? '+' : ''}${fmt(totalUnrealizedGainInTarget)}`,
      icon: Clock,
      desc: t('portfolio.paperProfitLoss'),
      cls: totalUnrealizedGainInTarget >= 0 ? "text-accent" : "text-destructive"
    },
  ];

  const isEmpty = summaries.length === 0;

  return (
    <div className="space-y-6">
      <PageHeader
        title={t('portfolio.overviewTitle')}
        icon={PieChartIcon}
        actions={(
          <>
            <ExportDialog defaultType="portfolio" />
            <WidgetVisibilityDialog
              widgets={widgetDefs}
              isVisible={isVisible}
              setWidgetVisible={setWidgetVisible}
              setAllVisible={setAllVisible}
              resetToDefaults={resetToDefaults}
            />
            <Button
              size="sm"
              variant="outline"
              className="gap-1.5"
              onClick={refreshPrices}
              disabled={isRefreshingPrices || !isOnline}
              title={!isOnline ? t('portfolio.refreshPricesOffline') : undefined}
            >
              {isRefreshingPrices ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
              {t('portfolio.refreshPrices')}
            </Button>
            <AddInvestmentDialog />
          </>
        )}
      />

      {isEmpty ? (
        <Card className="glass-regular">
          <CardContent className="pt-0">
            <EmptyState
              icon={PieChartIcon}
              title={t('portfolio.noInvestments')}
              description={t('portfolio.noInvestmentsDesc')}
              action={<AddInvestmentDialog />}
            />
          </CardContent>
        </Card>
      ) : (
        <>
          <StalePricesBanner
            investments={summaries}
            onRefresh={refreshPrices}
            isRefreshing={isRefreshingPrices}
          />

          {isVisible('summaryCards') && (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-6 gap-4">
              <div className="sm:col-span-2 lg:col-span-3 lg:row-span-2">
                <TotalValueCard
                  formattedTotal={fmt(totalPortfolioValueInTarget)}
                  totalValue={totalPortfolioValueInTarget}
                  labels={{
                    title: t('portfolio.totalValue'),
                    investments: tc('portfolio.investments', summaries.length),
                    assetSplit: t('portfolio.allocationByClass'),
                    bestPerformer: t('portfolio.bestPerformer'),
                    worstPerformer: t('portfolio.worstPerformer'),
                    // This series is cumulative net contributions (buys+gifts−sells),
                    // not 30-day performance — label and colour it as such.
                    sparkline: t('portfolio.netContributions30d'),
                  }}
                  allocation={allocationData}
                  bestPerformer={performers.best}
                  worstPerformer={performers.worst}
                  sparkline={sparkline}
                  neutralSparkline
                  formatCurrency={fmt}
                />
              </div>
              <div className="sm:col-span-2 lg:col-span-3 lg:row-span-2 grid grid-cols-1 grid-rows-3 gap-4">
                {cards.map((c) => (
                  <Card key={c.title} className="liquid-glass micro-lift border">
                    <CardHeader className="flex flex-row items-center justify-between pb-2">
                      <CardTitle className="text-sm font-medium text-muted-foreground">{c.title}</CardTitle>
                      <c.icon className={`h-4 w-4 ${c.cls}`} />
                    </CardHeader>
                    <CardContent>
                      <p className={`text-2xl font-bold ${c.cls}`}>{c.value}</p>
                      <p className="text-xs text-muted-foreground mt-1">{c.desc}</p>
                      {c.subline && (
                        <p className="text-xs text-muted-foreground mt-1 tabular-nums">
                          {c.subline}
                          {c.sublineWarning && (
                            <span title={c.sublineWarning} aria-label={c.sublineWarning}>
                              <AlertTriangle className="inline h-3 w-3 ml-1 text-warning align-[-1px]" />
                            </span>
                          )}
                        </p>
                      )}
                    </CardContent>
                  </Card>
                ))}
              </div>
            </div>
          )}

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {isVisible('allocation') && allocationData.length > 0 && (
              <Card className="glass-regular">
                <CardHeader><CardTitle>{t('portfolio.widget.allocation')}</CardTitle><CardDescription>{t('portfolio.allocationByClass')}</CardDescription></CardHeader>
                <CardContent>
                  <DonutChart
                    data={allocationData.map((d, i) => ({ ...d, color: COLORS[i % COLORS.length] }))}
                    height={240}
                    tooltipValueFormat={(v) => fmt(v)}
                  />
                  {(() => {
                    const totalAllocation = allocationData.reduce((s, x) => s + x.value, 0);
                    return (
                      <ChartLegend
                        className="mt-2 justify-center"
                        items={allocationData.map((d, i): ChartLegendItem => ({
                          label: `${d.name} ${totalAllocation > 0 ? ((d.value / totalAllocation) * 100).toFixed(0) : 0}%`,
                          color: COLORS[i % COLORS.length],
                        }))}
                      />
                    );
                  })()}
                </CardContent>
              </Card>
            )}

            {isVisible('performance') && (
              <Card className="glass-regular">
                <CardHeader><CardTitle>{t('portfolio.widget.performance')}</CardTitle><CardDescription>{t('portfolio.gainsIncomeAndCosts')}</CardDescription></CardHeader>
                <CardContent>
                  <div className="space-y-3">
                    {[
                      { label: t('portfolio.totalInvested'), value: totalInvested, cls: 'text-foreground' },
                       { label: t('portfolio.currentValue'), value: totalPortfolioValueInTarget, cls: 'text-foreground' },
                       { label: t('portfolio.realizedGains'), value: totalRealizedGainInTarget, cls: totalRealizedGainInTarget >= 0 ? 'text-accent' : 'text-destructive', showSign: true },
                       { label: t('portfolio.unrealizedGains'), value: totalUnrealizedGainInTarget, cls: totalUnrealizedGainInTarget >= 0 ? 'text-accent' : 'text-destructive', showSign: true },
                      ...(hasFxExposure ? [
                        { label: t('portfolio.assetGain'), value: totalAssetGainInTarget, cls: totalAssetGainInTarget >= 0 ? 'text-accent' : 'text-destructive', showSign: true },
                        { label: t('portfolio.fxEffect'), value: totalFxGainInTarget, cls: totalFxGainInTarget >= 0 ? 'text-accent' : 'text-destructive', showSign: true },
                      ] : []),
                      { label: t('portfolio.totalIncome'), value: totalIncome, cls: 'text-accent', showSign: true },
                       { label: t('portfolio.totalFees'), value: -totalFeesInTarget, cls: 'text-destructive' },
                        { label: t('portfolio.totalTaxes'), value: -totalTaxesInTarget, cls: 'text-destructive' },
                    ].map(({ label, value, cls, showSign }) => (
                      <div key={label} className="flex justify-between items-center py-2 border-b border-border/50 last:border-0">
                        <span className="text-sm text-muted-foreground">{label}</span>
                        <span className={cn("text-sm font-semibold tabular-nums", cls)}>
                          {showSign && value > 0 ? '+' : ''}{fmt(value)}
                        </span>
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>
            )}
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 lg:items-stretch">
            {isVisible('investments') && (
              <div className={cn(isVisible('news') && newsSymbols.length > 0 ? "lg:col-span-2" : "lg:col-span-3", "h-full min-h-0")}>
                <Card className="glass-regular h-full flex flex-col">
                  <CardHeader><CardTitle>{t('portfolio.widget.investments')}</CardTitle></CardHeader>
                  <CardContent className="min-h-0">
                    <div className="space-y-2">
                      {summaries.map((inv) => {
                        const unitBased = isUnitBased(inv.assetClass);
                        return (
                          <div key={inv.id} className="flex items-center gap-3 p-3 rounded-lg border border-border hover:bg-muted/50 transition-colors">
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-2">
                                {inv.symbol && <span className="font-mono font-bold text-sm">{inv.symbol}</span>}
                                <span className="font-medium text-sm truncate">{inv.name}</span>
                                <Badge variant="secondary" className="text-[10px] shrink-0">{ASSET_CLASS_LABELS[inv.assetClass]}</Badge>
                              </div>
                              <div className="flex items-center gap-3 mt-1 text-xs text-muted-foreground">
                                 <span>{t('portfolio.costLabel')} {fmt(convertToTarget(inv.totalBuyCost, inv.currency))}</span>
                                {unitBased && inv.totalUnits > 0 && (
                                  <span>{t('portfolio.units.label', { units: inv.totalUnits.toFixed(4), price: fmt(convertToTarget(inv.avgCostBasis, inv.currency)) })}</span>
                                )}
                                {inv.totalIncome > 0 && <span className="text-accent">{t('portfolio.income.label', { amount: fmt(convertToTarget(inv.totalIncome, inv.currency)) })}</span>}
                              </div>
                            </div>
                            <div className="text-right shrink-0">
                              <p className="font-bold text-sm tabular-nums">{fmt(convertToTarget(inv.currentValue, inv.currency))}</p>
                              <p className={cn("text-xs tabular-nums font-medium", inv.totalGain >= 0 ? "text-accent" : "text-destructive")}>
                                {inv.totalGain >= 0 ? '+' : ''}{fmt(convertToTarget(inv.totalGain, inv.currency))} ({inv.gainLossPercent >= 0 ? '+' : ''}{inv.gainLossPercent.toFixed(1)}%)
                              </p>
                            </div>
                            <div className="flex items-center gap-1 shrink-0">
                              <InvestmentDetailDialog investment={inv} />
                              <AddPortfolioTxnDialog investment={inv} />
                              <Button
                                variant="ghost" size="icon" className="icon-touch-target text-muted-foreground hover:text-destructive hover:bg-destructive/10"
                                aria-label={t('aria.deleteInvestment')}
                                onClick={async () => {
                                   const ok = await confirm({
                                    title: t('portfolio.deleteInvestment'),
                                    description: t('portfolio.deleteInvestmentDesc', { name: inv.name }),
                                    confirmLabel: t('common.delete'),
                                    variant: "destructive",
                                  });
                                  if (ok) deleteInvestment(inv.id);
                                }}
                              >
                                <Trash2 className="h-4 w-4" />
                              </Button>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </CardContent>
                </Card>
              </div>
            )}
            {isVisible('news') && newsSymbols.length > 0 && (
              <div className="lg:col-span-1 h-full min-h-0">
                <PortfolioNewsFeed symbols={newsSymbols} />
              </div>
            )}
          </div>
        </>
      )}

      <ConfirmDialog />
    </div>
  );
}
