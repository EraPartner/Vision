import { useLanguage } from "@/contexts/LanguageContext";
import { useAppSettings } from "@/contexts/AppSettingsContext";
import { numberFormatToLocale } from "@/utils/currency";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { TrendingUp, TrendingDown, PieChart as PieChartIcon, Trash2, RefreshCw, Loader2, ArrowUpRight, Clock } from "lucide-react";
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip } from "recharts";
import { usePortfolio } from "@/hooks/usePortfolio";
import { AddInvestmentDialog } from "@/components/portfolio/AddInvestmentDialog";
import { AddPortfolioTxnDialog } from "@/components/portfolio/AddPortfolioTxnDialog";
import { InvestmentDetailDialog } from "@/components/portfolio/InvestmentDetailDialog";
import { PortfolioNewsFeed } from "@/components/portfolio/PortfolioNewsFeed";
import { TotalValueCard, type SparklinePoint } from "@/components/portfolio/TotalValueCard";
import { ASSET_CLASS_LABELS, getAssetClassGroups } from "@/types/portfolio";
import { isUnitBased } from "@/utils/assetClass";
import { cn } from "@/lib/utils";
import { useConfirmDialog } from "@/hooks/useConfirmDialog";
import { useCallback, useMemo } from "react";
import { useCurrencyConverter } from "@/hooks/useCurrencyConverter";
import { WidgetVisibilityDialog } from "@/components/shared/WidgetVisibilityDialog";
import { useWidgetVisibility, type WidgetDefinition } from "@/hooks/useWidgetVisibility";
import { PageHeader } from "@/components/shared/PageHeader";
import { EmptyState } from "@/components/shared/EmptyState";
import { parseYmd } from "@/lib/timezone";

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
  const { t } = useLanguage();
  const { appSettings } = useAppSettings();
  const targetCurrency = appSettings.defaultCurrency || 'EUR';
  const locale = numberFormatToLocale(appSettings.numberFormat);
  const {
    summaries, totalGainLoss, transactions,
    deleteInvestment, refreshPrices, isRefreshingPrices
  } = usePortfolio();
  const { confirm, ConfirmDialog } = useConfirmDialog();
  const PORTFOLIO_WIDGETS = useMemo(() => getPortfolioWidgets(t), [t]);
  const { isVisible, setWidgetVisible, setAllVisible, resetToDefaults, widgets: widgetDefs } = useWidgetVisibility('portfolio', PORTFOLIO_WIDGETS);

  const { convertToTarget } = useCurrencyConverter(targetCurrency);

  const formatterCache = useMemo(() => new Map<string, Intl.NumberFormat>(), []);

  const fmt = useCallback((
    val: number,
    currency = targetCurrency,
    decimals = appSettings.showDecimalPlaces
  ) => {
    const key = `${locale}:${currency}:${decimals}`;
    let formatter = formatterCache.get(key);
    if (!formatter) {
      formatter = new Intl.NumberFormat(locale, {
        style: "currency",
        currency,
        minimumFractionDigits: decimals,
        maximumFractionDigits: decimals,
      });
      formatterCache.set(key, formatter);
    }
    return formatter.format(val);
  }, [targetCurrency, appSettings.showDecimalPlaces, formatterCache, locale]);

  const assetClassGroups = useMemo(() => getAssetClassGroups(t), [t]);

  const totalsAndDerived = useMemo(() => {
    const classToGroup = new Map<string, string>();
    for (const [group, classes] of Object.entries(assetClassGroups)) {
      for (const cls of classes) {
        classToGroup.set(cls, group);
      }
    }

    const allocationByGroup = new Map<string, number>();
    const newsSymbols: string[] = [];

    const totals = summaries.reduce((acc, summary) => {
      const currentValueInTarget = convertToTarget(summary.currentValue, summary.currency);
      const totalBuyCostInTarget = convertToTarget(summary.totalBuyCost, summary.currency);
      const totalIncomeInTarget = convertToTarget(summary.totalIncome, summary.currency);
      const totalGainInTarget = convertToTarget(summary.totalGain, summary.currency);
      const realizedGainInTarget = convertToTarget(summary.realizedGain, summary.currency);
      const unrealizedGainInTarget = convertToTarget(summary.unrealizedGain, summary.currency);
      const feesInTarget = convertToTarget(summary.totalFees, summary.currency);
      const taxesInTarget = convertToTarget(summary.totalTaxes, summary.currency);

      acc.totalInvested += totalBuyCostInTarget;
      acc.totalIncome += totalIncomeInTarget;
      acc.totalPortfolioValueInTarget += currentValueInTarget;
      acc.totalGainLossInTarget += totalGainInTarget;
      acc.totalRealizedGainInTarget += realizedGainInTarget;
      acc.totalUnrealizedGainInTarget += unrealizedGainInTarget;
      acc.totalFeesInTarget += feesInTarget;
      acc.totalTaxesInTarget += taxesInTarget;

      const group = classToGroup.get(summary.assetClass);
      if (group) {
        allocationByGroup.set(group, (allocationByGroup.get(group) || 0) + currentValueInTarget);
      }

      if (summary.symbol && newsSymbols.length < 10) {
        newsSymbols.push(summary.symbol);
      }

      return acc;
    }, {
      totalInvested: 0,
      totalIncome: 0,
      totalPortfolioValueInTarget: 0,
      totalGainLossInTarget: 0,
      totalRealizedGainInTarget: 0,
      totalUnrealizedGainInTarget: 0,
      totalFeesInTarget: 0,
      totalTaxesInTarget: 0,
    });

    const allocationData = Object.keys(assetClassGroups)
      .map((group) => ({
        name: group,
        value: allocationByGroup.get(group) || 0,
      }))
      .filter((entry) => entry.value > 0);

    return {
      ...totals,
      newsSymbols,
      allocationData,
    };
  }, [summaries, convertToTarget, assetClassGroups]);

  const {
    totalInvested,
    totalIncome,
    totalPortfolioValueInTarget,
    totalGainLossInTarget,
    totalRealizedGainInTarget,
    totalUnrealizedGainInTarget,
    totalFeesInTarget,
    totalTaxesInTarget,
    newsSymbols,
    allocationData,
  } = totalsAndDerived;

  const gainPercent = totalInvested > 0 ? (totalGainLoss / totalInvested) * 100 : 0;

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
      cls: totalGainLossInTarget >= 0 ? "text-accent" : "text-destructive"
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
            <WidgetVisibilityDialog
              widgets={widgetDefs}
              isVisible={isVisible}
              setWidgetVisible={setWidgetVisible}
              setAllVisible={setAllVisible}
              resetToDefaults={resetToDefaults}
            />
            <Button size="sm" variant="outline" className="gap-1.5" onClick={refreshPrices} disabled={isRefreshingPrices}>
              {isRefreshingPrices ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
              {t('portfolio.refreshPrices')}
            </Button>
            <AddInvestmentDialog />
          </>
        )}
      />

      {isEmpty ? (
        <Card>
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
          {isVisible('summaryCards') && (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-6 gap-4">
              <div className="sm:col-span-2 lg:col-span-3 lg:row-span-2">
                <TotalValueCard
                  formattedTotal={fmt(totalPortfolioValueInTarget)}
                  totalValue={totalPortfolioValueInTarget}
                  labels={{
                    title: t('portfolio.totalValue'),
                    investments: t('portfolio.investments', { count: String(summaries.length) }),
                    assetSplit: t('portfolio.allocationByClass'),
                    bestPerformer: t('portfolio.bestPerformer'),
                    worstPerformer: t('portfolio.worstPerformer'),
                    sparkline: t('portfolio.last30Days'),
                  }}
                  allocation={allocationData}
                  bestPerformer={performers.best}
                  worstPerformer={performers.worst}
                  sparkline={sparkline}
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
                    </CardContent>
                  </Card>
                ))}
              </div>
            </div>
          )}

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {isVisible('allocation') && allocationData.length > 0 && (
              <Card>
                <CardHeader><CardTitle>{t('portfolio.widget.allocation')}</CardTitle><CardDescription>{t('portfolio.allocationByClass')}</CardDescription></CardHeader>
                <CardContent>
                  <ResponsiveContainer width="100%" height={280}>
                    <PieChart>
                      <Pie data={allocationData} cx="50%" cy="50%" outerRadius={100} innerRadius={50} dataKey="value"
                        label={({ name, percent }) => `${name} ${(percent * 100).toFixed(0)}%`} labelLine={{ strokeWidth: 1 }} isAnimationActive={false}>
                        {allocationData.map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
                      </Pie>
                      <Tooltip contentStyle={{ backgroundColor: "hsl(var(--card))", border: "1px solid hsl(var(--border))", borderRadius: "var(--radius)", color: "hsl(var(--card-foreground))" }} formatter={(v: number) => fmt(v)} />
                    </PieChart>
                  </ResponsiveContainer>
                </CardContent>
              </Card>
            )}

            {isVisible('performance') && (
              <Card>
                <CardHeader><CardTitle>{t('portfolio.widget.performance')}</CardTitle><CardDescription>{t('portfolio.gainsIncomeAndCosts')}</CardDescription></CardHeader>
                <CardContent>
                  <div className="space-y-3">
                    {[
                      { label: t('portfolio.totalInvested'), value: totalInvested, cls: 'text-foreground' },
                       { label: t('portfolio.currentValue'), value: totalPortfolioValueInTarget, cls: 'text-foreground' },
                       { label: t('portfolio.realizedGains'), value: totalRealizedGainInTarget, cls: totalRealizedGainInTarget >= 0 ? 'text-accent' : 'text-destructive', showSign: true },
                       { label: t('portfolio.unrealizedGains'), value: totalUnrealizedGainInTarget, cls: totalUnrealizedGainInTarget >= 0 ? 'text-accent' : 'text-destructive', showSign: true },
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
                <Card className="h-full flex flex-col">
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
